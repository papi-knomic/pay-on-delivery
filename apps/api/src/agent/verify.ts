import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AgentDecision, CheckResult } from '@pod/shared';
import type { LanguageModel } from 'ai';
import { and, asc, count, desc, eq, lt, ne, sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import {
  agentDecisions,
  deliveries,
  evidence,
  payments,
  type AgentDecisionRow,
  type Delivery,
  type Evidence,
} from '../db/schema.js';
import { transitionDelivery } from '../deliveries/transition.js';
import type { Logger } from '../logger.js';
import { PayPalError, paypalRequestId, type PayPalClient } from '../paypal/index.js';
import {
  runDeliveryAgent,
  type AgentContext,
  type AgentLookups,
  type AgentRun,
} from './delivery-agent.js';
import { applyPolicy } from './policy.js';

const DEFAULT_RIDER_MESSAGE = 'Please upload a clear photo of the package at the delivery address.';

export interface VerifierDeps {
  db: Db;
  logger: Logger;
  uploadDir: string;
  paypal: Pick<PayPalClient, 'captureAuthorization' | 'voidAuthorization' | 'getAuthorization'>;
  /** Null when AI isn't configured: every delivery is escalated with an explanation. */
  model: LanguageModel | null;
  modelName?: string;
  /** Injectable for tests. */
  runAgent?: typeof runDeliveryAgent;
  /** After a capture commits, e.g. to queue tracking + rider payout. */
  onCaptured?: (deliveryId: string) => Promise<void>;
}

/**
 * The verify-delivery job: EVIDENCE_SUBMITTED → VERIFYING → agent → policy → persisted decision →
 * PayPal. Safe to retry: a decision already stored for this evidence is reused, never re-asked,
 * and PayPal calls reuse their idempotency keys.
 */
export function createVerifier(deps: VerifierDeps): (deliveryId: string) => Promise<void> {
  const { db, paypal } = deps;
  const runAgent = deps.runAgent ?? runDeliveryAgent;

  async function decide(delivery: Delivery, ev: Evidence, log: Logger): Promise<AgentDecisionRow> {
    const [requests] = await db
      .select({ n: count() })
      .from(agentDecisions)
      .where(
        and(
          eq(agentDecisions.deliveryId, delivery.id),
          eq(agentDecisions.finalAction, 'request_evidence'),
        ),
      );

    let run: AgentRun;
    if (!deps.model) {
      run = fallback(
        ev.checks,
        'The AI agent is not configured, so a person has to review this delivery.',
      );
    } else {
      try {
        run = await runAgent({
          model: deps.model,
          context: await contextFor(delivery, ev),
          lookups: lookupsFor(delivery, ev),
        });
      } catch (err) {
        log.error({ err }, 'agent failed; escalating');
        const reason = err instanceof Error ? err.message : String(err);
        run = fallback(
          ev.checks,
          `The AI agent could not reach a decision (${reason}), so a person has to review this delivery.`,
        );
      }
    }

    const policy = applyPolicy({
      decision: run.decision,
      delivery,
      checks: ev.checks,
      evidenceRequests: Number(requests?.n ?? 0),
    });
    const [inserted] = await db
      .insert(agentDecisions)
      .values({
        id: newId('dec'),
        deliveryId: delivery.id,
        evidenceId: ev.id,
        proposedAction: policy.proposedAction,
        finalAction: policy.finalAction,
        confidence: run.decision.confidence,
        captureAmountCents: policy.captureAmountCents,
        reasoning: run.decision.reasoning,
        evidenceSummary: run.decision.evidenceSummary,
        checks: ev.checks,
        policyNotes: policy.notes.join('\n') || null,
        riderMessage:
          policy.finalAction === 'request_evidence'
            ? (run.decision.riderMessage ?? DEFAULT_RIDER_MESSAGE)
            : null,
        toolCalls: run.toolCalls,
        model: deps.model ? (deps.modelName ?? null) : null,
      })
      // A concurrent run for the same evidence already decided: use that one.
      .onConflictDoNothing({ target: agentDecisions.evidenceId })
      .returning();
    const row = inserted ?? (await decisionFor(ev.id));
    if (!row) throw new Error(`No agent decision stored for evidence ${ev.id}`);
    log.info(
      {
        evidenceId: ev.id,
        proposed: row.proposedAction,
        final: row.finalAction,
        confidence: row.confidence,
        tools: run.toolCalls.map((c) => c.tool),
      },
      'agent decision',
    );
    return row;
  }

  async function execute(delivery: Delivery, row: AgentDecisionRow, log: Logger): Promise<void> {
    const id = delivery.id;
    switch (row.finalAction) {
      case 'request_evidence':
        await transitionDelivery(db, log, id, 'VERIFYING', 'NEEDS_MORE_EVIDENCE');
        return;
      case 'escalate':
        await transitionDelivery(db, log, id, 'VERIFYING', 'ESCALATED');
        return;
      case 'void': {
        if (!delivery.currentAuthorizationId) {
          return escalateAfter(row, delivery, 'No PayPal authorization to void', log);
        }
        await paypal.voidAuthorization({
          authorizationId: delivery.currentAuthorizationId,
          deliveryId: id,
        });
        await transitionDelivery(db, log, id, 'VERIFYING', 'VOIDED');
        return;
      }
      case 'capture':
      case 'partial_capture':
        return capture(delivery, row, log);
    }
  }

  async function capture(delivery: Delivery, row: AgentDecisionRow, log: Logger): Promise<void> {
    const authorizationId = delivery.currentAuthorizationId;
    const cents = row.captureAmountCents;
    if (!authorizationId || cents === null) {
      return escalateAfter(row, delivery, 'No PayPal authorization to capture', log);
    }
    const partial = row.finalAction === 'partial_capture';
    let result;
    try {
      result = await paypal.captureAuthorization({
        authorizationId,
        deliveryId: delivery.id,
        ...(partial && { amount: { cents } }),
      });
    } catch (err) {
      if (err instanceof PayPalError && err.status >= 400 && err.status < 500) {
        return escalateAfter(
          row,
          delivery,
          `PayPal refused the capture: ${err.issue ?? err.message}`,
          log,
        );
      }
      throw err; // transient: the job retries with the same PayPal-Request-Id
    }
    if (result.status === 'DECLINED' || result.status === 'FAILED') {
      return escalateAfter(row, delivery, `PayPal capture ${result.status}`, log);
    }

    await db.transaction(async (tx) => {
      await tx
        .insert(payments)
        .values({
          id: newId('pay'),
          deliveryId: delivery.id,
          kind: 'capture',
          paypalId: result.id,
          parentPaypalId: authorizationId,
          amountCents: cents,
          status: result.status,
          finalCapture: true,
          requestId: paypalRequestId(delivery.id, 'capture'),
        })
        .onConflictDoNothing({ target: payments.paypalId });
      await transitionDelivery(
        tx,
        log,
        delivery.id,
        'VERIFYING',
        partial ? 'PARTIALLY_CAPTURED' : 'CAPTURED',
        { capturedAmountCents: cents },
      );
    });
    log.info({ captureId: result.id, cents, status: result.status }, 'captured');
    await deps.onCaptured?.(delivery.id);
  }

  /** The decision allowed money to move but it couldn't; the audit row keeps both facts. */
  async function escalateAfter(
    row: AgentDecisionRow,
    delivery: Delivery,
    reason: string,
    log: Logger,
  ): Promise<void> {
    log.warn({ reason }, 'could not execute decision; escalating');
    await db
      .update(agentDecisions)
      .set({
        policyNotes: [row.policyNotes, `Not executed: ${reason}. Escalated.`]
          .filter(Boolean)
          .join('\n'),
      })
      .where(eq(agentDecisions.id, row.id));
    await transitionDelivery(db, log, delivery.id, 'VERIFYING', 'ESCALATED');
  }

  async function decisionFor(evidenceId: string): Promise<AgentDecisionRow | undefined> {
    const [row] = await db
      .select()
      .from(agentDecisions)
      .where(eq(agentDecisions.evidenceId, evidenceId))
      .limit(1);
    return row;
  }

  async function contextFor(delivery: Delivery, ev: Evidence): Promise<AgentContext> {
    return {
      delivery,
      evidence: {
        attempt: ev.attempt,
        photo: await readFile(join(deps.uploadDir, ev.photoPath)),
        uploadedAt: ev.createdAt,
        photoTakenAt: ev.photoTakenAt,
        riderNote: ev.riderNote,
        checks: ev.checks,
      },
    };
  }

  function lookupsFor(delivery: Delivery, ev: Evidence): AgentLookups {
    return {
      async previousAttempts() {
        const rows = await db
          .select({ evidence, decision: agentDecisions })
          .from(evidence)
          .leftJoin(agentDecisions, eq(agentDecisions.evidenceId, evidence.id))
          .where(and(eq(evidence.deliveryId, delivery.id), lt(evidence.attempt, ev.attempt)))
          .orderBy(asc(evidence.attempt));
        return rows.map((r) => ({
          attempt: r.evidence.attempt,
          uploadedAt: r.evidence.createdAt.toISOString(),
          riderNote: r.evidence.riderNote,
          failedChecks: r.evidence.checks.filter((c) => c.status === 'fail').map((c) => c.detail),
          decision: r.decision && {
            action: r.decision.finalAction,
            reasoning: r.decision.reasoning,
            riderMessage: r.decision.riderMessage,
          },
        }));
      },

      async riderHistory() {
        if (!delivery.riderId) return { note: 'No rider is assigned to this delivery' };
        const byStatus = await db
          .select({ status: deliveries.status, n: count() })
          .from(deliveries)
          .where(and(eq(deliveries.riderId, delivery.riderId), ne(deliveries.id, delivery.id)))
          .groupBy(deliveries.status);
        const [flagged] = await db
          .select({ n: count() })
          .from(evidence)
          .innerJoin(deliveries, eq(deliveries.id, evidence.deliveryId))
          .where(
            and(
              eq(deliveries.riderId, delivery.riderId),
              ne(deliveries.id, delivery.id),
              sql`${evidence.checks} @> '[{"status":"fail"}]'::jsonb`,
            ),
          );
        return {
          otherDeliveriesByStatus: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
          uploadsWithFailedChecks: Number(flagged?.n ?? 0),
        };
      },

      async paypalAuthorization() {
        if (!delivery.currentAuthorizationId) return { note: 'No PayPal authorization on file' };
        try {
          const auth = await paypal.getAuthorization(delivery.currentAuthorizationId, delivery.id);
          return {
            status: auth.status,
            amount: auth.amount && `${auth.amount.value} ${auth.amount.currency_code}`,
            expires: auth.expiration_time,
          };
        } catch {
          return { error: 'PayPal lookup failed' };
        }
      },
    };
  }

  return async function verifyDelivery(deliveryId: string): Promise<void> {
    const log = deps.logger.child({ component: 'verifier', deliveryId });
    let [delivery] = await db
      .select()
      .from(deliveries)
      .where(eq(deliveries.id, deliveryId))
      .limit(1);
    if (!delivery) {
      log.warn('delivery not found');
      return;
    }
    if (delivery.status === 'EVIDENCE_SUBMITTED') {
      delivery = await transitionDelivery(db, log, deliveryId, 'EVIDENCE_SUBMITTED', 'VERIFYING');
    } else if (delivery.status !== 'VERIFYING') {
      log.info({ status: delivery.status }, 'nothing to verify');
      return;
    }

    const [ev] = await db
      .select()
      .from(evidence)
      .where(eq(evidence.deliveryId, deliveryId))
      .orderBy(desc(evidence.attempt))
      .limit(1);
    if (!ev) throw new Error(`Delivery ${deliveryId} is VERIFYING with no evidence`);

    const row = (await decisionFor(ev.id)) ?? (await decide(delivery, ev, log));
    await execute(delivery, row, log);
  };
}

/** Code-side escalation when the model can't be used; still goes through policy and the audit trail. */
function fallback(checks: readonly CheckResult[], reasoning: string): AgentRun {
  const failed = checks.filter((c) => c.status === 'fail').map((c) => c.name);
  const decision: AgentDecision = {
    action: 'escalate',
    confidence: 0,
    reasoning,
    evidenceSummary: failed.length
      ? `Deterministic checks failed: ${failed.join(', ')}.`
      : 'Deterministic checks found no failures.',
  };
  return { decision, toolCalls: [] };
}

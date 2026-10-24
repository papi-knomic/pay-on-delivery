import {
  VERIFICATION_THRESHOLDS,
  canTransition,
  centsToDecimal,
  decimalToCents,
  type AgentAction,
  type AgentDecision,
  type CheckResult,
  type DeliveryStatus,
  type VerificationThresholds,
} from '@pod/shared';

/**
 * The agent decides; this enforces. Runs on every model decision before any PayPal call, and
 * only ever narrows the outcome: anything doubtful becomes `escalate`.
 */

const TARGET_STATUS: Readonly<Record<AgentAction, DeliveryStatus>> = {
  capture: 'CAPTURED',
  partial_capture: 'PARTIALLY_CAPTURED',
  request_evidence: 'NEEDS_MORE_EVIDENCE',
  void: 'VOIDED',
  escalate: 'ESCALATED',
};

const MONEY_MOVING: readonly AgentAction[] = ['capture', 'partial_capture', 'void'];

export interface PolicyInput {
  decision: AgentDecision;
  delivery: { status: DeliveryStatus; amountCents: number; riderFeeCents: number };
  checks: readonly CheckResult[];
  /** Evidence requests already made on this delivery. */
  evidenceRequests: number;
  thresholds?: VerificationThresholds;
}

export interface PolicyResult {
  proposedAction: AgentAction;
  finalAction: AgentAction;
  targetStatus: DeliveryStatus;
  /** Set for capture and partial_capture only. */
  captureAmountCents: number | null;
  overridden: boolean;
  notes: string[];
}

export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PolicyError';
  }
}

export function applyPolicy(input: PolicyInput): PolicyResult {
  const { decision, delivery, checks } = input;
  const t = input.thresholds ?? VERIFICATION_THRESHOLDS;
  if (delivery.status !== 'VERIFYING') {
    throw new PolicyError(
      `Agent decisions only apply in VERIFYING; delivery is ${delivery.status}`,
    );
  }

  const notes: string[] = [];
  const result = (finalAction: AgentAction, captureAmountCents: number | null): PolicyResult => ({
    proposedAction: decision.action,
    finalAction,
    targetStatus: TARGET_STATUS[finalAction],
    captureAmountCents,
    overridden: finalAction !== decision.action,
    notes,
  });
  const escalate = (reason: string) => {
    notes.push(reason);
    return result('escalate', null);
  };

  const action = decision.action;
  if (!canTransition(delivery.status, TARGET_STATUS[action])) {
    return escalate(`${action} is not allowed from ${delivery.status}; a human has to confirm it`);
  }

  if (MONEY_MOVING.includes(action)) {
    const failed = checks.filter((c) => c.status === 'fail');
    if (failed.length > 0 && action !== 'void') {
      return escalate(`Deterministic checks failed: ${failed.map((c) => c.name).join(', ')}`);
    }
    if (decision.confidence < t.minConfidence) {
      return escalate(`Confidence ${decision.confidence} is below ${t.minConfidence}`);
    }
  }

  switch (action) {
    case 'capture':
      if (decision.captureAmount !== undefined) {
        notes.push('Model amount ignored: a full capture is always the authorized amount');
      }
      return result('capture', delivery.amountCents);

    case 'partial_capture': {
      if (decision.captureAmount === undefined) {
        return escalate('Partial capture without an amount');
      }
      let cents: number;
      try {
        cents = decimalToCents(decision.captureAmount);
      } catch {
        return escalate(`Partial capture amount "${decision.captureAmount}" is not a valid amount`);
      }
      if (cents <= 0) {
        return escalate('Partial capture amount must be more than zero');
      }
      if (cents > delivery.amountCents) {
        return escalate(
          `Partial capture ${centsToDecimal(cents)} exceeds the authorized ${centsToDecimal(delivery.amountCents)}`,
        );
      }
      if (cents < delivery.riderFeeCents) {
        return escalate(
          `Partial capture ${centsToDecimal(cents)} would not cover the rider fee ${centsToDecimal(delivery.riderFeeCents)}`,
        );
      }
      if (cents === delivery.amountCents) {
        notes.push('Partial capture of the full amount treated as a full capture');
        return result('capture', cents);
      }
      return result('partial_capture', cents);
    }

    case 'request_evidence':
      if (input.evidenceRequests >= t.maxEvidenceRequests) {
        return escalate(`Already asked for more evidence ${input.evidenceRequests} times`);
      }
      return result('request_evidence', null);

    case 'void':
    case 'escalate':
      return result(action, null);
  }
}

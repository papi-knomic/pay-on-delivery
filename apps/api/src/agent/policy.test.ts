import type { AgentDecision, CheckResult } from '@pod/shared';
import { describe, expect, it } from 'vitest';
import { PolicyError, applyPolicy, type PolicyInput } from './policy.js';

const pass = (name: CheckResult['name']): CheckResult => ({ name, status: 'pass', detail: '' });
const fail = (name: CheckResult['name']): CheckResult => ({ name, status: 'fail', detail: '' });

const decision = (overrides: Partial<AgentDecision> = {}): AgentDecision => ({
  action: 'capture',
  confidence: 0.95,
  reasoning: 'Package visible at the door',
  evidenceSummary: 'Photo shows a parcel on a doorstep',
  ...overrides,
});

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    decision: decision(),
    delivery: { status: 'VERIFYING', amountCents: 1000, riderFeeCents: 200 },
    checks: [pass('gps_distance'), pass('photo_reuse'), pass('photo_freshness')],
    evidenceRequests: 0,
    ...overrides,
  };
}

describe('applyPolicy', () => {
  it('allows a confident capture with passing checks, for the full authorized amount', () => {
    const r = applyPolicy(input());
    expect(r).toMatchObject({
      proposedAction: 'capture',
      finalAction: 'capture',
      targetStatus: 'CAPTURED',
      captureAmountCents: 1000,
      overridden: false,
    });
  });

  it('ignores a model-supplied amount on a full capture', () => {
    const r = applyPolicy(input({ decision: decision({ captureAmount: '1.00' }) }));
    expect(r.captureAmountCents).toBe(1000);
    expect(r.notes).toHaveLength(1);
  });

  it('refuses to run outside VERIFYING', () => {
    expect(() =>
      applyPolicy(
        input({ delivery: { status: 'IN_TRANSIT', amountCents: 1000, riderFeeCents: 0 } }),
      ),
    ).toThrow(PolicyError);
  });

  it.each(['capture', 'partial_capture'] as const)(
    'escalates %s when a deterministic check failed',
    (action) => {
      const r = applyPolicy(
        input({
          decision: decision({ action, captureAmount: '5.00' }),
          checks: [fail('photo_reuse'), pass('gps_distance')],
        }),
      );
      expect(r).toMatchObject({
        finalAction: 'escalate',
        targetStatus: 'ESCALATED',
        overridden: true,
      });
      expect(r.notes[0]).toContain('photo_reuse');
      expect(r.captureAmountCents).toBeNull();
    },
  );

  it('escalates a low-confidence capture', () => {
    const r = applyPolicy(input({ decision: decision({ confidence: 0.6 }) }));
    expect(r.finalAction).toBe('escalate');
  });

  it('respects custom thresholds', () => {
    const r = applyPolicy(
      input({
        decision: decision({ confidence: 0.6 }),
        thresholds: {
          maxGpsDistanceM: 150,
          maxGpsAccuracyAllowanceM: 50,
          maxPhotoHashDistance: 6,
          maxPhotoAgeMs: 1,
          maxPhotoClockSkewMs: 1,
          minConfidence: 0.5,
          maxEvidenceRequests: 2,
        },
      }),
    );
    expect(r.finalAction).toBe('capture');
  });

  it('does not apply the confidence floor to non-money actions', () => {
    const r = applyPolicy(
      input({ decision: decision({ action: 'request_evidence', confidence: 0.3 }) }),
    );
    expect(r.finalAction).toBe('request_evidence');
    expect(r.targetStatus).toBe('NEEDS_MORE_EVIDENCE');
  });

  it('escalates a void, because VERIFYING → VOIDED needs a human', () => {
    const r = applyPolicy(input({ decision: decision({ action: 'void' }) }));
    expect(r).toMatchObject({ proposedAction: 'void', finalAction: 'escalate', overridden: true });
  });

  it('passes an escalate through untouched', () => {
    const r = applyPolicy(
      input({ decision: decision({ action: 'escalate', confidence: 0.1 }), checks: [fail('otp')] }),
    );
    expect(r).toMatchObject({ finalAction: 'escalate', overridden: false, notes: [] });
  });

  describe('partial capture', () => {
    const partial = (captureAmount: string | undefined) =>
      applyPolicy(input({ decision: decision({ action: 'partial_capture', captureAmount }) }));

    it('allows a valid partial amount', () => {
      expect(partial('6.00')).toMatchObject({
        finalAction: 'partial_capture',
        targetStatus: 'PARTIALLY_CAPTURED',
        captureAmountCents: 600,
      });
    });

    it.each([
      ['missing', undefined],
      ['not a number', 'six dollars'],
      ['a float with too many decimals', '6.005'],
      ['zero', '0.00'],
      ['more than authorized', '10.01'],
      ['less than the rider fee', '1.99'],
    ])('escalates when the amount is %s', (_label, amount) => {
      const r = partial(amount);
      expect(r.finalAction).toBe('escalate');
      expect(r.captureAmountCents).toBeNull();
    });

    it('treats a partial capture of the full amount as a full capture', () => {
      expect(partial('10.00')).toMatchObject({
        finalAction: 'capture',
        targetStatus: 'CAPTURED',
        captureAmountCents: 1000,
        overridden: true,
      });
    });
  });

  it('escalates once the evidence-request limit is reached', () => {
    const r = applyPolicy(
      input({ decision: decision({ action: 'request_evidence' }), evidenceRequests: 2 }),
    );
    expect(r.finalAction).toBe('escalate');
  });
});

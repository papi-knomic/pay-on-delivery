import { describe, expect, it } from 'vitest';
import {
  DELIVERY_STATES,
  IllegalTransitionError,
  TERMINAL_STATES,
  TRANSITIONS,
  canTransition,
  isDeliveryStatus,
  isTerminal,
  transition,
  type DeliveryStatus,
} from './delivery-state.js';

// Written out by hand from the CLAUDE.md diagram so the test fails if TRANSITIONS drifts from the spec.
const LEGAL: ReadonlyArray<[DeliveryStatus, DeliveryStatus]> = [
  ['CREATED', 'AUTHORIZED'],
  ['AUTHORIZED', 'IN_TRANSIT'],
  ['IN_TRANSIT', 'EVIDENCE_SUBMITTED'],
  ['EVIDENCE_SUBMITTED', 'VERIFYING'],
  ['VERIFYING', 'CAPTURED'],
  ['VERIFYING', 'PARTIALLY_CAPTURED'],
  ['VERIFYING', 'NEEDS_MORE_EVIDENCE'],
  ['VERIFYING', 'ESCALATED'],
  ['NEEDS_MORE_EVIDENCE', 'EVIDENCE_SUBMITTED'],
  ['CAPTURED', 'PAYOUT_PENDING'],
  ['PARTIALLY_CAPTURED', 'PAYOUT_PENDING'],
  ['PAYOUT_PENDING', 'RIDER_PAID'],
  ['RIDER_PAID', 'SETTLED'],
  ['ESCALATED', 'CAPTURED'],
  ['ESCALATED', 'VOIDED'],
  ['AUTHORIZED', 'VOIDED'],
  ['IN_TRANSIT', 'VOIDED'],
  ['CAPTURED', 'REFUNDED'],
  ['PARTIALLY_CAPTURED', 'REFUNDED'],
  ['PAYOUT_PENDING', 'REFUNDED'],
  ['RIDER_PAID', 'REFUNDED'],
  ['CREATED', 'EXPIRED'],
  ['AUTHORIZED', 'EXPIRED'],
  ['IN_TRANSIT', 'EXPIRED'],
  ['EVIDENCE_SUBMITTED', 'EXPIRED'],
  ['VERIFYING', 'EXPIRED'],
  ['NEEDS_MORE_EVIDENCE', 'EXPIRED'],
  ['ESCALATED', 'EXPIRED'],
];

const ILLEGAL: ReadonlyArray<[DeliveryStatus, DeliveryStatus, string]> = [
  ['CREATED', 'CAPTURED', 'cannot capture before authorizing'],
  ['AUTHORIZED', 'CAPTURED', 'cannot capture without evidence + verification'],
  ['IN_TRANSIT', 'VERIFYING', 'must submit evidence first'],
  ['VERIFYING', 'RIDER_PAID', 'rider is paid only after capture + payout'],
  ['CAPTURED', 'RIDER_PAID', 'RIDER_PAID only via PAYOUT_PENDING (payout webhook)'],
  ['PARTIALLY_CAPTURED', 'RIDER_PAID', 'RIDER_PAID only via PAYOUT_PENDING'],
  ['CAPTURED', 'VOIDED', 'captured payments are refunded, never voided'],
  ['CAPTURED', 'EXPIRED', 'authorization expiry is moot after capture'],
  ['PAYOUT_PENDING', 'EXPIRED', 'authorization expiry is moot after capture'],
  ['VERIFYING', 'VOIDED', 'void from verification must go through escalation'],
  ['NEEDS_MORE_EVIDENCE', 'CAPTURED', 'must resubmit and re-verify'],
  ['AUTHORIZED', 'REFUNDED', 'nothing captured to refund'],
  ['ESCALATED', 'REFUNDED', 'nothing captured to refund'],
  ['SETTLED', 'REFUNDED', 'SETTLED is terminal'],
  ['VOIDED', 'AUTHORIZED', 'VOIDED is terminal'],
  ['EXPIRED', 'AUTHORIZED', 'EXPIRED is terminal'],
  ['REFUNDED', 'CAPTURED', 'REFUNDED is terminal'],
  ['CAPTURED', 'CAPTURED', 'self-transitions are not allowed'],
];

describe('delivery state machine', () => {
  it.each(LEGAL)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
    expect(transition(from, to)).toBe(to);
  });

  it.each(ILLEGAL)('rejects %s → %s (%s)', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
    expect(() => transition(from, to)).toThrow(IllegalTransitionError);
  });

  it('TRANSITIONS contains exactly the legal edges from the spec', () => {
    const actual = Object.entries(TRANSITIONS)
      .flatMap(([from, tos]) => tos.map((to) => `${from}→${to}`))
      .sort();
    const expected = LEGAL.map(([from, to]) => `${from}→${to}`).sort();
    expect(actual).toEqual(expected);
  });

  it('terminal states have no outgoing transitions', () => {
    expect([...TERMINAL_STATES].sort()).toEqual(['EXPIRED', 'REFUNDED', 'SETTLED', 'VOIDED']);
    for (const state of TERMINAL_STATES) {
      expect(isTerminal(state)).toBe(true);
      expect(TRANSITIONS[state]).toEqual([]);
    }
  });

  it('every non-terminal state has a way forward', () => {
    for (const state of DELIVERY_STATES.filter((s) => !isTerminal(s))) {
      expect(TRANSITIONS[state].length).toBeGreaterThan(0);
    }
  });

  it('every state is reachable from CREATED', () => {
    const seen = new Set<DeliveryStatus>(['CREATED']);
    const queue: DeliveryStatus[] = ['CREATED'];
    while (queue.length > 0) {
      const next = queue.shift()!;
      for (const to of TRANSITIONS[next]) {
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
      }
    }
    expect([...seen].sort()).toEqual([...DELIVERY_STATES].sort());
  });

  it('error carries from/to for logging', () => {
    try {
      transition('SETTLED', 'CAPTURED');
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(IllegalTransitionError);
      expect((err as IllegalTransitionError).from).toBe('SETTLED');
      expect((err as IllegalTransitionError).to).toBe('CAPTURED');
      expect((err as Error).message).toBe('Illegal delivery transition: SETTLED → CAPTURED');
    }
  });

  it('isDeliveryStatus narrows unknown input', () => {
    expect(isDeliveryStatus('CAPTURED')).toBe(true);
    expect(isDeliveryStatus('captured')).toBe(false);
    expect(isDeliveryStatus(42)).toBe(false);
  });
});

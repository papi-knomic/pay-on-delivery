export const DELIVERY_STATES = [
  'CREATED',
  'AUTHORIZED',
  'IN_TRANSIT',
  'EVIDENCE_SUBMITTED',
  'VERIFYING',
  'NEEDS_MORE_EVIDENCE',
  'CAPTURED',
  'PARTIALLY_CAPTURED',
  'PAYOUT_PENDING',
  'RIDER_PAID',
  'SETTLED',
  'ESCALATED',
  'VOIDED',
  'EXPIRED',
  'REFUNDED',
] as const;

export type DeliveryStatus = (typeof DELIVERY_STATES)[number];

export const TERMINAL_STATES: readonly DeliveryStatus[] = [
  'SETTLED',
  'VOIDED',
  'EXPIRED',
  'REFUNDED',
];

/**
 * Legal transitions. Mirrors the diagram in CLAUDE.md; change both together.
 * EXPIRED only applies before capture: once funds are captured the authorization window is moot.
 */
export const TRANSITIONS: Readonly<Record<DeliveryStatus, readonly DeliveryStatus[]>> = {
  CREATED: ['AUTHORIZED', 'EXPIRED'],
  AUTHORIZED: ['IN_TRANSIT', 'VOIDED', 'EXPIRED'],
  IN_TRANSIT: ['EVIDENCE_SUBMITTED', 'VOIDED', 'EXPIRED'],
  EVIDENCE_SUBMITTED: ['VERIFYING', 'EXPIRED'],
  VERIFYING: ['CAPTURED', 'PARTIALLY_CAPTURED', 'NEEDS_MORE_EVIDENCE', 'ESCALATED', 'EXPIRED'],
  NEEDS_MORE_EVIDENCE: ['EVIDENCE_SUBMITTED', 'EXPIRED'],
  ESCALATED: ['CAPTURED', 'VOIDED', 'EXPIRED'],
  CAPTURED: ['PAYOUT_PENDING', 'REFUNDED'],
  PARTIALLY_CAPTURED: ['PAYOUT_PENDING', 'REFUNDED'],
  PAYOUT_PENDING: ['RIDER_PAID', 'REFUNDED'],
  RIDER_PAID: ['SETTLED', 'REFUNDED'],
  SETTLED: [],
  VOIDED: [],
  EXPIRED: [],
  REFUNDED: [],
};

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: DeliveryStatus,
    readonly to: DeliveryStatus,
  ) {
    super(`Illegal delivery transition: ${from} → ${to}`);
    this.name = 'IllegalTransitionError';
  }
}

export function isDeliveryStatus(value: unknown): value is DeliveryStatus {
  return typeof value === 'string' && (DELIVERY_STATES as readonly string[]).includes(value);
}

export function isTerminal(status: DeliveryStatus): boolean {
  return TERMINAL_STATES.includes(status);
}

export function allowedTransitions(from: DeliveryStatus): readonly DeliveryStatus[] {
  return TRANSITIONS[from];
}

export function canTransition(from: DeliveryStatus, to: DeliveryStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Guard every status change through this. Returns `to` so callers can write `status = transition(status, next)`. */
export function transition(from: DeliveryStatus, to: DeliveryStatus): DeliveryStatus {
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to);
  }
  return to;
}

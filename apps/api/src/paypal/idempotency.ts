export type PayPalAction =
  'create-order' | 'authorize' | 'capture' | 'void' | 'reauthorize' | 'track' | 'refund' | 'payout';

/**
 * PayPal-Request-Id for a money-moving call. Deterministic so retries reuse the same key:
 * `dlv_123:capture`, or `dlv_123:reauthorize:2` for actions that legitimately repeat.
 */
export function paypalRequestId(
  deliveryId: string,
  action: PayPalAction,
  attempt?: number,
): string {
  if (!deliveryId) throw new Error('deliveryId is required for an idempotency key');
  return attempt === undefined ? `${deliveryId}:${action}` : `${deliveryId}:${action}:${attempt}`;
}

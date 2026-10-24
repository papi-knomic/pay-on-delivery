import { Resource } from '@kn0mic/reshaper';
import { centsToDecimal, PAYPAL_CURRENCY, type DeliveryDto } from '@pod/shared';
import type { Delivery } from '../db/schema.js';

export interface DeliveryResourceOptions {
  isOps?: boolean;
}

const iso = (d: Date) => d.toISOString();

export class DeliveryResource extends Resource {
  static override transform(
    delivery: Delivery,
    options: DeliveryResourceOptions = {},
  ): DeliveryDto {
    const isOps = options.isOps ?? false;
    return Resource.clean({
      id: delivery.id,
      status: delivery.status,
      merchantId: delivery.merchantId,
      buyerId: delivery.buyerId,
      riderId: delivery.riderId,
      amount: centsToDecimal(delivery.amountCents),
      riderFee: centsToDecimal(delivery.riderFeeCents),
      capturedAmount: Resource.whenNotNull(delivery.capturedAmountCents, centsToDecimal),
      currency: PAYPAL_CURRENCY,
      deliveryAddress: delivery.deliveryAddress,
      authorizedAt: Resource.whenNotNull(delivery.authorizedAt, iso),
      createdAt: iso(delivery.createdAt),
      updatedAt: iso(delivery.updatedAt),
      paypalOrderId: Resource.when(isOps, () => delivery.paypalOrderId ?? undefined),
      currentAuthorizationId: Resource.when(
        isOps,
        () => delivery.currentAuthorizationId ?? undefined,
      ),
      honorPeriodFlaggedAt: Resource.when(isOps, () =>
        delivery.honorPeriodFlaggedAt ? iso(delivery.honorPeriodFlaggedAt) : undefined,
      ),
    }) as DeliveryDto;
  }
}

import { Resource } from '@kn0mic/reshaper';
import { decimalToCents } from '@pod/shared';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { CheckoutService } from '../checkout/service.js';
import { DeliveryResource } from '../resources/DeliveryResource.js';

/** Sandbox demo ceiling; keeps typos like "1800" for "18.00" out of PayPal. */
const MAX_ORDER_CENTS = 1_000_00;

const money = z
  .string()
  .regex(/^\d+(\.\d{1,2})?$/, 'USD amount like "18.00"')
  .transform(decimalToCents);

export const checkoutBodySchema = z
  .object({
    merchantId: z.string().min(1),
    buyer: z.object({
      name: z.string().trim().min(1).max(100),
      email: z.email().optional(),
      phone: z.string().trim().max(30).optional(),
    }),
    items: z
      .array(
        z.object({
          name: z.string().trim().min(1).max(127),
          quantity: z.number().int().min(1).max(99),
          unitPrice: money,
        }),
      )
      .min(1)
      .max(20),
    deliveryFee: money,
    deliveryAddress: z.string().trim().min(5).max(300),
    deliveryLat: z.number().min(-90).max(90).optional(),
    deliveryLng: z.number().min(-180).max(180).optional(),
  })
  .refine((b) => (b.deliveryLat === undefined) === (b.deliveryLng === undefined), {
    message: 'deliveryLat and deliveryLng must be sent together',
  })
  .refine(
    (b) =>
      b.items.reduce((s, i) => s + i.quantity * i.unitPrice, 0) + b.deliveryFee <= MAX_ORDER_CENTS,
    { message: 'order total is over the $1000 demo limit' },
  )
  .refine((b) => b.items.every((i) => i.unitPrice > 0), { message: 'items must cost something' });

const idParams = z.object({ id: z.string().min(1) });
const shipBodySchema = z.object({
  riderId: z.string().min(1),
  carrier: z.string().trim().min(1).max(64).optional(),
  trackingNumber: z.string().trim().min(1).max(64).optional(),
});

/** Registered under /api. Ops/merchant auth comes later, like the rest of the API. */
export const checkoutRoutes: FastifyPluginAsync<{ checkout: CheckoutService }> = async (
  app,
  { checkout },
) => {
  app.post('/checkout', async (req, reply) => {
    const parsed = checkoutBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(Resource.wrap({ error: 'invalid checkout', issues: parsed.error.issues }));
    }
    const b = parsed.data;
    const result = await checkout.start({
      merchantId: b.merchantId,
      buyer: b.buyer,
      items: b.items.map((i) => ({ name: i.name, quantity: i.quantity, unitCents: i.unitPrice })),
      deliveryFeeCents: b.deliveryFee,
      deliveryAddress: b.deliveryAddress,
      deliveryLat: b.deliveryLat,
      deliveryLng: b.deliveryLng,
    });
    if (!result.ok) {
      return reply.code(404).send(Resource.wrap({ error: 'merchant not found' }));
    }
    return reply.code(201).send(
      Resource.wrap({
        delivery: DeliveryResource.transform(result.delivery),
        approveUrl: result.approveUrl,
        // Shown to the buyer once, to read out to the rider at handover.
        otp: result.otp,
      }),
    );
  });

  app.post('/checkout/:id/authorize', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const result = await checkout.authorize(id);
    if (result.ok) {
      return DeliveryResource.wrap(DeliveryResource.transform(result.delivery));
    }
    switch (result.reason) {
      case 'not_found':
      case 'no_order':
        return reply.code(404).send(Resource.wrap({ error: 'delivery not found' }));
      case 'not_approved':
        return reply.code(409).send(
          Resource.wrap({
            error: 'buyer has not approved the payment',
            orderStatus: result.orderStatus,
          }),
        );
      case 'wrong_status':
        return reply
          .code(409)
          .send(Resource.wrap({ error: 'delivery cannot be authorized', status: result.status }));
    }
  });

  app.post('/deliveries/:id/ship', async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const parsed = shipBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(Resource.wrap({ error: 'invalid shipment', issues: parsed.error.issues }));
    }
    const result = await checkout.ship(id, parsed.data);
    if (result.ok) {
      return DeliveryResource.wrap(DeliveryResource.transform(result.delivery));
    }
    switch (result.reason) {
      case 'not_found':
        return reply.code(404).send(Resource.wrap({ error: 'delivery not found' }));
      case 'rider_not_found':
        return reply.code(404).send(Resource.wrap({ error: 'rider not found' }));
      case 'wrong_status':
        return reply.code(409).send(
          Resource.wrap({
            error: 'only authorized deliveries can be shipped',
            status: result.status,
          }),
        );
      case 'conflict':
        return reply.code(409).send(Resource.wrap({ error: 'delivery changed; try again' }));
    }
  });
};

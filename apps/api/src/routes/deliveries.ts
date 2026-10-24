import { count, desc, eq } from 'drizzle-orm';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db/client.js';
import { deliveries } from '../db/schema.js';
import { DeliveryResource } from '../resources/DeliveryResource.js';
import { pageQuerySchema, paginate } from '../resources/paginate.js';

const idParamsSchema = z.object({ id: z.string().min(1) });

/** Registered under /api. Ops auth comes later; until then nobody gets ops-only fields. */
export const deliveryRoutes: FastifyPluginAsync<{ db: Db }> = async (app, { db }) => {
  app.get('/deliveries', async (req, reply) => {
    const params = pageQuerySchema.safeParse(req.query);
    if (!params.success) {
      return reply
        .code(400)
        .send(DeliveryResource.wrap({ error: 'invalid pagination', issues: params.error.issues }));
    }
    return paginate(
      DeliveryResource,
      params.data,
      {
        rows: (limit, offset) =>
          db
            .select()
            .from(deliveries)
            .orderBy(desc(deliveries.createdAt))
            .limit(limit)
            .offset(offset),
        count: async () => (await db.select({ total: count() }).from(deliveries))[0]?.total ?? 0,
      },
      { isOps: false },
    );
  });

  app.get('/deliveries/:id', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const [row] = await db.select().from(deliveries).where(eq(deliveries.id, id)).limit(1);
    if (!row) {
      return reply.code(404).send(DeliveryResource.wrap({ error: 'not found' }));
    }
    return DeliveryResource.wrap(DeliveryResource.transform(row, { isOps: false }));
  });
};

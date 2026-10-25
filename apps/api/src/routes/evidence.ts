import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import fastifyMultipart from '@fastify/multipart';
import { Resource } from '@kn0mic/reshaper';
import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import type { EvidenceService } from '../evidence/service.js';
import { EvidenceResource } from '../resources/EvidenceResource.js';

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const idParamsSchema = z.object({ id: z.string().min(1) });

const blankToUndefined = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);
const optionalNumber = (schema: z.ZodNumber) =>
  z.preprocess(blankToUndefined, z.coerce.number().pipe(schema).optional());

/** Multipart text fields arrive as strings. */
export const evidenceFieldsSchema = z
  .object({
    lat: optionalNumber(z.number().min(-90).max(90)),
    lng: optionalNumber(z.number().min(-180).max(180)),
    accuracyM: optionalNumber(z.number().min(0)),
    otp: z.preprocess(blankToUndefined, z.string().trim().max(12).optional()),
    utcOffsetMinutes: optionalNumber(z.number().int().min(-840).max(840)),
  })
  .refine((f) => (f.lat === undefined) === (f.lng === undefined), {
    message: 'lat and lng must be sent together',
  });

/** Registered under /api. Rider upload + the stored photo for the dashboard. */
export const evidenceRoutes: FastifyPluginAsync<{ evidence: EvidenceService }> = async (
  app,
  { evidence },
) => {
  await app.register(fastifyMultipart, {
    limits: { fileSize: MAX_PHOTO_BYTES, files: 1, fields: 10, fieldSize: 1024 },
    throwFileSizeLimit: true,
  });

  app.post('/deliveries/:id/evidence', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    if (!req.isMultipart()) {
      return reply.code(415).send(Resource.wrap({ error: 'expected multipart/form-data' }));
    }

    let photo: Buffer | undefined;
    const fields: Record<string, unknown> = {};
    for await (const part of req.parts()) {
      if (part.type === 'file') {
        // Unknown file fields must still be consumed or the request stalls.
        const buf = await part.toBuffer();
        if (part.fieldname === 'photo') photo = buf;
      } else {
        fields[part.fieldname] = part.value;
      }
    }
    if (!photo) {
      return reply.code(400).send(Resource.wrap({ error: 'photo is required' }));
    }
    const parsed = evidenceFieldsSchema.safeParse(fields);
    if (!parsed.success) {
      return reply
        .code(400)
        .send(Resource.wrap({ error: 'invalid evidence fields', issues: parsed.error.issues }));
    }
    const f = parsed.data;

    const result = await evidence.submit({
      deliveryId: id,
      photo,
      gps:
        f.lat !== undefined && f.lng !== undefined
          ? { lat: f.lat, lng: f.lng, ...(f.accuracyM !== undefined && { accuracyM: f.accuracyM }) }
          : null,
      otp: f.otp,
      utcOffsetMinutes: f.utcOffsetMinutes,
    });

    if (result.ok) {
      return reply
        .code(201)
        .send(EvidenceResource.wrap(EvidenceResource.transform(result.evidence)));
    }
    switch (result.reason) {
      case 'not_found':
        return reply.code(404).send(Resource.wrap({ error: 'delivery not found' }));
      case 'invalid_photo':
        return reply
          .code(400)
          .send(
            Resource.wrap({ error: 'photo could not be read; send a JPEG, PNG or WebP image' }),
          );
      case 'not_accepting':
        return reply
          .code(409)
          .send(
            Resource.wrap({ error: 'delivery is not waiting for evidence', status: result.status }),
          );
      case 'conflict':
        return reply
          .code(409)
          .send(Resource.wrap({ error: 'delivery changed while uploading; try again' }));
    }
  });

  app.get('/evidence/:id/photo', async (req, reply) => {
    const { id } = idParamsSchema.parse(req.params);
    const path = await evidence.photoPath(id);
    if (
      !path ||
      !(await access(path).then(
        () => true,
        () => false,
      ))
    ) {
      return reply.code(404).send(Resource.wrap({ error: 'not found' }));
    }
    return reply
      .type('image/jpeg')
      .header('cache-control', 'private, max-age=3600')
      .send(createReadStream(path));
  });
};

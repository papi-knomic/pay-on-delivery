import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DeliveryStatus } from '@pod/shared';
import { count, eq, ne } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { newId } from '../db/ids.js';
import { deliveries, evidence, type Evidence } from '../db/schema.js';
import { StaleTransitionError, transitionDelivery } from '../deliveries/transition.js';
import type { Logger } from '../logger.js';
import {
  checkGpsDistance,
  checkOtp,
  checkPhotoFreshness,
  checkPhotoReuse,
} from '../verification/checks.js';
import { processPhoto, type ProcessedPhoto } from './photo.js';

/** States in which a rider may upload: first delivery attempt, or after the agent asked for more. */
export const ACCEPTS_EVIDENCE: readonly DeliveryStatus[] = ['IN_TRANSIT', 'NEEDS_MORE_EVIDENCE'];

export interface SubmitEvidenceInput {
  deliveryId: string;
  photo: Buffer;
  gps: { lat: number; lng: number; accuracyM?: number } | null;
  otp?: string;
  /** The rider's phone UTC offset, used to read EXIF times that carry no zone. */
  utcOffsetMinutes?: number;
}

export type SubmitEvidenceResult =
  | { ok: true; evidence: Evidence }
  | { ok: false; reason: 'not_found' | 'invalid_photo' | 'conflict' }
  | { ok: false; reason: 'not_accepting'; status: DeliveryStatus };

export interface EvidenceService {
  submit(input: SubmitEvidenceInput): Promise<SubmitEvidenceResult>;
  /** Absolute path of the stored photo, or null if there's no such evidence. */
  photoPath(evidenceId: string): Promise<string | null>;
}

export function createEvidenceService(deps: {
  db: Db;
  logger: Logger;
  uploadDir: string;
  now?: () => Date;
}): EvidenceService {
  const { db, uploadDir } = deps;
  const now = deps.now ?? (() => new Date());
  const log = deps.logger.child({ component: 'evidence' });

  return {
    async submit(input) {
      const [delivery] = await db
        .select()
        .from(deliveries)
        .where(eq(deliveries.id, input.deliveryId))
        .limit(1);
      if (!delivery) return { ok: false, reason: 'not_found' };
      if (!ACCEPTS_EVIDENCE.includes(delivery.status)) {
        return { ok: false, reason: 'not_accepting', status: delivery.status };
      }

      let photo: ProcessedPhoto;
      try {
        photo = await processPhoto(input.photo, { utcOffsetMinutes: input.utcOffsetMinutes });
      } catch (err) {
        log.warn({ deliveryId: delivery.id, err }, 'rejected undecodable photo');
        return { ok: false, reason: 'invalid_photo' };
      }

      const uploadedAt = now();
      const priorHashes = await db
        .select({ deliveryId: evidence.deliveryId, photoHash: evidence.photoHash })
        .from(evidence)
        .where(ne(evidence.deliveryId, delivery.id));
      const address =
        delivery.deliveryLat !== null && delivery.deliveryLng !== null
          ? { lat: delivery.deliveryLat, lng: delivery.deliveryLng }
          : null;
      const checks = [
        checkGpsDistance({ address, rider: input.gps }),
        checkOtp({ deliveryId: delivery.id, otpHash: delivery.otpHash, submittedOtp: input.otp }),
        checkPhotoReuse({ deliveryId: delivery.id, photoHash: photo.hash, priorHashes }),
        checkPhotoFreshness({ takenAt: photo.takenAt, uploadedAt }),
      ];

      const id = newId('evd');
      const photoPath = `${delivery.id}/${id}.jpg`;
      const absolutePath = join(uploadDir, photoPath);
      await mkdir(join(uploadDir, delivery.id), { recursive: true });
      await writeFile(absolutePath, photo.jpeg);

      try {
        const row = await db.transaction(async (tx) => {
          // Transition first: it locks the delivery row, so a concurrent upload waits and then fails.
          await transitionDelivery(tx, log, delivery.id, delivery.status, 'EVIDENCE_SUBMITTED');
          const [prior] = await tx
            .select({ n: count() })
            .from(evidence)
            .where(eq(evidence.deliveryId, delivery.id));
          const [inserted] = await tx
            .insert(evidence)
            .values({
              id,
              deliveryId: delivery.id,
              attempt: Number(prior?.n ?? 0) + 1,
              photoPath,
              photoHash: photo.hash,
              photoTakenAt: photo.takenAt,
              lat: input.gps?.lat ?? null,
              lng: input.gps?.lng ?? null,
              gpsAccuracyM: input.gps?.accuracyM ?? null,
              otpSubmitted: Boolean(input.otp),
              checks,
              createdAt: uploadedAt,
            })
            .returning();
          return inserted!;
        });
        log.info(
          {
            deliveryId: delivery.id,
            evidenceId: id,
            attempt: row.attempt,
            checks: checks.map((c) => `${c.name}:${c.status}`),
          },
          'evidence submitted',
        );
        return { ok: true, evidence: row };
      } catch (err) {
        await rm(absolutePath, { force: true });
        if (err instanceof StaleTransitionError) return { ok: false, reason: 'conflict' };
        throw err;
      }
    },

    async photoPath(evidenceId) {
      const [row] = await db
        .select({ photoPath: evidence.photoPath })
        .from(evidence)
        .where(eq(evidence.id, evidenceId))
        .limit(1);
      return row ? join(uploadDir, row.photoPath) : null;
    },
  };
}

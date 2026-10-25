import { Resource } from '@kn0mic/reshaper';
import type { EvidenceDto } from '@pod/shared';
import type { Evidence } from '../db/schema.js';

export interface EvidenceResourceOptions {
  isOps?: boolean;
}

const iso = (d: Date) => d.toISOString();

/** Riders get a receipt; the rider's location and the check results are ops-only. */
export class EvidenceResource extends Resource {
  static override transform(row: Evidence, options: EvidenceResourceOptions = {}): EvidenceDto {
    const isOps = options.isOps ?? false;
    return Resource.clean({
      id: row.id,
      deliveryId: row.deliveryId,
      attempt: row.attempt,
      photoUrl: `/api/evidence/${row.id}/photo`,
      photoTakenAt: Resource.whenNotNull(row.photoTakenAt, iso),
      createdAt: iso(row.createdAt),
      gps: Resource.when(isOps && row.lat !== null && row.lng !== null, () => ({
        lat: row.lat!,
        lng: row.lng!,
        ...(row.gpsAccuracyM !== null && { accuracyM: row.gpsAccuracyM }),
      })),
      checks: Resource.when(isOps, () => row.checks),
    }) as EvidenceDto;
  }
}

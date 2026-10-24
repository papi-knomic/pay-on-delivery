import { createHash, timingSafeEqual } from 'node:crypto';
import {
  VERIFICATION_THRESHOLDS,
  type CheckResult,
  type VerificationThresholds,
} from '@pod/shared';

export interface LatLng {
  lat: number;
  lng: number;
}

const EARTH_RADIUS_M = 6_371_000;
const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(h));
}

export function checkGpsDistance(
  input: { address: LatLng | null; rider: (LatLng & { accuracyM?: number }) | null },
  t: VerificationThresholds = VERIFICATION_THRESHOLDS,
): CheckResult {
  if (!input.address) {
    return {
      name: 'gps_distance',
      status: 'skipped',
      detail: 'Delivery address has no coordinates',
    };
  }
  if (!input.rider) {
    return { name: 'gps_distance', status: 'fail', detail: 'Rider submitted no GPS location' };
  }
  const distance = haversineMeters(input.address, input.rider);
  const allowance = Math.min(input.rider.accuracyM ?? 0, t.maxGpsAccuracyAllowanceM);
  const accuracy =
    input.rider.accuracyM === undefined ? '' : ` (±${Math.round(input.rider.accuracyM)} m)`;
  const ok = distance - allowance <= t.maxGpsDistanceM;
  return {
    name: 'gps_distance',
    status: ok ? 'pass' : 'fail',
    detail: `${Math.round(distance)} m from the delivery address${accuracy}; limit ${t.maxGpsDistanceM} m`,
    value: Math.round(distance),
  };
}

/** Scoped to the delivery so equal OTPs on different deliveries don't share a hash. */
export function hashOtp(deliveryId: string, otp: string): string {
  return createHash('sha256').update(`${deliveryId}:${otp.trim()}`).digest('hex');
}

export function checkOtp(input: {
  deliveryId: string;
  otpHash: string | null;
  submittedOtp: string | undefined;
}): CheckResult {
  if (!input.otpHash) {
    return { name: 'otp', status: 'skipped', detail: 'No buyer OTP on this delivery' };
  }
  if (!input.submittedOtp) {
    return {
      name: 'otp',
      status: 'skipped',
      detail: 'Buyer has an OTP but the rider did not enter one',
    };
  }
  const expected = Buffer.from(input.otpHash, 'hex');
  const actual = Buffer.from(hashOtp(input.deliveryId, input.submittedOtp), 'hex');
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);
  return ok
    ? { name: 'otp', status: 'pass', detail: 'Buyer OTP matches' }
    : { name: 'otp', status: 'fail', detail: 'Buyer OTP does not match' };
}

const PHOTO_HASH = /^[0-9a-f]{16}$/;

/** Bits that differ between two 64-bit perceptual hashes (hex). */
export function photoHashDistance(a: string, b: string): number {
  if (!PHOTO_HASH.test(a) || !PHOTO_HASH.test(b)) {
    throw new RangeError('Photo hashes must be 16 lowercase hex characters');
  }
  let diff = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let bits = 0;
  while (diff) {
    bits += Number(diff & 1n);
    diff >>= 1n;
  }
  return bits;
}

/** Re-uploading the same photo to the same delivery (a retry) is not reuse, so those are ignored. */
export function checkPhotoReuse(
  input: {
    deliveryId: string;
    photoHash: string;
    priorHashes: readonly { deliveryId: string; photoHash: string }[];
  },
  t: VerificationThresholds = VERIFICATION_THRESHOLDS,
): CheckResult {
  let closest: { deliveryId: string; distance: number } | undefined;
  for (const prior of input.priorHashes) {
    if (prior.deliveryId === input.deliveryId) continue;
    const distance = photoHashDistance(input.photoHash, prior.photoHash);
    if (!closest || distance < closest.distance)
      closest = { deliveryId: prior.deliveryId, distance };
  }
  if (closest && closest.distance <= t.maxPhotoHashDistance) {
    return {
      name: 'photo_reuse',
      status: 'fail',
      detail: `Photo matches one already used for delivery ${closest.deliveryId}`,
      value: closest.distance,
    };
  }
  return {
    name: 'photo_reuse',
    status: 'pass',
    detail: closest ? 'Photo does not match any earlier upload' : 'No earlier uploads to compare',
    ...(closest && { value: closest.distance }),
  };
}

export function checkPhotoFreshness(
  input: { takenAt: Date | null; uploadedAt: Date },
  t: VerificationThresholds = VERIFICATION_THRESHOLDS,
): CheckResult {
  if (!input.takenAt) {
    return {
      name: 'photo_freshness',
      status: 'skipped',
      detail: 'Photo has no capture timestamp (EXIF)',
    };
  }
  const ageMs = input.uploadedAt.getTime() - input.takenAt.getTime();
  const minutes = Math.round(ageMs / 60_000);
  if (ageMs < -t.maxPhotoClockSkewMs) {
    return {
      name: 'photo_freshness',
      status: 'fail',
      detail: `Photo timestamp is ${-minutes} min after the upload`,
      value: minutes,
    };
  }
  const ok = ageMs <= t.maxPhotoAgeMs;
  return {
    name: 'photo_freshness',
    status: ok ? 'pass' : 'fail',
    detail: `Photo taken ${Math.max(minutes, 0)} min before upload; limit ${Math.round(t.maxPhotoAgeMs / 60_000)} min`,
    value: minutes,
  };
}

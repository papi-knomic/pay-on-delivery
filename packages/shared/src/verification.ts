/** Deterministic evidence checks. They run in code before the model sees anything, and the model can't override a failure. */
export const CHECK_NAMES = ['gps_distance', 'otp', 'photo_reuse', 'photo_freshness'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

export type CheckStatus = 'pass' | 'fail' | 'skipped';

export interface CheckResult {
  name: CheckName;
  status: CheckStatus;
  /** Human-readable; shown in the dashboard and given to the model. */
  detail: string;
  /** Measured value: metres from the address, minutes since the photo was taken, hash distance. */
  value?: number;
}

export const VERIFICATION_THRESHOLDS = {
  /** Rider GPS must be within this many metres of the delivery address. */
  maxGpsDistanceM: 150,
  /** Slack from the phone's reported accuracy, capped so a vague fix can't excuse a far one. */
  maxGpsAccuracyAllowanceM: 50,
  /** Hamming distance (out of 64 bits) at or below which two photo hashes are the same photo. */
  maxPhotoHashDistance: 6,
  /** The photo must have been taken within this long before upload. */
  maxPhotoAgeMs: 30 * 60 * 1000,
  /** Tolerated clock skew for a photo timestamp that is ahead of the upload time. */
  maxPhotoClockSkewMs: 5 * 60 * 1000,
  /** Below this, a money-moving decision is escalated to a human. */
  minConfidence: 0.8,
  /** After this many evidence requests on one delivery, escalate instead of asking again. */
  maxEvidenceRequests: 2,
} as const;

export type VerificationThresholds = { [K in keyof typeof VERIFICATION_THRESHOLDS]: number };

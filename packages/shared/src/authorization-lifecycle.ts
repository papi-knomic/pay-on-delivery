const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * PayPal authorization windows (verified Oct 2026): valid 29 days, 3-day honor period.
 * All offsets count from the ORIGINAL authorization, even after reauthorizing.
 */
export const AUTHORIZATION_VALIDITY_MS = 29 * DAY_MS;
export const HONOR_PERIOD_MS = 3 * DAY_MS;

/** Day 3: flag on the dashboard that the honor period is ending. */
export const HONOR_FLAG_OFFSET_MS = 2 * DAY_MS;
/** Day 4: honor period over; reauthorize if still undelivered. */
export const REAUTHORIZE_OFFSET_MS = 3 * DAY_MS;
/** Day 29: void the current authorization and mark EXPIRED, before PayPal lapses it. */
export const EXPIRE_OFFSET_MS = 28 * DAY_MS;

export interface AuthorizationSchedule {
  flagHonorPeriodAt: Date;
  reauthorizeAt: Date;
  expireAt: Date;
  validUntil: Date;
}

export function authorizationSchedule(originalAuthorizedAt: Date): AuthorizationSchedule {
  const t = originalAuthorizedAt.getTime();
  return {
    flagHonorPeriodAt: new Date(t + HONOR_FLAG_OFFSET_MS),
    reauthorizeAt: new Date(t + REAUTHORIZE_OFFSET_MS),
    expireAt: new Date(t + EXPIRE_OFFSET_MS),
    validUntil: new Date(t + AUTHORIZATION_VALIDITY_MS),
  };
}

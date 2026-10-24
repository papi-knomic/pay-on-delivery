import { describe, expect, it } from 'vitest';
import { authorizationSchedule } from './authorization-lifecycle.js';

describe('authorizationSchedule', () => {
  it('schedules flag at day 3, reauth at day 4, expiry at day 29 from the original authorization', () => {
    const authorizedAt = new Date('2026-10-01T12:00:00Z');
    const s = authorizationSchedule(authorizedAt);
    expect(s.flagHonorPeriodAt.toISOString()).toBe('2026-10-03T12:00:00.000Z');
    expect(s.reauthorizeAt.toISOString()).toBe('2026-10-04T12:00:00.000Z');
    expect(s.expireAt.toISOString()).toBe('2026-10-29T12:00:00.000Z');
    expect(s.validUntil.toISOString()).toBe('2026-10-30T12:00:00.000Z');
  });

  it('voids strictly before PayPal lapses the authorization', () => {
    const s = authorizationSchedule(new Date(0));
    expect(s.expireAt.getTime()).toBeLessThan(s.validUntil.getTime());
    expect(s.flagHonorPeriodAt.getTime()).toBeLessThan(s.reauthorizeAt.getTime());
  });
});

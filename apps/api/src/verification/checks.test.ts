import { describe, expect, it } from 'vitest';
import {
  checkGpsDistance,
  checkOtp,
  checkPhotoFreshness,
  checkPhotoReuse,
  haversineMeters,
  hashOtp,
  photoHashDistance,
} from './checks.js';

// Lekki Phase 1, Lagos
const ADDRESS = { lat: 6.4474, lng: 3.4723 };
// ~0.001° of latitude ≈ 111 m
const offsetNorth = (metres: number) => ({ lat: ADDRESS.lat + metres / 111_195, lng: ADDRESS.lng });

describe('haversineMeters', () => {
  it('is zero for the same point and ~111 m per 0.001° of latitude', () => {
    expect(haversineMeters(ADDRESS, ADDRESS)).toBe(0);
    expect(haversineMeters(ADDRESS, offsetNorth(111))).toBeCloseTo(111, 0);
  });
});

describe('checkGpsDistance', () => {
  it('passes near the address', () => {
    const r = checkGpsDistance({ address: ADDRESS, rider: offsetNorth(40) });
    expect(r).toMatchObject({ status: 'pass', value: 40 });
  });

  it('fails far from the address', () => {
    expect(checkGpsDistance({ address: ADDRESS, rider: offsetNorth(800) }).status).toBe('fail');
  });

  it('allows for reported accuracy, but only up to the cap', () => {
    const rider = { ...offsetNorth(180), accuracyM: 40 };
    expect(checkGpsDistance({ address: ADDRESS, rider }).status).toBe('pass');
    const vague = { ...offsetNorth(250), accuracyM: 500 };
    expect(checkGpsDistance({ address: ADDRESS, rider: vague }).status).toBe('fail');
  });

  it('fails without a rider fix and skips without address coordinates', () => {
    expect(checkGpsDistance({ address: ADDRESS, rider: null }).status).toBe('fail');
    expect(checkGpsDistance({ address: null, rider: ADDRESS }).status).toBe('skipped');
  });
});

describe('checkOtp', () => {
  const otpHash = hashOtp('dlv_1', '482913');

  it('passes on a match, ignoring surrounding whitespace', () => {
    expect(checkOtp({ deliveryId: 'dlv_1', otpHash, submittedOtp: ' 482913 ' }).status).toBe(
      'pass',
    );
  });

  it('fails on a mismatch, including the right OTP for another delivery', () => {
    expect(checkOtp({ deliveryId: 'dlv_1', otpHash, submittedOtp: '000000' }).status).toBe('fail');
    expect(checkOtp({ deliveryId: 'dlv_2', otpHash, submittedOtp: '482913' }).status).toBe('fail');
  });

  it('skips when there is no OTP or none was entered', () => {
    expect(checkOtp({ deliveryId: 'dlv_1', otpHash: null, submittedOtp: '1' }).status).toBe(
      'skipped',
    );
    expect(checkOtp({ deliveryId: 'dlv_1', otpHash, submittedOtp: undefined }).status).toBe(
      'skipped',
    );
  });
});

describe('photoHashDistance', () => {
  it('counts differing bits', () => {
    expect(photoHashDistance('0000000000000000', '0000000000000000')).toBe(0);
    expect(photoHashDistance('0000000000000000', '000000000000000f')).toBe(4);
    expect(photoHashDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
  });

  it('rejects malformed hashes', () => {
    expect(() => photoHashDistance('abc', '0000000000000000')).toThrow(RangeError);
  });
});

describe('checkPhotoReuse', () => {
  const photoHash = 'a5a5a5a5a5a5a5a5';

  it('fails when a near-identical photo was used on another delivery', () => {
    const r = checkPhotoReuse({
      deliveryId: 'dlv_2',
      photoHash,
      priorHashes: [
        { deliveryId: 'dlv_x', photoHash: '0f0f0f0f0f0f0f0f' },
        { deliveryId: 'dlv_1', photoHash: 'a5a5a5a5a5a5a5a4' },
      ],
    });
    expect(r).toMatchObject({ status: 'fail', value: 1 });
    expect(r.detail).toContain('dlv_1');
  });

  it('ignores earlier uploads for the same delivery', () => {
    const r = checkPhotoReuse({
      deliveryId: 'dlv_1',
      photoHash,
      priorHashes: [{ deliveryId: 'dlv_1', photoHash }],
    });
    expect(r.status).toBe('pass');
  });

  it('passes when nothing is close', () => {
    const r = checkPhotoReuse({
      deliveryId: 'dlv_2',
      photoHash,
      priorHashes: [{ deliveryId: 'dlv_1', photoHash: '5a5a5a5a5a5a5a5a' }],
    });
    expect(r).toMatchObject({ status: 'pass', value: 64 });
  });
});

describe('checkPhotoFreshness', () => {
  const uploadedAt = new Date('2026-10-24T12:00:00Z');
  const minutesBefore = (m: number) => new Date(uploadedAt.getTime() - m * 60_000);

  it('passes a recent photo and fails an old one', () => {
    expect(checkPhotoFreshness({ takenAt: minutesBefore(5), uploadedAt })).toMatchObject({
      status: 'pass',
      value: 5,
    });
    expect(checkPhotoFreshness({ takenAt: minutesBefore(45), uploadedAt }).status).toBe('fail');
  });

  it('tolerates small clock skew but fails a timestamp well in the future', () => {
    expect(checkPhotoFreshness({ takenAt: minutesBefore(-2), uploadedAt }).status).toBe('pass');
    expect(checkPhotoFreshness({ takenAt: minutesBefore(-20), uploadedAt }).status).toBe('fail');
  });

  it('skips when the photo has no timestamp', () => {
    expect(checkPhotoFreshness({ takenAt: null, uploadedAt }).status).toBe('skipped');
  });
});

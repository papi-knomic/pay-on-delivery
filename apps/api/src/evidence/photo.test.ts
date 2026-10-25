import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { photoHashDistance } from '../verification/checks.js';
import { parseExifDateTime, photoHash, processPhoto, readTakenAt } from './photo.js';

/** A 64×64 RGB test image whose pixel values come from `f(x, y)`. */
function image(f: (x: number, y: number) => number): Promise<Buffer> {
  const size = 64;
  const raw = Buffer.alloc(size * size * 3);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const v = Math.max(0, Math.min(255, Math.round(f(x, y))));
      raw.fill(v, (y * size + x) * 3, (y * size + x) * 3 + 3);
    }
  }
  return sharp(raw, { raw: { width: size, height: size, channels: 3 } })
    .jpeg()
    .toBuffer();
}

const blobs = (x: number, y: number) => 128 + 100 * Math.sin(x / 6) * Math.cos(y / 9);
const stripes = (x: number, y: number) => 128 + 100 * Math.sin((x + y) / 3);

describe('photoHash', () => {
  it('matches the same scene after resizing and recompression', async () => {
    const original = await image(blobs);
    const recompressed = await sharp(original).resize(48, 48).jpeg({ quality: 40 }).toBuffer();
    const d = photoHashDistance(await photoHash(original), await photoHash(recompressed));
    expect(d).toBeLessThanOrEqual(6);
  });

  it('tells different scenes apart', async () => {
    const d = photoHashDistance(
      await photoHash(await image(blobs)),
      await photoHash(await image(stripes)),
    );
    expect(d).toBeGreaterThan(16);
  });
});

describe('parseExifDateTime', () => {
  it('uses the EXIF offset when present', () => {
    expect(parseExifDateTime('2026:10:24 13:05:00', '+01:00')?.toISOString()).toBe(
      '2026-10-24T12:05:00.000Z',
    );
    expect(parseExifDateTime('2026:10:24 07:05:00', '-05:00', 60)?.toISOString()).toBe(
      '2026-10-24T12:05:00.000Z',
    );
  });

  it('falls back to the browser-reported offset, else gives up', () => {
    expect(parseExifDateTime('2026:10:24 13:05:00', undefined, 60)?.toISOString()).toBe(
      '2026-10-24T12:05:00.000Z',
    );
    expect(parseExifDateTime('2026:10:24 13:05:00', undefined)).toBeNull();
  });

  it('rejects anything that is not an EXIF timestamp', () => {
    expect(parseExifDateTime('yesterday', '+01:00')).toBeNull();
    expect(parseExifDateTime(undefined, '+01:00', 0)).toBeNull();
  });
});

describe('processPhoto', () => {
  it('reads the EXIF capture time, then strips metadata from the stored copy', async () => {
    const withExif = await sharp(await image(blobs))
      .withExif({ IFD2: { DateTimeOriginal: '2026:10:24 13:05:00', OffsetTimeOriginal: '+01:00' } })
      .jpeg()
      .toBuffer();
    expect((await readTakenAt(withExif))?.toISOString()).toBe('2026-10-24T12:05:00.000Z');

    const processed = await processPhoto(withExif);
    expect(processed.takenAt?.toISOString()).toBe('2026-10-24T12:05:00.000Z');
    expect(processed.hash).toMatch(/^[0-9a-f]{16}$/);
    expect((await sharp(processed.jpeg).metadata()).exif).toBeUndefined();
  });

  it('caps the long edge at 1600 px', async () => {
    const big = await sharp({
      create: { width: 4000, height: 2000, channels: 3, background: '#7a5' },
    })
      .jpeg()
      .toBuffer();
    const meta = await sharp((await processPhoto(big)).jpeg).metadata();
    expect([meta.width, meta.height]).toEqual([1600, 800]);
  });

  it('has no capture time when the photo has no EXIF', async () => {
    expect((await processPhoto(await image(blobs))).takenAt).toBeNull();
  });

  it('throws on something that is not an image', async () => {
    await expect(processPhoto(Buffer.from('not an image'))).rejects.toThrow();
  });
});

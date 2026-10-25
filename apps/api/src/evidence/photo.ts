import exifr from 'exifr';
import sharp from 'sharp';

const MAX_EDGE_PX = 1600;

export interface ProcessedPhoto {
  /** Auto-rotated, size-capped JPEG. sharp drops metadata, so the phone's EXIF GPS isn't stored. */
  jpeg: Buffer;
  hash: string;
  takenAt: Date | null;
}

/** Throws if the buffer isn't an image sharp can decode (JPEG, PNG, WebP...). */
export async function processPhoto(
  input: Buffer,
  opts: { utcOffsetMinutes?: number } = {},
): Promise<ProcessedPhoto> {
  const jpeg = await sharp(input)
    .rotate()
    .resize(MAX_EDGE_PX, MAX_EDGE_PX, { fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82 })
    .toBuffer();
  const [hash, takenAt] = await Promise.all([
    photoHash(jpeg),
    readTakenAt(input, opts.utcOffsetMinutes),
  ]);
  return { jpeg, hash, takenAt };
}

/** dHash: shrink to 9×8 grayscale and record whether each pixel is darker than its right neighbour. */
export async function photoHash(image: Buffer): Promise<string> {
  const { data, info } = await sharp(image)
    .removeAlpha()
    .grayscale()
    .resize(9, 8, { fit: 'fill' })
    .raw()
    .toBuffer({ resolveWithObject: true });
  const px = (x: number, y: number) => data[(y * 9 + x) * info.channels] ?? 0;
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (px(x, y) < px(x + 1, y) ? 1n : 0n);
    }
  }
  return bits.toString(16).padStart(16, '0');
}

export async function readTakenAt(
  image: Buffer,
  fallbackUtcOffsetMinutes?: number,
): Promise<Date | null> {
  let tags: { DateTimeOriginal?: unknown; OffsetTimeOriginal?: unknown } | undefined;
  try {
    tags = (await exifr.parse(image, {
      pick: ['DateTimeOriginal', 'OffsetTimeOriginal'],
      reviveValues: false,
    })) as typeof tags;
  } catch {
    return null;
  }
  return parseExifDateTime(
    tags?.DateTimeOriginal,
    tags?.OffsetTimeOriginal,
    fallbackUtcOffsetMinutes,
  );
}

const EXIF_DATETIME = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/;
const EXIF_OFFSET = /^([+-])(\d{2}):(\d{2})$/;

/**
 * EXIF DateTimeOriginal is the camera's wall-clock time with no zone. Use OffsetTimeOriginal when
 * the phone wrote it, else the offset the rider's browser reported; with neither, it can't be placed.
 */
export function parseExifDateTime(
  dateTime: unknown,
  offset: unknown,
  fallbackUtcOffsetMinutes?: number,
): Date | null {
  if (typeof dateTime !== 'string') return null;
  const m = EXIF_DATETIME.exec(dateTime);
  if (!m) return null;

  let offsetMinutes = fallbackUtcOffsetMinutes;
  const o = typeof offset === 'string' ? EXIF_OFFSET.exec(offset) : null;
  if (o) {
    offsetMinutes = (o[1] === '-' ? -1 : 1) * (Number(o[2]) * 60 + Number(o[3]));
  }
  if (offsetMinutes === undefined) return null;

  const [y, mo, d, h, mi, s] = m.slice(1).map(Number) as [
    number,
    number,
    number,
    number,
    number,
    number,
  ];
  const utc = Date.UTC(y, mo - 1, d, h, mi, s) - offsetMinutes * 60_000;
  return Number.isNaN(utc) ? null : new Date(utc);
}

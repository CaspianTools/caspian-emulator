import * as zlib from 'zlib';
import { DISPLAY_RULES } from '../constants';
import { isPng } from './Orientation';
import { Logger } from '../utils/Logger';

/**
 * Blank-frame detection.
 *
 * A screenshot can be structurally perfect and still be worthless: an emulator
 * that selected a broken GPU mode boots, enumerates, runs apps, and answers
 * `screencap -p` with a correctly-sized, correctly-formatted, entirely black
 * PNG. Geometry validation passes it, so the file reaches a store listing and
 * the first sign of trouble is a rejection from Google.
 *
 * Two tiers, no dependencies:
 *
 *   1. Compressed size per pixel. A flat image deflates to almost nothing, so
 *      the ratio separates blank from real by orders of magnitude. Measured on
 *      the frame that prompted this: 12,504 bytes for 1080x1920 black (0.0060
 *      B/px) against 796,198 for the same screen rendering (0.384 B/px).
 *   2. Actual pixels, but only when (1) trips. Inflating a 2 MP frame costs
 *      real time, so it is spent only on frames already suspected of being
 *      blank — and it is what keeps a legitimately flat screenshot (a
 *      solid-colour splash) from being failed on the size heuristic alone.
 */

/** How many pixels to sample before concluding a frame is one flat colour. */
const SAMPLE_TARGET = 1000;

export interface FrameContentCheck {
  /** True only when the frame is confirmed, or strongly suspected, featureless. */
  blank: boolean;
  /** User-facing explanation, present when `blank`. */
  reason?: string;
  bytesPerPixel: number;
  /** Set when pixel sampling ran and found a single colour, e.g. "#000000". */
  uniformColor?: string;
  /** False when the density gate tripped but the pixels could not be read. */
  confirmed: boolean;
}

/**
 * Decide whether a captured PNG carries a real image.
 *
 * Never throws: a frame this cannot parse is reported as not-blank, because
 * failing a capture on a decode bug would be worse than missing a black one.
 */
export function checkFrameContent(buf: Buffer, width: number, height: number): FrameContentCheck {
  const pixels = width * height;
  const bytesPerPixel = pixels > 0 ? buf.length / pixels : 0;

  if (pixels <= 0 || bytesPerPixel >= DISPLAY_RULES.MIN_BYTES_PER_PIXEL) {
    return { blank: false, bytesPerPixel, confirmed: true };
  }

  // The density gate has tripped. Confirm against real pixels before failing.
  let sample: { uniform: boolean; color?: string } | undefined;
  try {
    sample = samplePixels(buf, width, height);
  } catch (err) {
    Logger.debug(`Could not sample pixels for blank detection: ${err}`);
  }

  if (sample && !sample.uniform) {
    // Genuinely low-entropy but not featureless — a flat splash screen, say.
    return { blank: false, bytesPerPixel, confirmed: true };
  }

  if (sample?.uniform) {
    // Only blame the GPU when the frame is actually black. A uniform *coloured*
    // frame is equally unusable, but it is far more likely to be a splash
    // screen caught mid-load than a rendering failure, and saying "not
    // rendering" there would send the user after the wrong problem.
    const dark = isNearBlack(sample.color);
    return {
      blank: true,
      bytesPerPixel,
      uniformColor: sample.color,
      confirmed: true,
      reason: `the captured frame is a single flat colour (${sample.color}) — `
        + (dark ? 'the emulator is not rendering' : 'nothing was drawn over the background'),
    };
  }

  // Could not decode. The size alone is damning enough to report, but say so.
  return {
    blank: true,
    bytesPerPixel,
    confirmed: false,
    reason: `the captured frame holds almost no image data (${bytesPerPixel.toFixed(4)} bytes per pixel) `
      + '— the emulator is probably not rendering',
  };
}

/**
 * Whether a uniform colour is dark enough to indict the renderer.
 *
 * A non-rendering emulator produces true black; a splash screen almost never
 * does. The threshold is generous so a near-black theme background still reads
 * as a rendering failure rather than a design choice.
 */
function isNearBlack(hex: string | undefined): boolean {
  if (!hex) { return true; }
  const n = parseInt(hex.slice(1), 16);
  if (!Number.isFinite(n)) { return true; }
  return ((n >> 16) & 0xff) <= 16 && ((n >> 8) & 0xff) <= 16 && (n & 0xff) <= 16;
}

/** Per-filter-type byte reconstruction, PNG spec 9.2. */
function undoFilter(type: number, line: Buffer, prev: Buffer, bpp: number): void {
  switch (type) {
    case 0:
      break;
    case 1:
      for (let i = bpp; i < line.length; i++) { line[i] = (line[i] + line[i - bpp]) & 0xff; }
      break;
    case 2:
      for (let i = 0; i < line.length; i++) { line[i] = (line[i] + prev[i]) & 0xff; }
      break;
    case 3:
      for (let i = 0; i < line.length; i++) {
        const left = i >= bpp ? line[i - bpp] : 0;
        line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xff;
      }
      break;
    case 4:
      for (let i = 0; i < line.length; i++) {
        const a = i >= bpp ? line[i - bpp] : 0;
        const b = prev[i];
        const c = i >= bpp ? prev[i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        line[i] = (line[i] + pred) & 0xff;
      }
      break;
    default:
      throw new Error(`Unknown PNG filter type ${type}.`);
  }
}

/** Channel count per PNG colour type; undefined for the palette/unsupported ones. */
const CHANNELS: Record<number, number | undefined> = { 0: 1, 2: 3, 4: 2, 6: 4 };

/**
 * Inflate a PNG and check whether every sampled pixel is the same colour.
 *
 * Handles the non-interlaced 8-bit forms `screencap -p` actually produces.
 * Anything else (16-bit, palette, Adam7) throws and the caller falls back to
 * the size heuristic alone.
 */
function samplePixels(buf: Buffer, width: number, height: number): { uniform: boolean; color?: string } {
  if (!isPng(buf)) { throw new Error('Not a PNG.'); }

  const bitDepth = buf.readUInt8(24);
  const colorType = buf.readUInt8(25);
  const interlace = buf.readUInt8(28);
  const channels = CHANNELS[colorType];
  if (bitDepth !== 8 || channels === undefined || interlace !== 0) {
    throw new Error(`Unsupported PNG form (depth ${bitDepth}, colour type ${colorType}, interlace ${interlace}).`);
  }

  // Walk the chunk list and concatenate every IDAT. They are one continuous
  // zlib stream that may be split at arbitrary byte boundaries.
  const parts: Buffer[] = [];
  let offset = 8;
  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    if (type === 'IDAT') {
      parts.push(buf.subarray(offset + 8, offset + 8 + length));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;   // length + type + data + CRC
  }
  if (parts.length === 0) { throw new Error('No IDAT chunks.'); }

  const raw = zlib.inflateSync(Buffer.concat(parts));
  const bpp = channels;
  const stride = width * bpp;
  if (raw.length < (stride + 1) * height) { throw new Error('Truncated PNG data.'); }

  // Filters reference the previous scanline, so rows must be reconstructed in
  // order even though only some of them are sampled.
  const rowStep = Math.max(1, Math.floor(height / Math.sqrt(SAMPLE_TARGET)));
  const colStep = Math.max(1, Math.floor(width / Math.sqrt(SAMPLE_TARGET)));

  let prev = Buffer.alloc(stride);
  let first: string | undefined;

  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1);
    const line = Buffer.from(raw.subarray(start + 1, start + 1 + stride));
    undoFilter(raw[start], line, prev, bpp);

    if (y % rowStep === 0) {
      for (let x = 0; x < width; x += colStep) {
        const i = x * bpp;
        // Compare RGB only: a fully transparent black and an opaque black are
        // both blank, and screencap's alpha channel is uninformative anyway.
        const key = channels >= 3
          ? `${line[i]},${line[i + 1]},${line[i + 2]}`
          : `${line[i]}`;
        if (first === undefined) {
          first = key;
        } else if (key !== first) {
          return { uniform: false };
        }
      }
    }
    prev = line;
  }

  return { uniform: true, color: toHex(first, channels) };
}

function toHex(key: string | undefined, channels: number): string {
  if (!key) { return '#000000'; }
  const parts = key.split(',').map(Number);
  const [r, g, b] = channels >= 3 ? parts : [parts[0], parts[0], parts[0]];
  return '#' + [r, g, b].map(v => v.toString(16).padStart(2, '0')).join('');
}

import { AdbClient } from '../adb/AdbClient';
import { Logger } from '../utils/Logger';

/**
 * Rotation control and screen-settle detection.
 *
 * Rotation goes through `settings put system user_rotation` rather than
 * `adb emu rotate` (emulator-only, relative, and unreadable — so restore is
 * impossible) or `wm user-rotation lock` (argv shape changed across API levels
 * for no benefit over the settings path).
 */

export type Orientation = 'portrait' | 'landscape';

export class CaptureCancelledError extends Error {
  constructor() {
    super('Capture cancelled.');
    this.name = 'CaptureCancelledError';
  }
}

export interface CancellationLike {
  isCancellationRequested: boolean;
}

export interface StableFrame {
  buf: Buffer;
  width: number;
  height: number;
  orientation: Orientation;
  /** Set when the screen never settled within the timeout. */
  warning?: string;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function isPng(buf: Buffer): boolean {
  return buf.length >= 24
    && buf.subarray(0, 8).equals(PNG_SIGNATURE)
    && buf.subarray(12, 16).toString('ascii') === 'IHDR';
}

/**
 * Read a PNG's dimensions from its IHDR header — 24 bytes, no decode, no
 * dependency. Layout: 8-byte signature, 4-byte chunk length, "IHDR" at 12-15,
 * width as a big-endian uint32 at 16, height at 20.
 */
export function pngSize(buf: Buffer): { width: number; height: number } {
  if (!isPng(buf)) { throw new Error('Captured data is not a PNG.'); }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

export function orientationOf(width: number, height: number): Orientation {
  return height > width ? 'portrait' : 'landscape';
}

export function flipOrientation(o: Orientation): Orientation {
  return o === 'portrait' ? 'landscape' : 'portrait';
}

/**
 * What a given user_rotation should look like on this device.
 *
 * user_rotation is relative to the device's *natural* orientation, which is
 * landscape on tablets and most foldables. Assuming rotation 0 means portrait
 * mislabels every tablet capture, so the natural orientation has to be measured
 * once and threaded through.
 */
export function expectedOrientation(natural: Orientation, rotation: 0 | 1 | 2 | 3): Orientation {
  return rotation % 2 === 1 ? flipOrientation(natural) : natural;
}

/** The rotation that yields `target` on a device whose natural side is `natural`. */
export function rotationForOrientation(natural: Orientation, target: Orientation): 0 | 1 {
  return target === natural ? 0 : 1;
}

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export interface RotationSnapshot {
  accelerometerRotation: string | null;
  userRotation: string | null;
}

export async function snapshotRotation(adb: AdbClient, serial: string): Promise<RotationSnapshot> {
  return {
    accelerometerRotation: await adb.getSetting(serial, 'system', 'accelerometer_rotation'),
    userRotation: await adb.getSetting(serial, 'system', 'user_rotation'),
  };
}

export async function lockRotation(adb: AdbClient, serial: string, rotation: 0 | 1 | 2 | 3): Promise<void> {
  await adb.setUserRotation(serial, rotation);
}

export async function restoreRotation(adb: AdbClient, serial: string, snap: RotationSnapshot): Promise<void> {
  if (snap.userRotation === null) {
    await adb.deleteSetting(serial, 'system', 'user_rotation');
  } else {
    await adb.putSetting(serial, 'system', 'user_rotation', snap.userRotation);
  }
  // Auto-rotate last, so the sensor cannot fight the restore.
  if (snap.accelerometerRotation === null) {
    await adb.deleteSetting(serial, 'system', 'accelerometer_rotation');
  } else {
    await adb.putSetting(serial, 'system', 'accelerometer_rotation', snap.accelerometerRotation);
  }
}

export interface WaitOptions {
  expectOrientation?: Orientation;
  timeoutMs?: number;
  pollMs?: number;
  tailMs?: number;
  token?: CancellationLike;
}

/** A config change briefly blanks the screen; an all-black PNG compresses tiny. */
const MIN_PLAUSIBLE_PNG_BYTES = 10 * 1024;

/**
 * Wait until the screen stops changing, then capture it.
 *
 * Polls screencap dimensions rather than parsing `dumpsys window displays`:
 * dumpsys prints mCurrentRotation on API 31+, rotation= before that, and OEMs
 * reshape it freely — a version-matrix liability for a signal we can measure
 * exactly. The byte-length comparison catches mid-animation frames; with demo
 * mode on the clock is frozen, so idle frames are nearly byte-identical and
 * the threshold becomes very sharp.
 */
export async function waitForStableScreen(
  adb: AdbClient,
  serial: string,
  opts: WaitOptions = {},
): Promise<StableFrame> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const pollMs = opts.pollMs ?? 250;
  const tailMs = opts.tailMs ?? 500;
  const deadline = Date.now() + timeoutMs;

  let last: { w: number; h: number; len: number } | undefined;
  let latest: Buffer | undefined;

  while (Date.now() < deadline) {
    if (opts.token?.isCancellationRequested) { throw new CaptureCancelledError(); }

    const buf = await adb.captureScreenshotBuffer(serial);
    latest = buf;
    const { width, height } = pngSize(buf);
    const orientationOk = !opts.expectOrientation
      || orientationOf(width, height) === opts.expectOrientation;

    const stable = last
      && last.w === width
      && last.h === height
      && Math.abs(buf.length - last.len) / Math.max(buf.length, last.len) < 0.01;

    if (orientationOk && stable) {
      await delay(tailMs);
      let final = await adb.captureScreenshotBuffer(serial);
      if (final.length < MIN_PLAUSIBLE_PNG_BYTES) {
        Logger.warn(`Captured a suspiciously small frame (${final.length} bytes) on ${serial}; retrying once.`);
        await delay(tailMs);
        final = await adb.captureScreenshotBuffer(serial);
      }
      const size = pngSize(final);
      return { buf: final, ...size, orientation: orientationOf(size.width, size.height) };
    }

    last = { w: width, h: height, len: buf.length };
    await delay(pollMs);
  }

  // Timed out: hand back the best frame we have, flagged.
  const buf = latest ?? await adb.captureScreenshotBuffer(serial);
  const size = pngSize(buf);
  return {
    buf,
    ...size,
    orientation: orientationOf(size.width, size.height),
    warning: opts.expectOrientation
      ? `Screen did not settle into ${opts.expectOrientation} within ${timeoutMs}ms.`
      : `Screen did not settle within ${timeoutMs}ms.`,
  };
}

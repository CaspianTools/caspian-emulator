/**
 * Emulator boot readiness.
 *
 * `adb devices` reports state=device the moment the emulator's console port
 * answers, which is long before Android is usable. In the field an emulator
 * short on guest RAM reached state=device, finished its boot animation
 * (init.svc.bootanim=stopped), never set sys.boot_completed, and answered every
 * package-manager call with "Failure calling service package: Broken pipe" —
 * indistinguishable from a slow boot if you only look at `adb devices`.
 *
 * classifyBoot is pure — no vscode, no adb, no fs — so the state machine can be
 * reasoned about (and tested) without an emulator.
 */

import { AdbClient } from '../adb/AdbClient';

export type BootPhase = 'offline' | 'booting' | 'ready' | 'wedged';

export interface BootSignals {
  /** Present in `adb devices` with state=device. */
  present: boolean;
  /** sys.boot_completed === '1'. */
  bootCompleted: boolean;
  /** init.svc.bootanim: 'running' | 'stopped' | '' when unreadable. */
  bootAnim: string;
  /** A package-manager round trip succeeded. */
  pmOk: boolean;
  /** Why the package-manager probe failed, when it did. */
  pmError?: string;
}

/**
 * Errors that mean the system server is not coming back, as opposed to the
 * ordinary "not up yet" failures seen throughout a healthy boot.
 */
const WEDGED_PM_ERRORS = [
  /broken pipe/i,
  /failure calling service/i,
  /can't find service/i,
];

export function isWedgedPmError(message: string): boolean {
  return WEDGED_PM_ERRORS.some(re => re.test(message));
}

/** Every wedged signal is ignored before this much of the boot has elapsed. */
export const WEDGED_GRACE_MS = 90000;

/**
 * Decide which of the four states the guest is in.
 *
 * Both wedged fingerprints are gated behind `graceMs`, because both are also
 * true, briefly, during a perfectly healthy boot: the package manager answers
 * "Can't find service: package" until system_server publishes it, and the boot
 * animation stops a moment before `sys.boot_completed` appears. Only a guest
 * that still looks like this well into the boot is actually stuck.
 *
 * Callers should additionally require the verdict to repeat — see the launch
 * watch, which acts on two consecutive 'wedged' readings.
 */
export function classifyBoot(s: BootSignals, elapsedMs: number, graceMs = WEDGED_GRACE_MS): BootPhase {
  if (!s.present) { return 'offline'; }
  if (s.bootCompleted && s.pmOk) { return 'ready'; }
  if (elapsedMs < graceMs) { return 'booting'; }
  if (s.pmError && isWedgedPmError(s.pmError)) { return 'wedged'; }
  if (s.bootAnim === 'stopped' && !s.bootCompleted) { return 'wedged'; }
  return 'booting';
}

/** Human-readable progress text for a phase. */
export function describeBootPhase(phase: BootPhase): string {
  switch (phase) {
    case 'offline': return 'Waiting for the device to appear...';
    case 'booting': return 'Android is booting...';
    case 'ready': return 'Ready.';
    case 'wedged': return 'Boot stalled.';
  }
}

/**
 * Read the readiness signals off a device. Never throws: every probe failure
 * is folded into the signals, because "the shell refused us" is itself the
 * signal we are looking for.
 */
export async function probeBootState(
  adb: AdbClient,
  serial: string,
): Promise<BootSignals> {
  const signals: BootSignals = { present: false, bootCompleted: false, bootAnim: '', pmOk: false };

  try {
    const devices = await adb.getDevices();
    signals.present = devices.some(d => d.serial === serial && d.state === 'device');
  } catch {
    return signals;
  }
  if (!signals.present) { return signals; }

  try {
    signals.bootCompleted = (await adb.getProp(serial, 'sys.boot_completed')) === '1';
  } catch { /* still booting, or the shell is not up */ }

  try {
    signals.bootAnim = await adb.getProp(serial, 'init.svc.bootanim');
  } catch { /* property unreadable — leave blank */ }

  // A single package lookup rather than `pm list packages`: it is one binder
  // round trip and proves the package manager is actually serving, which is
  // what boot_completed alone does not.
  try {
    const out = await adb.shell(serial, ['pm', 'path', 'android']);
    if (out.includes('package:')) {
      signals.pmOk = true;
    } else {
      signals.pmError = out.trim() || 'package manager returned nothing';
    }
  } catch (err) {
    signals.pmError = err instanceof Error ? err.message : String(err);
  }

  return signals;
}

import * as vscode from 'vscode';
import { AdbClient } from '../adb/AdbClient';
import { DemoModeController, DEMO_ACTION } from './DemoMode';
import { Logger } from '../utils/Logger';

/**
 * Snapshot and restore every device setting a capture run mutates.
 *
 * `wm density` writes Settings.Secure.display_density_forced, which survives a
 * reboot and overrides the AVD's hw.lcd.density — so a run that dies halfway
 * leaves a permanently mis-scaled device whose symptom looks exactly like the
 * 320x640 config.ini bug. Three layers guard against that:
 *
 *   a) restore in a finally block, outside the cancellable progress
 *   b) a pending-restore record persisted before the first mutation, which is
 *      the only layer that survives a VS Code crash
 *   c) the unconditional "Reset Device Overrides" command
 */

const PENDING_PREFIX = 'caspian.pendingRestore.';

export interface DeviceStateSnapshot {
  serial: string;
  takenAt: number;
  deviceLabel: string;
  accelerometerRotation: string | null;
  userRotation: string | null;
  fontScale: string | null;
  forceRtl: string | null;
  densityOverride: number | null;
  physicalDensity: number | null;
  sysuiDemoAllowed: string | null;
  demoModeEntered: boolean;
  /** package → prior locale tags ([] means "followed the system default"). */
  appLocales: Record<string, string[]>;
}

export interface SnapshotDimensions {
  rotation?: boolean;
  fontScale?: boolean;
  density?: boolean;
  rtl?: boolean;
  demo?: boolean;
  packages?: string[];
}

export class DeviceStateManager {
  constructor(
    private adb: AdbClient,
    private context: vscode.ExtensionContext,
  ) {}

  /**
   * Read current values for every dimension a run will touch.
   * Each read is independently caught: a failed read stores null and logs, but
   * must never abort the run before it starts.
   */
  async capture(serial: string, deviceLabel: string, dims: SnapshotDimensions): Promise<DeviceStateSnapshot> {
    const snap: DeviceStateSnapshot = {
      serial,
      deviceLabel,
      takenAt: Date.now(),
      accelerometerRotation: null,
      userRotation: null,
      fontScale: null,
      forceRtl: null,
      densityOverride: null,
      physicalDensity: null,
      sysuiDemoAllowed: null,
      demoModeEntered: false,
      appLocales: {},
    };

    const read = async (label: string, fn: () => Promise<void>) => {
      try { await fn(); } catch (err) { Logger.warn(`Could not read ${label} on ${serial}: ${err}`); }
    };

    if (dims.rotation) {
      await read('accelerometer_rotation', async () => {
        snap.accelerometerRotation = await this.adb.getSetting(serial, 'system', 'accelerometer_rotation');
      });
      await read('user_rotation', async () => {
        snap.userRotation = await this.adb.getSetting(serial, 'system', 'user_rotation');
      });
    }
    if (dims.fontScale) {
      await read('font_scale', async () => {
        snap.fontScale = await this.adb.getSetting(serial, 'system', 'font_scale');
      });
    }
    if (dims.rtl) {
      await read('debug.force_rtl', async () => {
        snap.forceRtl = await this.adb.getSetting(serial, 'global', 'debug.force_rtl');
      });
    }
    if (dims.density) {
      await read('wm density', async () => {
        const d = await this.adb.getWmDensity(serial);
        snap.physicalDensity = d.physical ?? null;
        snap.densityOverride = d.override ?? null;
      });
    }
    if (dims.demo) {
      await read('sysui_demo_allowed', async () => {
        snap.sysuiDemoAllowed = await this.adb.getSetting(serial, 'global', 'sysui_demo_allowed');
      });
    }
    for (const pkg of dims.packages || []) {
      await read(`app locales for ${pkg}`, async () => {
        snap.appLocales[pkg] = await this.adb.getAppLocales(serial, pkg);
      });
    }

    return snap;
  }

  /** Persist the snapshot so a crash can still be recovered from. */
  async persist(snap: DeviceStateSnapshot): Promise<void> {
    await this.context.globalState.update(PENDING_PREFIX + snap.serial, snap);
  }

  async clearPending(serial: string): Promise<void> {
    await this.context.globalState.update(PENDING_PREFIX + serial, undefined);
  }

  getPending(serial: string): DeviceStateSnapshot | undefined {
    return this.context.globalState.get<DeviceStateSnapshot>(PENDING_PREFIX + serial);
  }

  listPending(): DeviceStateSnapshot[] {
    return this.context.globalState.keys()
      .filter(k => k.startsWith(PENDING_PREFIX))
      .map(k => this.context.globalState.get<DeviceStateSnapshot>(k))
      .filter((s): s is DeviceStateSnapshot => !!s);
  }

  /**
   * Put everything back. Never throws — returns a list of human-readable
   * failures so the caller can say "restored, except: display density"
   * instead of implying a clean result.
   */
  async restore(snap: DeviceStateSnapshot): Promise<string[]> {
    const failures: string[] = [];
    const serial = snap.serial;

    const step = async (label: string, fn: () => Promise<void>) => {
      try { await fn(); } catch (err) {
        Logger.warn(`Restore step "${label}" failed on ${serial}: ${err}`);
        failures.push(label);
      }
    };

    if (snap.demoModeEntered) {
      await step('demo mode', async () => {
        await this.adb.broadcast(serial, DEMO_ACTION, [['command', 'exit']]);
        DemoModeController.forget(serial);
      });
    }

    await step('display density', async () => {
      if (snap.densityOverride !== null) {
        await this.adb.setWmDensity(serial, snap.densityOverride);
      } else {
        await this.adb.resetWmDensity(serial);
      }
    });

    await step('font scale', () => this.restoreSetting(serial, 'system', 'font_scale', snap.fontScale));

    await step('RTL layout', async () => {
      if (snap.forceRtl !== null) {
        await this.adb.putSetting(serial, 'global', 'debug.force_rtl', snap.forceRtl);
      } else {
        await this.adb.putSetting(serial, 'global', 'debug.force_rtl', '0');
      }
    });

    await step('screen rotation', () => this.restoreSetting(serial, 'system', 'user_rotation', snap.userRotation));

    // Auto-rotate goes back LAST, so the sensor cannot snap the display around
    // mid-restore while user_rotation is still being written.
    await step('auto-rotate', () => this.restoreSetting(serial, 'system', 'accelerometer_rotation', snap.accelerometerRotation));

    for (const [pkg, tags] of Object.entries(snap.appLocales)) {
      await step(`language for ${pkg}`, () => this.adb.setAppLocales(serial, pkg, tags));
    }

    await step('demo mode setting', () => this.restoreSetting(serial, 'global', 'sysui_demo_allowed', snap.sysuiDemoAllowed));

    return failures;
  }

  private async restoreSetting(
    serial: string,
    ns: 'system' | 'secure' | 'global',
    key: string,
    prior: string | null,
  ): Promise<void> {
    if (prior === null) {
      await this.adb.deleteSetting(serial, ns, key);
    } else {
      await this.adb.putSetting(serial, ns, key, prior);
    }
  }

  /**
   * Unconditional reset — the panic button. Used when there is no snapshot to
   * work from, e.g. after a crash on a machine where globalState was lost.
   */
  async resetAllOverrides(serial: string): Promise<string[]> {
    const failures: string[] = [];
    const step = async (label: string, fn: () => Promise<void>) => {
      try { await fn(); } catch (err) {
        Logger.warn(`Reset step "${label}" failed on ${serial}: ${err}`);
        failures.push(label);
      }
    };

    await step('display density', () => this.adb.resetWmDensity(serial));
    await step('display size', () => this.adb.resetWmSize(serial));
    await step('font scale', () => this.adb.deleteSetting(serial, 'system', 'font_scale'));
    await step('RTL layout', () => this.adb.putSetting(serial, 'global', 'debug.force_rtl', '0'));
    await step('screen rotation', () => this.adb.deleteSetting(serial, 'system', 'user_rotation'));
    await step('auto-rotate', () => this.adb.putSetting(serial, 'system', 'accelerometer_rotation', '1'));
    await step('demo mode', async () => {
      await this.adb.broadcast(serial, DEMO_ACTION, [['command', 'exit']]);
      DemoModeController.forget(serial);
    });
    await step('demo mode setting', () => this.adb.deleteSetting(serial, 'global', 'sysui_demo_allowed'));

    await this.clearPending(serial);
    return failures;
  }
}

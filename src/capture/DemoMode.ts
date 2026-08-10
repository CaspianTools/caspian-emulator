import * as vscode from 'vscode';
import { AdbClient } from '../adb/AdbClient';
import { CONFIG } from '../constants';
import { Logger } from '../utils/Logger';

/**
 * SystemUI demo mode — the "clean status bar for store screenshots" toggle.
 *
 * Wraps the broadcast protocol documented in AOSP's
 * frameworks/base/packages/SystemUI/docs/demo_mode.md. Stable since API 21, so
 * there is no version gate. OEM skins (One UI, MIUI) re-implement the status
 * bar and ignore some or all of these commands — we log and let the user see
 * the result rather than trying to detect that.
 */

export const DEMO_ACTION = 'com.android.systemui.demo';
const DEMO_ALLOWED_KEY = 'sysui_demo_allowed';

/**
 * Google's documented snippet uses `datatype false`, relying on AOSP's
 * MobileSignalController falling through to UNKNOWN for any unrecognised value.
 * That fall-through is not universal: on several Google API images it renders a
 * "3G" label next to the bars. `none` is handled explicitly and reliably draws
 * nothing, which is what a store screenshot wants.
 */
const DEFAULT_DATA_TYPE = 'none';

/** Icons hidden by the `status` command to clear the right side of the bar. */
const STATUS_ICONS = [
  'volume', 'bluetooth', 'location', 'alarm', 'sync', 'tty',
  'eri', 'mute', 'speakerphone', 'zen', 'cast', 'hotspot',
];

export interface DemoModeOptions {
  /** Four digits, 24-hour HHMM. */
  clock: string;
  batteryLevel: number;
  /** Signal bars, 0–4. */
  signalLevel: number;
  hideNotifications: boolean;
  hideStatusIcons: boolean;
  dataType: string;
}

interface ActiveEntry {
  /** The value of sysui_demo_allowed before we touched it. */
  priorAllowed: string | null;
}

export class DemoModeController {
  private static active = new Map<string, ActiveEntry>();
  private static onChange = new vscode.EventEmitter<void>();

  /** Fires whenever any device enters or leaves demo mode. */
  static readonly onDidChange = DemoModeController.onChange.event;

  constructor(private adb: AdbClient) {}

  static isActive(serial: string): boolean {
    return DemoModeController.active.has(serial);
  }

  static activeSerials(): string[] {
    return [...DemoModeController.active.keys()];
  }

  /** Forget a device without touching it (used when it disconnects). */
  static forget(serial: string): void {
    if (DemoModeController.active.delete(serial)) {
      DemoModeController.onChange.fire();
    }
  }

  private readOptions(): DemoModeOptions {
    const cfg = vscode.workspace.getConfiguration(CONFIG.SECTION);
    const clock = String(cfg.get<string>(CONFIG.DEMO_CLOCK, '1000')).replace(/\D/g, '').padStart(4, '0').slice(0, 4);
    return {
      clock,
      batteryLevel: Math.max(0, Math.min(100, cfg.get<number>(CONFIG.DEMO_BATTERY_LEVEL, 100))),
      signalLevel: Math.max(0, Math.min(4, cfg.get<number>(CONFIG.DEMO_SIGNAL_LEVEL, 4))),
      hideNotifications: cfg.get<boolean>(CONFIG.DEMO_HIDE_NOTIFICATIONS, true),
      hideStatusIcons: cfg.get<boolean>(CONFIG.DEMO_HIDE_STATUS_ICONS, true),
      dataType: DEFAULT_DATA_TYPE,
    };
  }

  /**
   * Enter demo mode. Verifies the secure-settings write took effect, because
   * `am broadcast` reports result=0 whether or not SystemUI acted — the
   * read-back is the only genuine success signal available.
   */
  async enter(serial: string, overrides?: Partial<DemoModeOptions>): Promise<void> {
    const opts = { ...this.readOptions(), ...overrides };

    const priorAllowed = DemoModeController.active.get(serial)?.priorAllowed
      ?? await this.adb.getSetting(serial, 'global', DEMO_ALLOWED_KEY);

    await this.adb.putSetting(serial, 'global', DEMO_ALLOWED_KEY, 1);
    const readBack = await this.adb.getSetting(serial, 'global', DEMO_ALLOWED_KEY);
    if (readBack !== '1') {
      throw new Error(
        'Could not enable demo mode: writing sysui_demo_allowed was blocked. '
        + 'This usually means the device is managed by an MDM policy.',
      );
    }

    const send = (extras: Array<[string, string]>) => this.adb.broadcast(serial, DEMO_ACTION, extras);

    await send([['command', 'enter']]);
    await send([['command', 'clock'], ['hhmm', opts.clock]]);
    await send([['command', 'battery'], ['level', String(opts.batteryLevel)], ['plugged', 'false']]);
    await send([['command', 'network'], ['mobile', 'show'], ['level', String(opts.signalLevel)], ['datatype', opts.dataType]]);
    // `fully true` marks the Wi-Fi link as validated; without it SystemUI draws
    // the "no internet" exclamation mark over the glyph.
    await send([['command', 'network'], ['wifi', 'show'], ['level', String(opts.signalLevel)], ['fully', 'true']]);
    await send([['command', 'network'], ['airplane', 'hide']]);

    if (opts.hideStatusIcons) {
      const extras: Array<[string, string]> = [['command', 'status']];
      for (const icon of STATUS_ICONS) { extras.push([icon, 'hide']); }
      await send(extras);
    }
    if (opts.hideNotifications) {
      await send([['command', 'notifications'], ['visible', 'false']]);
    }

    DemoModeController.active.set(serial, { priorAllowed });
    DemoModeController.onChange.fire();
    Logger.info(`Demo mode entered on ${serial} (clock ${opts.clock}, battery ${opts.batteryLevel}%).`);
  }

  /** Leave demo mode and restore sysui_demo_allowed. Safe to call when inactive. */
  async exit(serial: string): Promise<void> {
    const entry = DemoModeController.active.get(serial);
    try {
      await this.adb.broadcast(serial, DEMO_ACTION, [['command', 'exit']]);
    } finally {
      const prior = entry?.priorAllowed ?? null;
      try {
        if (prior === null) {
          await this.adb.deleteSetting(serial, 'global', DEMO_ALLOWED_KEY);
        } else {
          await this.adb.putSetting(serial, 'global', DEMO_ALLOWED_KEY, prior);
        }
      } catch (err) {
        Logger.warn(`Could not restore ${DEMO_ALLOWED_KEY} on ${serial}: ${err}`);
      }
      DemoModeController.active.delete(serial);
      DemoModeController.onChange.fire();
      Logger.info(`Demo mode exited on ${serial}.`);
    }
  }

  /**
   * Re-send the demo commands after something restarted SystemUI.
   *
   * `wm density` and `wm size` re-inflate the status bar, which drops demo
   * state part-way: the observed result is a bar with duplicated icons (two
   * Wi-Fi glyphs, two data labels). Exiting first clears the stale views, so
   * this is exit-then-enter rather than a plain re-send.
   */
  async reapply(serial: string): Promise<void> {
    if (!DemoModeController.isActive(serial)) { return; }
    const entry = DemoModeController.active.get(serial);
    await this.adb.broadcast(serial, DEMO_ACTION, [['command', 'exit']]);
    // Keep the recorded prior value: enter() reuses it rather than reading back
    // the '1' we just wrote, which would otherwise become the "restore" target.
    DemoModeController.active.delete(serial);
    if (entry) { DemoModeController.active.set(serial, entry); }
    await this.enter(serial);
    Logger.info(`Demo mode re-applied on ${serial} after a configuration change.`);
  }

  /** Toggle demo mode; returns the new state. */
  async toggle(serial: string): Promise<boolean> {
    if (DemoModeController.isActive(serial)) {
      await this.exit(serial);
      return false;
    }
    await this.enter(serial);
    return true;
  }
}

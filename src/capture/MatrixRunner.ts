import * as vscode from 'vscode';
import { AdbClient } from '../adb/AdbClient';
import { CaptureResult, CaptureService } from './CaptureService';
import { CaptureCancelledError, Orientation } from './Orientation';
import { resolveRunDirectory } from './CapturePaths';
import { Logger } from '../utils/Logger';

/**
 * Cross-product runner for the locale / font-scale / density matrix.
 *
 * Per-app locales (API 33+) are the only language mechanism used: they are
 * official, need no root, no reboot, and work on Play system images. The
 * alternatives (setprop persist.sys.locale + stop/start) restart the whole
 * framework and are unreliable on production builds.
 */

/** Minimum API level for `cmd locale set-app-locales`. */
export const PER_APP_LOCALE_MIN_API = 33;

/** Pseudolocales, useful without a translator. */
export const PSEUDOLOCALES = [
  { tag: 'en-XA', description: 'Pseudolocale — accented, ~30% longer text (catches truncation)' },
  { tag: 'ar-XB', description: 'Pseudolocale — bidi/RTL mirroring (catches layout bugs)' },
];

export const FONT_SCALE_STOPS = [0.85, 1.0, 1.15, 1.3, 1.5, 1.8, 2.0];

export interface MatrixDimensions {
  /** Empty = do not vary this axis. */
  locales: string[];
  fontScales: number[];
  densities: number[];
  orientations: Orientation[];
  forceRtl: boolean;
}

export interface MatrixContext {
  serial: string;
  deviceLabel: string;
  packageName: string;
  runName: string;
}

export function countCells(dims: MatrixDimensions): number {
  const axis = (n: number) => Math.max(1, n);
  return axis(dims.densities.length)
    * axis(dims.locales.length)
    * axis(dims.fontScales.length)
    * Math.max(1, dims.orientations.length);
}

const ROTATION_FOR: Record<Orientation, 0 | 1> = { portrait: 0, landscape: 1 };

export class MatrixRunner {
  constructor(
    private adb: AdbClient,
    private capture: CaptureService,
  ) {}

  /**
   * Run the cross-product.
   *
   * Loop order is outermost = most expensive to change, so heavy axes re-apply
   * as rarely as possible: density restarts the world, locale is a cheap
   * per-app write, font scale is a global config change, orientation is a
   * settings write.
   */
  async run(
    ctx: MatrixContext,
    dims: MatrixDimensions,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<{ results: CaptureResult[]; notes: string[] }> {
    const { dir: runDir } = resolveRunDirectory(ctx.runName);
    const results: CaptureResult[] = [];
    const notes: string[] = [];

    const densities = dims.densities.length ? dims.densities : [undefined];
    const locales = dims.locales.length ? dims.locales : [undefined];
    const fontScales = dims.fontScales.length ? dims.fontScales : [undefined];
    const orientations = dims.orientations.length ? dims.orientations : ['portrait' as Orientation];

    const total = densities.length * locales.length * fontScales.length * orientations.length;
    const increment = 100 / total;

    if (dims.forceRtl) {
      await this.adb.putSetting(ctx.serial, 'global', 'debug.force_rtl', '1');
    }

    let launchTarget: { component?: string; packageName?: string };
    const component = await this.adb.resolveLauncherActivity(ctx.serial, ctx.packageName);
    if (component) {
      launchTarget = { component };
    } else {
      launchTarget = { packageName: ctx.packageName };
      notes.push(`Could not resolve a launcher activity for ${ctx.packageName}; falling back to an intent launch.`);
    }

    let appliedDensity: number | undefined;
    let appliedLocale: string | undefined;
    let appliedFontScale: number | undefined;
    let index = 0;

    for (const density of densities) {
      if (density !== appliedDensity) {
        if (density === undefined) {
          await this.adb.resetWmDensity(ctx.serial);
        } else {
          await this.adb.setWmDensity(ctx.serial, density);
        }
        appliedDensity = density;
      }

      for (const locale of locales) {
        if (locale !== appliedLocale) {
          await this.adb.setAppLocales(ctx.serial, ctx.packageName, locale ? [locale] : []);
          // set-app-locales silently no-ops on an app that is not installed.
          if (locale) {
            try {
              const readBack = await this.adb.getAppLocales(ctx.serial, ctx.packageName);
              if (!readBack.some(t => t.toLowerCase() === locale.toLowerCase())) {
                notes.push(`Locale "${locale}" did not take effect — the device may not support it.`);
              }
            } catch (err) {
              Logger.warn(`Could not verify locale ${locale}: ${err}`);
            }
          }
          appliedLocale = locale;
        }

        for (const fontScale of fontScales) {
          if (fontScale !== appliedFontScale) {
            if (fontScale === undefined) {
              await this.adb.deleteSetting(ctx.serial, 'system', 'font_scale');
            } else {
              await this.adb.putSetting(ctx.serial, 'system', 'font_scale', fontScale);
            }
            appliedFontScale = fontScale;
          }

          for (const orientation of orientations) {
            if (token.isCancellationRequested) { throw new CaptureCancelledError(); }

            const label = [
              locale || 'default',
              fontScale !== undefined ? `${fontScale}×` : undefined,
              density !== undefined ? `${density} dpi` : undefined,
              orientation,
            ].filter(Boolean).join(' · ');
            progress.report({ message: `${label} (${index + 1}/${total})`, increment });

            // Force-stop + start + wait, in one call, so a config change is
            // fully applied before the screen is measured.
            try {
              await this.adb.startActivity(ctx.serial, launchTarget);
            } catch (err) {
              notes.push(`Could not launch ${ctx.packageName} for ${label}: ${err instanceof Error ? err.message : err}`);
              index++;
              continue;
            }

            const result = await this.capture.captureCell(ctx.serial, ROTATION_FOR[orientation], {
              runDir,
              deviceLabel: ctx.deviceLabel,
              index: index + 1,
              locale,
              fontScale,
              density,
              token,
            });
            results.push(result);
            index++;
          }
        }
      }
    }

    return { results, notes };
  }
}

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { AdbClient } from '../adb/AdbClient';
import { CONFIG, DISPLAY_RULES } from '../constants';
import { playScreenshotCheck } from '../avd/DisplayCheck';
import {
  CancellationLike,
  CaptureCancelledError,
  Orientation,
  RotationSnapshot,
  lockRotation,
  restoreRotation,
  snapshotRotation,
  waitForStableScreen,
} from './Orientation';
import {
  buildCaptureFileName,
  resolveLocaleDirectory,
  resolveRunDirectory,
} from './CapturePaths';
import { DemoModeController } from './DemoMode';
import { Logger } from '../utils/Logger';

export interface AssetValidation {
  level: 'pass' | 'warn' | 'fail';
  issues: string[];
  ratio: number;
}

export interface CaptureResult {
  file: string;
  relPath: string;
  width: number;
  height: number;
  orientation: Orientation;
  locale?: string;
  fontScale?: number;
  density?: number;
  validation: AssetValidation;
  warnings: string[];
}

/**
 * Validate a captured PNG against Play Console's screenshot rules.
 *
 * The documented 16:9 ratio is a warning, not a failure: a Pixel 7 is 2.222:1
 * and a Pixel 9 Pro is 2.231:1, so a hard 16:9 gate would fail every device
 * this extension ships a preset for and the feature would read as broken.
 */
export function validatePlayAsset(width: number, height: number, maxRatio: number): AssetValidation {
  const issues: string[] = [];
  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const ratio = short > 0 ? long / short : 0;

  if (short < DISPLAY_RULES.PLAY_MIN_SIDE) {
    issues.push(`Short side ${short}px is below the ${DISPLAY_RULES.PLAY_MIN_SIDE}px minimum.`);
  }
  if (long > DISPLAY_RULES.PLAY_MAX_SIDE) {
    issues.push(`Long side ${long}px is above the ${DISPLAY_RULES.PLAY_MAX_SIDE}px maximum.`);
  }
  if (ratio > maxRatio) {
    // This is the failure the user hit with no explanation from Play: a modern
    // phone's native screenshot is taller than 2:1. Say what to do about it.
    issues.push(
      `Aspect ratio ${ratio.toFixed(2)}:1 exceeds Play's ${maxRatio}:1 limit — `
      + `crop or pad to at most ${Math.round(short * maxRatio)}px tall before uploading.`,
    );
  }
  if (issues.length > 0) { return { level: 'fail', issues, ratio }; }

  const play = playScreenshotCheck(width, height);
  if (!play.promoEligible) {
    return { level: 'warn', issues: play.reasons, ratio };
  }
  return { level: 'pass', issues: [], ratio };
}

export interface CaptureCellContext {
  runDir: string;
  deviceLabel: string;
  index: number;
  locale?: string;
  fontScale?: number;
  density?: number;
  token?: CancellationLike;
}

export class CaptureService {
  constructor(private adb: AdbClient) {}

  private maxAspectRatio(): number {
    return vscode.workspace.getConfiguration(CONFIG.SECTION)
      .get<number>(CONFIG.CAPTURE_MAX_ASPECT_RATIO, DISPLAY_RULES.PLAY_MAX_ASPECT);
  }

  private settleDelay(): number {
    return vscode.workspace.getConfiguration(CONFIG.SECTION)
      .get<number>(CONFIG.CAPTURE_SETTLE_DELAY, 500);
  }

  /**
   * Capture one orientation and write it to disk.
   *
   * The orientation label always comes from the measured PNG dimensions, never
   * from the rotation constant we wrote: user_rotation is relative to the
   * device's *natural* orientation, which is landscape on tablets and many
   * foldables, so rotation 0 is not reliably portrait.
   */
  async captureCell(
    serial: string,
    rotation: 0 | 1,
    ctx: CaptureCellContext,
  ): Promise<CaptureResult> {
    await lockRotation(this.adb, serial, rotation);

    const frame = await waitForStableScreen(this.adb, serial, {
      tailMs: this.settleDelay(),
      token: ctx.token,
    });

    const dir = resolveLocaleDirectory(ctx.runDir, ctx.locale);
    const fileName = buildCaptureFileName({
      index: ctx.index,
      device: ctx.deviceLabel,
      orientation: frame.orientation,
      fontScale: ctx.fontScale,
      density: ctx.density,
    });
    const file = path.join(dir, fileName);
    fs.writeFileSync(file, frame.buf);

    const validation = validatePlayAsset(frame.width, frame.height, this.maxAspectRatio());
    const warnings = frame.warning ? [frame.warning] : [];

    Logger.info(`Captured ${file} (${frame.width}×${frame.height}, ${validation.level}).`);

    return {
      file,
      relPath: path.relative(ctx.runDir, file).split(path.sep).join('/'),
      width: frame.width,
      height: frame.height,
      orientation: frame.orientation,
      locale: ctx.locale,
      fontScale: ctx.fontScale,
      density: ctx.density,
      validation,
      warnings,
    };
  }

  /**
   * Capture the current screen in both orientations.
   *
   * If both rotations measure the same orientation the foreground app is
   * orientation-locked; the duplicate is dropped and reported, because a silent
   * duplicate file is far worse than a clear message.
   */
  async captureOrientations(
    serial: string,
    deviceLabel: string,
    runName: string,
    options: { useDemoMode: boolean; token?: CancellationLike; progress?: vscode.Progress<{ message?: string; increment?: number }> },
  ): Promise<{ results: CaptureResult[]; runDir: string; notes: string[] }> {
    const { dir: runDir } = resolveRunDirectory(runName);
    const notes: string[] = [];
    const results: CaptureResult[] = [];

    let rotationSnap: RotationSnapshot | undefined;
    const demo = new DemoModeController(this.adb);
    let demoEntered = false;

    try {
      rotationSnap = await snapshotRotation(this.adb, serial);

      if (options.useDemoMode && !DemoModeController.isActive(serial)) {
        try {
          await demo.enter(serial);
          demoEntered = true;
        } catch (err) {
          notes.push(`Screenshot mode unavailable: ${err instanceof Error ? err.message : err}`);
        }
      }

      const seen = new Set<Orientation>();
      const rotations: Array<0 | 1> = [0, 1];
      for (let i = 0; i < rotations.length; i++) {
        if (options.token?.isCancellationRequested) { throw new CaptureCancelledError(); }
        options.progress?.report({
          message: `${i + 1} of ${rotations.length}`,
          increment: 100 / rotations.length,
        });

        const result = await this.captureCell(serial, rotations[i], {
          runDir,
          deviceLabel,
          index: results.length + 1,
          token: options.token,
        });

        if (seen.has(result.orientation)) {
          try { fs.unlinkSync(result.file); } catch { /* ignore */ }
          notes.push(
            `The foreground app did not rotate — it is orientation-locked, so only ${result.orientation} was captured.`,
          );
          continue;
        }
        seen.add(result.orientation);
        results.push(result);
      }
    } finally {
      if (demoEntered) {
        try { await demo.exit(serial); } catch (err) { Logger.warn(`Could not exit demo mode: ${err}`); }
      }
      if (rotationSnap) {
        try { await restoreRotation(this.adb, serial, rotationSnap); }
        catch (err) { Logger.warn(`Could not restore rotation on ${serial}: ${err}`); }
      }
    }

    return { results, runDir, notes };
  }
}

export interface RunManifest {
  runName: string;
  startedAt: string;
  device: { serial: string; label: string; apiLevel?: number };
  packageName?: string;
  dimensions?: Record<string, unknown>;
  notes: string[];
  results: CaptureResult[];
}

/** Write manifest.json and report.md into a run folder. Returns the report path. */
export function writeRunReport(runDir: string, manifest: RunManifest): string {
  fs.writeFileSync(path.join(runDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf-8');

  const lines: string[] = [];
  lines.push(`# Capture run: ${manifest.runName}`);
  lines.push('');
  lines.push(`- **Device:** ${manifest.device.label} (\`${manifest.device.serial}\`)`);
  if (manifest.packageName) { lines.push(`- **App:** \`${manifest.packageName}\``); }
  lines.push(`- **Started:** ${manifest.startedAt}`);
  lines.push(`- **Screenshots:** ${manifest.results.length}`);

  const failed = manifest.results.filter(r => r.validation.level === 'fail').length;
  const warned = manifest.results.filter(r => r.validation.level === 'warn').length;
  if (failed) { lines.push(`- **Failed Play validation:** ${failed}`); }
  if (warned) { lines.push(`- **Warnings:** ${warned}`); }
  lines.push('');

  if (manifest.notes.length > 0) {
    lines.push('## Notes');
    lines.push('');
    for (const note of manifest.notes) { lines.push(`- ${note}`); }
    lines.push('');
  }

  lines.push('## Results');
  lines.push('');
  lines.push('| File | Locale | Font | Density | Size | Ratio | Status |');
  lines.push('| --- | --- | --- | --- | --- | --- | --- |');
  for (const r of manifest.results) {
    const status = r.validation.level === 'pass' ? 'pass'
      : `${r.validation.level}: ${r.validation.issues.join(' ')}`;
    lines.push(
      `| \`${r.relPath}\` | ${r.locale || '—'} | ${r.fontScale ?? '—'} | ${r.density ?? '—'} `
      + `| ${r.width}×${r.height} | ${r.validation.ratio.toFixed(2)}:1 | ${status} |`,
    );
  }
  lines.push('');

  const byLocale = new Map<string, CaptureResult[]>();
  for (const r of manifest.results) {
    const key = r.locale || 'default';
    const list = byLocale.get(key) || [];
    list.push(r);
    byLocale.set(key, list);
  }
  for (const [locale, shots] of byLocale) {
    lines.push(`## ${locale}`);
    lines.push('');
    if (shots.length > DISPLAY_RULES.PLAY_MAX_SHOTS_PER_LOCALE) {
      lines.push(`> ${shots.length} screenshots — Play accepts at most ${DISPLAY_RULES.PLAY_MAX_SHOTS_PER_LOCALE} per listing type.`);
      lines.push('');
    }
    for (const shot of shots) {
      lines.push(`### ${shot.relPath}`);
      lines.push('');
      lines.push(`![${shot.relPath}](./${shot.relPath})`);
      lines.push('');
    }
  }

  const reportPath = path.join(runDir, 'report.md');
  fs.writeFileSync(reportPath, lines.join('\n'), 'utf-8');
  return reportPath;
}

import { DISPLAY_RULES, DevicePreset, findPresetForAvd } from '../constants';

/**
 * Pure display analysis — no vscode, no fs, no adb. Everything it needs is
 * passed in, so it stays cheap enough to call from the tree provider on every
 * refresh and is trivially testable.
 */

export interface DisplaySpec {
  width: number;
  height: number;
  density: number;
}

export type DisplayIssueKind =
  | 'missing'              // hw.lcd.* absent — emulator will use AOSP defaults
  | 'aosp-default'         // exactly 320x640 — the bug fingerprint
  | 'too-small'            // short side below SANE_MIN_SHORT_SIDE
  | 'below-play-minimum'
  | 'above-play-maximum'
  | 'aspect-unusual'
  | 'density-implausible'
  | 'ram-implausible'
  | 'skin-conflict'        // skin.name / skin.path disagree with hw.lcd.*
  | 'runtime-override';    // adb wm size/density differs from config.ini

export interface DisplayIssue {
  kind: DisplayIssueKind;
  message: string;
  severity: 'error' | 'warning' | 'info';
}

export interface PlayScreenshotResult {
  /** Passes the practical upload rules (size bounds + max aspect). */
  ok: boolean;
  /** Passes the stricter documented promotional ratio too. */
  promoEligible: boolean;
  ratio: number;
  reasons: string[];
}

export interface RuntimeDisplay {
  size?: { w: number; h: number };
  override?: { w: number; h: number };
  density?: number;
  densityOverride?: number;
}

export interface DisplayReport {
  avdName: string;
  /** undefined when hw.lcd.* is missing entirely. */
  config?: DisplaySpec;
  runtime?: RuntimeDisplay;
  /** hw.ramSize in MB, 0 when absent. */
  ramMb: number;
  issues: DisplayIssue[];
  /** No 'error'-severity issues. */
  healthy: boolean;
  /** "1280×2856 @ 480 dpi" or "no display configured" */
  summary: string;
  play: PlayScreenshotResult;
  suggestion?: DisplaySpec;
  suggestionSource: 'preset' | 'none';
  suggestedPreset?: DevicePreset;
}

/**
 * Play Console phone-screenshot rules.
 *
 * `ok` uses the practical limits (320–3840 px per side, long/short <= 2:1).
 * `promoEligible` additionally applies the documented 16:9 ratio, which every
 * current Pixel fails — hence the two-tier result rather than one boolean.
 */
export function playScreenshotCheck(width: number, height: number): PlayScreenshotResult {
  const reasons: string[] = [];
  if (!width || !height) {
    return { ok: false, promoEligible: false, ratio: 0, reasons: ['Display size is unknown.'] };
  }

  const short = Math.min(width, height);
  const long = Math.max(width, height);
  const ratio = long / short;

  if (short < DISPLAY_RULES.PLAY_MIN_SIDE) {
    reasons.push(`Short side ${short}px is below the ${DISPLAY_RULES.PLAY_MIN_SIDE}px minimum.`);
  }
  if (long > DISPLAY_RULES.PLAY_MAX_SIDE) {
    reasons.push(`Long side ${long}px is above the ${DISPLAY_RULES.PLAY_MAX_SIDE}px maximum.`);
  }
  if (ratio > DISPLAY_RULES.PLAY_MAX_ASPECT) {
    reasons.push(`Aspect ratio ${ratio.toFixed(2)}:1 exceeds the ${DISPLAY_RULES.PLAY_MAX_ASPECT}:1 upload limit.`);
  }

  const ok = reasons.length === 0;
  const promoEligible = ok && ratio <= DISPLAY_RULES.PLAY_PROMO_ASPECT + 0.01;
  if (ok && !promoEligible) {
    reasons.push(
      `Aspect ratio ${ratio.toFixed(2)}:1 is taller than 16:9 — accepted for upload, ` +
      'but not eligible for Play Store promotional placement.',
    );
  }

  return { ok, promoEligible, ratio, reasons };
}

/**
 * One-line, non-alarming summary of the Play screenshot situation.
 *
 * Deliberately phrased as guidance about screenshots, not as a verdict on the
 * AVD: a correctly configured Pixel 9 Pro is 2.23:1, and calling that
 * "rejected" next to "no issues found" reads as a contradiction.
 */
export function describePlayResult(play: PlayScreenshotResult): string {
  if (play.ratio === 0) { return 'unknown — the display size could not be read.'; }
  const ratio = play.ratio.toFixed(2) + ':1';
  if (!play.ok) {
    return `${ratio} — full-resolution screenshots exceed Play's limits and need resizing before upload `
      + `(${play.reasons.join(' ')})`;
  }
  if (!play.promoEligible) {
    return `${ratio} — accepted by Play, but not eligible for promotional placement (that needs 16:9).`;
  }
  return `${ratio} — within Play's limits.`;
}

/** Parse a `WxH` skin name, e.g. "1080x2400". */
function parseSkinName(name: string | undefined): { w: number; h: number } | undefined {
  const m = name?.match(/^(\d+)\s*[xX×]\s*(\d+)$/);
  return m ? { w: parseInt(m[1], 10), h: parseInt(m[2], 10) } : undefined;
}

/** hw.ramSize is written as either "2048" or the legacy "2048M". */
export function parseRamMb(raw: string | undefined): number {
  const n = parseInt((raw || '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function analyzeDisplay(
  config: Record<string, string>,
  avdName: string,
  runtime?: RuntimeDisplay,
  opts?: { strictPlayAspect?: boolean; skinPathExists?: (p: string) => boolean },
): DisplayReport {
  const issues: DisplayIssue[] = [];

  const width = parseInt(config['hw.lcd.width'] || '0', 10) || 0;
  const height = parseInt(config['hw.lcd.height'] || '0', 10) || 0;
  const density = parseInt(config['hw.lcd.density'] || '0', 10) || 0;
  const ramMb = parseRamMb(config['hw.ramSize']);

  const spec: DisplaySpec | undefined = width && height ? { width, height, density } : undefined;

  if (!spec) {
    issues.push({
      kind: 'missing',
      severity: 'error',
      message: 'No display is configured — the emulator will fall back to 320×640.',
    });
  } else {
    const short = Math.min(width, height);
    const long = Math.max(width, height);
    const ratio = long / short;

    if (width === DISPLAY_RULES.AOSP_FALLBACK_WIDTH && height === DISPLAY_RULES.AOSP_FALLBACK_HEIGHT) {
      issues.push({
        kind: 'aosp-default',
        severity: 'error',
        message: 'Display is the emulator\'s 320×640 fallback, not a real device size.',
      });
    } else if (short < DISPLAY_RULES.SANE_MIN_SHORT_SIDE) {
      issues.push({
        kind: 'too-small',
        severity: 'error',
        message: `Short side is only ${short}px — smaller than any shipping Android device.`,
      });
    }

    if (short < DISPLAY_RULES.PLAY_MIN_SIDE) {
      issues.push({
        kind: 'below-play-minimum',
        severity: 'error',
        message: `Screenshots would be ${short}px on the short side, below Play's ${DISPLAY_RULES.PLAY_MIN_SIDE}px minimum.`,
      });
    }
    if (long > DISPLAY_RULES.PLAY_MAX_SIDE) {
      issues.push({
        kind: 'above-play-maximum',
        severity: 'error',
        message: `Screenshots would be ${long}px on the long side, above Play's ${DISPLAY_RULES.PLAY_MAX_SIDE}px maximum.`,
      });
    }
    if (ratio > DISPLAY_RULES.SANE_MAX_ASPECT) {
      issues.push({
        kind: 'aspect-unusual',
        severity: 'warning',
        message: `Aspect ratio ${ratio.toFixed(2)}:1 is unusually tall for a real device.`,
      });
    }
    if (density && (density < DISPLAY_RULES.SANE_MIN_DENSITY || density > DISPLAY_RULES.SANE_MAX_DENSITY)) {
      issues.push({
        kind: 'density-implausible',
        severity: 'warning',
        message: `Density ${density} dpi is outside the plausible ${DISPLAY_RULES.SANE_MIN_DENSITY}–${DISPLAY_RULES.SANE_MAX_DENSITY} range.`,
      });
    }

    // The skin layout wins at runtime, so a mismatched skin silently overrides
    // a corrected hw.lcd.* — the second-most-common way a "fixed" AVD boots wrong.
    const skinPath = config['skin.path'];
    const skinSize = parseSkinName(config['skin.name']);
    const skinIsReal = !!skinPath && skinPath !== '_no_skin'
      && (opts?.skinPathExists ? opts.skinPathExists(skinPath) : true);
    if (skinIsReal && skinSize && (skinSize.w !== width || skinSize.h !== height)) {
      issues.push({
        kind: 'skin-conflict',
        severity: 'error',
        message: `Skin "${config['skin.name']}" (${skinSize.w}×${skinSize.h}) disagrees with the configured ${width}×${height} and will win at runtime.`,
      });
    }
  }

  if (ramMb && ramMb <= DISPLAY_RULES.AOSP_FALLBACK_RAM_MB) {
    issues.push({
      kind: 'ram-implausible',
      severity: 'error',
      message: `Only ${ramMb} MB of RAM is configured — Android cannot finish booting and will appear to hang.`,
    });
  }

  if (runtime?.override && spec
      && (runtime.override.w !== spec.width || runtime.override.h !== spec.height)) {
    issues.push({
      kind: 'runtime-override',
      severity: 'warning',
      message: `A temporary "wm size" override of ${runtime.override.w}×${runtime.override.h} is active; it is lost on wipe.`,
    });
  }
  if (runtime?.densityOverride && runtime.densityOverride !== runtime.density) {
    issues.push({
      kind: 'runtime-override',
      severity: 'warning',
      message: `A temporary "wm density" override of ${runtime.densityOverride} dpi is active.`,
    });
  }

  const play = spec
    ? playScreenshotCheck(spec.width, spec.height)
    : playScreenshotCheck(0, 0);

  if (opts?.strictPlayAspect && spec && !play.promoEligible) {
    issues.push({
      kind: 'aspect-unusual',
      severity: 'error',
      message: `Aspect ratio ${play.ratio.toFixed(2)}:1 is outside Play's documented 16:9 range.`,
    });
  }

  const suggestedPreset = findPresetForAvd(config, avdName);
  const suggestion: DisplaySpec | undefined = suggestedPreset
    ? { width: suggestedPreset.width, height: suggestedPreset.height, density: suggestedPreset.density }
    : undefined;

  const summary = spec
    ? `${spec.width}×${spec.height}${spec.density ? ` @ ${spec.density} dpi` : ''}`
    : 'no display configured';

  return {
    avdName,
    config: spec,
    runtime,
    ramMb,
    issues,
    healthy: !issues.some(i => i.severity === 'error'),
    summary,
    play,
    suggestion,
    suggestionSource: suggestion ? 'preset' : 'none',
    suggestedPreset,
  };
}

/** Multi-line detail for the output channel. */
export function formatDisplayReport(report: DisplayReport): string {
  const lines: string[] = [`Display check — ${report.avdName}`];
  lines.push(`  Configured: ${report.summary}`);
  lines.push(`  RAM: ${report.ramMb ? `${report.ramMb} MB` : 'not set (emulator default)'}`);
  if (report.runtime) {
    const r = report.runtime;
    if (r.size) { lines.push(`  Runtime physical size: ${r.size.w}×${r.size.h}`); }
    if (r.override) { lines.push(`  Runtime override size: ${r.override.w}×${r.override.h}`); }
    if (r.density) { lines.push(`  Runtime physical density: ${r.density} dpi`); }
    if (r.densityOverride) { lines.push(`  Runtime override density: ${r.densityOverride} dpi`); }
  }
  lines.push(`  Play screenshots: ${describePlayResult(report.play)}`);
  if (report.issues.length === 0) {
    lines.push('  No issues found.');
  } else {
    for (const issue of report.issues) {
      lines.push(`  [${issue.severity}] ${issue.message}`);
    }
  }
  if (report.issues.length > 0 && report.suggestion && report.suggestedPreset) {
    lines.push(`  Suggested fix: ${report.suggestion.width}×${report.suggestion.height} @ ${report.suggestion.density} dpi (${report.suggestedPreset.name})`);
  }
  return lines.join('\n');
}

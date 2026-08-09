import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { CONFIG } from '../constants';
import { Logger } from '../utils/Logger';

/**
 * Resolves where capture runs are written. This is the extension's only
 * workspace-aware code, so the fallbacks matter: losing a capture because the
 * user happened to open a loose file would be unacceptable. Never throws.
 */

export interface CaptureRoot {
  dir: string;
  /** True when the configured location could not be used and we fell back. */
  usedFallback: boolean;
}

const FALLBACK_DIR_NAME = 'CaspianCaptures';

/** The workspace folder a capture should be anchored to. */
function anchorFolder(): vscode.WorkspaceFolder | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active) {
    const owner = vscode.workspace.getWorkspaceFolder(active);
    if (owner) { return owner; }
  }
  return vscode.workspace.workspaceFolders?.[0];
}

export function resolveCaptureRoot(): CaptureRoot {
  const configured = vscode.workspace.getConfiguration(CONFIG.SECTION)
    .get<string>(CONFIG.CAPTURE_DIRECTORY, '${workspaceFolder}/.caspian/captures')
    .trim();

  const anchor = anchorFolder();
  let usedFallback = false;
  let raw = configured || '${workspaceFolder}/.caspian/captures';

  if (raw.includes('${workspaceFolder}')) {
    if (anchor) {
      raw = raw.replace(/\$\{workspaceFolder\}/g, anchor.uri.fsPath);
    } else {
      raw = path.join(os.homedir(), FALLBACK_DIR_NAME);
      usedFallback = true;
    }
  }

  raw = raw.replace(/\$\{userHome\}/g, os.homedir());
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    raw = path.join(os.homedir(), raw.slice(2));
  }

  let dir = path.isAbsolute(raw)
    ? raw
    : path.resolve(anchor ? anchor.uri.fsPath : os.homedir(), raw);

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    Logger.warn(`Could not create capture directory ${dir} (${err}); falling back to the home folder.`);
    dir = path.join(os.homedir(), FALLBACK_DIR_NAME);
    usedFallback = true;
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* last resort — writes will report */ }
  }

  return { dir, usedFallback };
}

/**
 * Reduce a user-typed run name to a single safe path segment.
 * Rejects separators outright rather than stripping them, so "../../etc"
 * fails loudly instead of silently becoming something else.
 */
export function sanitizeRunName(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) { throw new Error('Run name cannot be empty.'); }
  if (/[\\/]/.test(trimmed)) { throw new Error('Run name cannot contain path separators.'); }
  if (trimmed === '.' || trimmed === '..') { throw new Error('Run name is not a valid folder name.'); }
  const cleaned = trimmed.replace(/[^A-Za-z0-9._-]/g, '-').replace(/-{2,}/g, '-');
  if (!cleaned || /^[.-]+$/.test(cleaned)) { throw new Error('Run name must contain letters or numbers.'); }
  return cleaned;
}

/** Create (and return) the folder for a capture run. */
export function resolveRunDirectory(runName: string): { dir: string; root: CaptureRoot } {
  const root = resolveCaptureRoot();
  const safe = sanitizeRunName(runName);
  const dir = path.resolve(root.dir, safe);
  if (dir !== root.dir && !dir.startsWith(root.dir + path.sep)) {
    throw new Error('Run name resolved outside the capture directory.');
  }
  fs.mkdirSync(dir, { recursive: true });
  return { dir, root };
}

/** A locale subfolder inside a run — mirrors Play Console's per-language upload. */
export function resolveLocaleDirectory(runDir: string, locale?: string): string {
  if (!locale) { return runDir; }
  const safe = locale.replace(/[^A-Za-z0-9_-]/g, '-');
  const dir = path.join(runDir, safe);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export interface CaptureFileNameParts {
  index: number;
  device: string;
  orientation: 'portrait' | 'landscape';
  fontScale?: number;
  density?: number;
}

/**
 * Build a capture filename. Optional segments appear only when that dimension
 * actually varies, so a single-axis run does not produce noisy names.
 */
export function buildCaptureFileName(parts: CaptureFileNameParts): string {
  const slug = parts.device.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'device';
  const segments = [String(parts.index).padStart(2, '0'), slug, parts.orientation];
  if (parts.fontScale !== undefined) { segments.push(`fs${parts.fontScale}`); }
  if (parts.density !== undefined) { segments.push(`dpi${parts.density}`); }
  return `${segments.join('_')}.png`;
}

/** Default run name, e.g. "run-20260809-1432". Timestamps are local. */
export function suggestRunName(now: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `run-${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}`;
}

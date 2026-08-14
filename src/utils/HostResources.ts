import { execFile } from 'child_process';
import * as os from 'os';
import * as fs from 'fs';
import { LAUNCH_PREFLIGHT } from '../constants';
import { Logger } from './Logger';

/**
 * Host machine resource probes. No vscode import — this is pure measurement.
 */

export interface HostMemory {
  totalMb: number;
  availableMb: number;
  source: 'os.freemem' | 'linux-meminfo' | 'darwin-vmstat';
}

export interface HostProcess {
  name: string;
  /**
   * Every pid in the group, not just the first.
   *
   * Rows are aggregated by name, and a build routinely leaves two or three
   * daemons resident — a remedy that killed only `pids[0]` would report
   * success while most of the memory stayed held.
   */
  pids: number[];
  mb: number;
  /** How many processes with this name were aggregated. */
  count: number;
  /** "Gradle daemon" / "Kotlin compile daemon" when identified. */
  label?: string;
}

export interface AccelStatus {
  ok: boolean;
  message: string;
  raw: string;
}

function execFileP(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (err, stdout) => {
      if (err && !stdout) { reject(err); return; }
      resolve(stdout || '');
    });
  });
}

/**
 * Free physical memory available to a new process.
 *
 * On win32, os.freemem() is already the right number: libuv's
 * uv_get_free_memory() calls GlobalMemoryStatusEx() and returns ullAvailPhys —
 * the standby + free + zero lists, i.e. exactly Task Manager's "Available".
 * Shelling PowerShell for it would cost 300-800ms per launch for no gain.
 *
 * Linux is the platform where os.freemem() genuinely misleads (it reports
 * MemFree, excluding reclaimable page cache), so read MemAvailable there.
 */
export async function getHostMemory(): Promise<HostMemory> {
  const totalMb = Math.round(os.totalmem() / 1048576);

  if (process.platform === 'linux') {
    try {
      const text = await fs.promises.readFile('/proc/meminfo', 'utf-8');
      const kb = (key: string) => Number(text.match(new RegExp(`^${key}:\\s+(\\d+) kB`, 'm'))?.[1] ?? 0);
      const avail = kb('MemAvailable') || (kb('MemFree') + kb('Buffers') + kb('Cached'));
      if (avail > 0) {
        return { totalMb, availableMb: Math.round(avail / 1024), source: 'linux-meminfo' };
      }
    } catch { /* fall through to os.freemem */ }
  }

  if (process.platform === 'darwin') {
    try {
      const out = await execFileP('vm_stat', [], 2000);
      const pageSize = Number(out.match(/page size of (\d+) bytes/)?.[1] ?? 4096);
      const stat = (key: string) => Number(out.match(new RegExp(`${key}:\\s+(\\d+)\\.`))?.[1] ?? 0);
      const pages = stat('Pages free') + stat('Pages inactive')
        + stat('Pages speculative') + stat('Pages purgeable');
      if (pages > 0) {
        return { totalMb, availableMb: Math.round(pages * pageSize / 1048576), source: 'darwin-vmstat' };
      }
    } catch { /* fall through to os.freemem */ }
  }

  return { totalMb, availableMb: Math.round(os.freemem() / 1048576), source: 'os.freemem' };
}

const WIN_PROCESS_SCRIPT = [
  '$j=@{};',
  "try { Get-CimInstance Win32_Process -Filter \"Name LIKE 'java%'\" -EA SilentlyContinue |",
  '      ForEach-Object { $j[[int]$_.ProcessId] = $_.CommandLine } } catch {};',
  'Get-Process | Sort-Object WorkingSet64 -Descending | Select-Object -First 15 | ForEach-Object {',
  "  $tag='';",
  "  if ($j.ContainsKey($_.Id) -and $j[$_.Id] -match 'GradleDaemon|org\\.gradle\\.launcher') { $tag='gradle' }",
  "  elseif ($j.ContainsKey($_.Id) -and $j[$_.Id] -match 'KotlinCompileDaemon') { $tag='kotlin' };",
  '  "$($_.ProcessName)|$($_.Id)|$($_.WorkingSet64)|$tag"',
  '}',
].join(' ');

const TAG_LABELS: Record<string, string> = {
  gradle: 'Gradle daemon',
  kotlin: 'Kotlin compile daemon',
};

/**
 * Top host memory consumers, aggregated by process name so three Gradle
 * daemons collapse into one line. Best-effort: returns [] on any failure and
 * the caller degrades to a message without the process list.
 */
export async function getTopMemoryConsumers(
  limit = LAUNCH_PREFLIGHT.TOP_PROCESS_COUNT,
  timeoutMs = LAUNCH_PREFLIGHT.PROCESS_QUERY_TIMEOUT_MS,
): Promise<HostProcess[]> {
  const rows: Array<{ name: string; pid: number; bytes: number; tag: string }> = [];

  try {
    if (process.platform === 'win32') {
      // Line-oriented pipe-delimited output: no CSV quoting, and no PS 5.1
      // ConvertTo-Json single-vs-array weirdness. -NoProfile matters, or a
      // user's profile script pollutes stdout and breaks parsing.
      const out = await execFileP(
        'powershell',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', WIN_PROCESS_SCRIPT],
        timeoutMs,
      );
      for (const line of out.split(/\r?\n/)) {
        const parts = line.trim().split('|');
        if (parts.length < 3) { continue; }
        const bytes = Number(parts[2]);
        if (!Number.isFinite(bytes)) { continue; }
        rows.push({ name: parts[0], pid: Number(parts[1]) || 0, bytes, tag: parts[3] || '' });
      }
    } else {
      // rss is in KB on both linux and darwin.
      const out = await execFileP('ps', ['-axo', 'comm=,pid=,rss=,args='], timeoutMs);
      for (const line of out.split('\n')) {
        const m = line.trim().match(/^(\S+)\s+(\d+)\s+(\d+)\s*(.*)$/);
        if (!m) { continue; }
        const args = m[4] || '';
        const tag = /GradleDaemon|org\.gradle\.launcher/.test(args) ? 'gradle'
          : /KotlinCompileDaemon/.test(args) ? 'kotlin' : '';
        rows.push({
          name: m[1].split('/').pop() || m[1],
          pid: Number(m[2]),
          bytes: Number(m[3]) * 1024,
          tag,
        });
      }
    }
  } catch (err) {
    Logger.warn(`Could not enumerate host processes: ${err}`);
    return [];
  }

  const grouped = new Map<string, HostProcess>();
  for (const row of rows) {
    const key = `${row.name}|${row.tag}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.mb += row.bytes / 1048576;
      existing.count += 1;
      if (row.pid) { existing.pids.push(row.pid); }
    } else {
      grouped.set(key, {
        name: row.name,
        pids: row.pid ? [row.pid] : [],
        mb: row.bytes / 1048576,
        count: 1,
        label: TAG_LABELS[row.tag],
      });
    }
  }

  return [...grouped.values()]
    .map(p => ({ ...p, mb: Math.round(p.mb) }))
    .sort((a, b) => b.mb - a.mb)
    .slice(0, limit);
}

/** Labels this module is willing to terminate. Never an arbitrary process. */
const KILLABLE_LABELS = new Set(['Gradle daemon', 'Kotlin compile daemon']);

/** Build daemons still resident, i.e. what `gradlew --stop` failed to clear. */
export function residentBuildDaemons(procs: HostProcess[]): HostProcess[] {
  return procs.filter(p => p.label && KILLABLE_LABELS.has(p.label) && p.pids.length > 0);
}

/**
 * Terminate the enumerated build daemons by pid.
 *
 * `gradlew --stop` speaks to the Gradle daemon registry, which the Kotlin
 * compile daemon is not in — it routinely survives with a gigabyte held, and
 * there is no wrapper command that stops it. Killing it is safe: it is a
 * disposable cache that the next build restarts.
 *
 * Restricted to labelled entries by `residentBuildDaemons`, so a bad label
 * match can never take out an unrelated process. Returns how many died.
 */
export function killBuildDaemons(procs: HostProcess[]): { killed: number; failed: number } {
  let killed = 0;
  let failed = 0;
  for (const proc of residentBuildDaemons(procs)) {
    for (const pid of proc.pids) {
      try {
        process.kill(pid);
        killed++;
      } catch (err) {
        // ESRCH means it already exited, which is the outcome we wanted.
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') { killed++; } else {
          failed++;
          Logger.warn(`Could not stop ${proc.name} (pid ${pid}): ${err}`);
        }
      }
    }
  }
  return { killed, failed };
}

/** Format bytes-as-MB for user-facing text. */
export function formatMb(mb: number): string {
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

let accelCache: AccelStatus | undefined;

/**
 * Ask the emulator whether hardware acceleration is usable.
 * Cached for the session — hypervisor state does not change mid-session.
 */
export async function checkAcceleration(
  runRaw: (args: string[], timeoutMs: number) => Promise<{ code: number; stdout: string; stderr: string }>,
  force = false,
): Promise<AccelStatus> {
  if (accelCache && !force) { return accelCache; }

  try {
    const res = await runRaw(['-accel-check'], LAUNCH_PREFLIGHT.ACCEL_CHECK_TIMEOUT_MS);
    const raw = `${res.stdout}\n${res.stderr}`.trim();
    // The diagnosis is on stdout even when the exit code is non-zero.
    const message = raw.split('\n').map(l => l.trim()).filter(Boolean).pop() || 'No output from emulator -accel-check.';
    const status: AccelStatus = { ok: res.code === 0, message, raw };
    accelCache = status;
    return status;
  } catch (err) {
    // Never let a probe failure block a launch.
    const status: AccelStatus = { ok: true, message: `Acceleration check failed: ${err}`, raw: String(err) };
    accelCache = status;
    return status;
  }
}

/** Drop the cached acceleration result (used by the explicit check command). */
export function clearAccelerationCache(): void {
  accelCache = undefined;
}

import * as vscode from 'vscode';
import { execFile } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { AvdManager } from './AvdManager';
import { parseRamMb } from './DisplayCheck';
import { CONFIG, LAUNCH_PREFLIGHT } from '../constants';
import {
  HostMemory,
  HostProcess,
  checkAcceleration,
  formatMb,
  getHostMemory,
  getTopMemoryConsumers,
  killBuildDaemons,
  residentBuildDaemons,
} from '../utils/HostResources';
import { Logger } from '../utils/Logger';

export interface RamVerdict {
  avdRamMb: number;
  requiredMb: number;
  availableMb: number;
  totalMb: number;
  verdict: 'ok' | 'tight' | 'insufficient';
  /** True when hw.ramSize was absent and we assumed a default. */
  assumedRam: boolean;
}

export function evaluateRam(
  avdRamMb: number,
  mem: HostMemory,
  headroomMb: number,
  assumedRam: boolean,
): RamVerdict {
  const requiredMb = avdRamMb + LAUNCH_PREFLIGHT.EMULATOR_OVERHEAD_MB;
  let verdict: RamVerdict['verdict'] = 'ok';
  if (mem.availableMb < requiredMb) { verdict = 'insufficient'; }
  else if (mem.availableMb < requiredMb + headroomMb) { verdict = 'tight'; }
  return { avdRamMb, requiredMb, availableMb: mem.availableMb, totalMb: mem.totalMb, verdict, assumedRam };
}

function describeProcesses(procs: HostProcess[]): string {
  if (procs.length === 0) { return ''; }
  const lines = procs.map(p => {
    const count = p.count > 1 ? ` ×${p.count}` : '';
    const label = p.label ? `  (${p.label})` : '';
    return `  ${p.name}${count} — ${formatMb(p.mb)}${label}`;
  });
  return `\n\nTop memory users:\n${lines.join('\n')}`;
}

/**
 * Label for the daemon remedy action.
 *
 * "Build" rather than "Gradle": the remedy now also stops the Kotlin compile
 * daemon, which is usually the one actually holding the memory.
 */
const STOP_DAEMONS = 'Stop Build Daemons';

/** Find a Gradle wrapper in any open workspace folder. */
export function findGradleWrapper(): { dir: string; script: string } | undefined {
  const script = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const candidate = path.join(folder.uri.fsPath, script);
    try {
      if (fs.existsSync(candidate)) { return { dir: folder.uri.fsPath, script: candidate }; }
    } catch { /* keep looking */ }
  }
  return undefined;
}

export function stopGradleDaemons(wrapper: { dir: string; script: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(wrapper.script, ['--stop'], { cwd: wrapper.dir, timeout: 30000, windowsHide: true }, (err) => {
      if (err) { reject(err); } else { resolve(); }
    });
  });
}

/**
 * Re-read available memory once the OS has caught up with a process exit.
 *
 * Both `gradlew --stop` and `process.kill` return before the processes are
 * actually gone, so an immediate sample still shows the memory held and the
 * remedy reports failure it did not have. Poll briefly and keep the best
 * reading: memory is being released, so the maximum is the truest value.
 */
async function measureAfterTeardown(): Promise<number> {
  let best = (await getHostMemory()).availableMb;
  for (let i = 0; i < DAEMON_SETTLE_SAMPLES; i++) {
    await new Promise(r => setTimeout(r, DAEMON_SETTLE_MS));
    const next = (await getHostMemory()).availableMb;
    if (next > best) { best = next; }
  }
  return best;
}

/** Poll cadence for measureAfterTeardown: 4 samples over ~2 seconds. */
const DAEMON_SETTLE_MS = 500;
const DAEMON_SETTLE_SAMPLES = 4;

/**
 * Run the "stop the build daemons" remedy and report what it actually achieved.
 *
 * Two things this must not do. It must not infer success from the exit code:
 * `gradlew --stop` exits 0 having stopped nothing. And it must not stay silent
 * when nothing was freed — silence after a remedy reads as success, which is
 * worse than offering no remedy at all, because the user concludes memory is no
 * longer the problem and goes looking somewhere else.
 *
 * `gradlew --stop` reaches the Gradle daemon registry only. A Kotlin compile
 * daemon holding a gigabyte survives it, so when memory does not move, offer to
 * terminate whatever is still resident by pid.
 *
 * Returns the memory available afterwards, so callers can re-evaluate.
 */
export async function runDaemonRemedy(
  wrapper: { dir: string; script: string } | undefined,
  beforeMb: number,
): Promise<number> {
  if (wrapper) {
    try {
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Stopping Gradle daemons...', cancellable: false },
        () => stopGradleDaemons(wrapper),
      );
    } catch (err) {
      vscode.window.showWarningMessage(`Could not stop Gradle daemons: ${err}`);
    }
  }

  let availableMb = await measureAfterTeardown();
  if (availableMb - beforeMb > 0) {
    vscode.window.showInformationMessage(
      `Freed ${formatMb(availableMb - beforeMb)}. Now ${formatMb(availableMb)} available.`,
    );
    return availableMb;
  }

  // Nothing moved. Name what is still holding the memory.
  const survivors = residentBuildDaemons(await getTopMemoryConsumers());
  if (survivors.length === 0) {
    vscode.window.showWarningMessage(
      `${wrapper ? '"gradlew --stop" freed no memory' : 'No memory was freed'} — `
      + `still ${formatMb(availableMb)} available. No build daemons are left to stop.`,
    );
    return availableMb;
  }

  const held = survivors.reduce((sum, p) => sum + p.mb, 0);
  const names = survivors.map(p => `${p.label}${p.count > 1 ? ` ×${p.count}` : ''} (${formatMb(p.mb)})`).join(', ');
  const choice = await vscode.window.showWarningMessage(
    `"gradlew --stop" freed no memory — ${names} ${survivors.length > 1 ? 'are' : 'is'} still running, `
    + `holding ${formatMb(held)}.`,
    'Stop Remaining Build Daemons',
    'Show Details',
  );

  if (choice === 'Show Details') {
    Logger.show();
  } else if (choice === 'Stop Remaining Build Daemons') {
    const { killed, failed } = killBuildDaemons(survivors);
    availableMb = await measureAfterTeardown();
    const freed = availableMb - beforeMb;
    if (freed > 0) {
      vscode.window.showInformationMessage(
        `Stopped ${killed} build daemon${killed === 1 ? '' : 's'}, freeing ${formatMb(freed)}. `
        + `Now ${formatMb(availableMb)} available.`,
      );
    } else {
      vscode.window.showWarningMessage(
        `Stopped ${killed} build daemon${killed === 1 ? '' : 's'}${failed ? ` (${failed} could not be stopped)` : ''}, `
        + `but memory has not recovered — still ${formatMb(availableMb)} available.`,
      );
    }
  }

  return availableMb;
}

/**
 * Warn before launching when the host cannot supply the RAM the AVD asked for,
 * or when hardware acceleration is unavailable — the two failure modes that
 * otherwise present as an emulator that silently hangs mid-boot.
 *
 * Returns false only when the user explicitly cancelled. Never hard-blocks:
 * the overhead figure is a heuristic, not a measurement.
 */
export async function runLaunchPreflight(
  avdManager: AvdManager,
  avdName: string,
): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration(CONFIG.SECTION);
  const checkMemory = cfg.get<boolean>(CONFIG.CHECK_HOST_MEMORY, true);
  const checkAccel = cfg.get<boolean>(CONFIG.CHECK_ACCELERATION, true);
  if (!checkMemory && !checkAccel) { return true; }

  const accelPromise = checkAccel
    ? checkAcceleration((args, timeoutMs) => avdManager.execEmulatorRaw(args, timeoutMs))
    : Promise.resolve(undefined);

  if (checkMemory) {
    const config = avdManager.readAvdConfig(avdName);
    const rawRam = parseRamMb(config['hw.ramSize']);
    const assumedRam = rawRam < 256;
    const avdRamMb = assumedRam ? LAUNCH_PREFLIGHT.DEFAULT_AVD_RAM_MB : rawRam;

    const mem = await getHostMemory();
    // Some containers misreport total memory; a check against 0 is nonsense.
    if (mem.totalMb > 0) {
      const headroomMb = cfg.get<number>(CONFIG.MEMORY_HEADROOM_MB, LAUNCH_PREFLIGHT.DEFAULT_HEADROOM_MB);
      let verdict = evaluateRam(avdRamMb, mem, headroomMb, assumedRam);

      if (verdict.verdict !== 'ok') {
        const proceed = await presentMemoryWarning(avdName, verdict, async () => {
          const fresh = await getHostMemory();
          verdict = evaluateRam(avdRamMb, fresh, headroomMb, assumedRam);
          return verdict;
        });
        if (!proceed) { return false; }
      }
    }
  }

  const accel = await accelPromise;
  if (accel && !accel.ok) {
    const extra = process.platform === 'win32'
      ? '\n\nEnable "Windows Hypervisor Platform" and "Virtual Machine Platform" in Windows Features, then reboot.'
      : '';
    const choice = await vscode.window.showWarningMessage(
      'Hardware acceleration is unavailable.',
      {
        modal: true,
        detail: 'The emulator will run in software mode and may appear to hang for several '
          + `minutes, or fail to start.\n\n${accel.message}${extra}`,
      },
      'Launch Anyway', 'How to Fix',
    );
    if (choice === 'How to Fix') {
      vscode.env.openExternal(vscode.Uri.parse('https://developer.android.com/studio/run/emulator-acceleration'));
      return false;
    }
    if (choice !== 'Launch Anyway') { return false; }
  }

  return true;
}

async function presentMemoryWarning(
  avdName: string,
  verdict: RamVerdict,
  remeasure: () => Promise<RamVerdict>,
): Promise<boolean> {
  const cfg = vscode.workspace.getConfiguration(CONFIG.SECTION);

  const buildDetail = (v: RamVerdict, procs: HostProcess[]): string => {
    const assumed = v.assumedRam
      ? '\nThis AVD has no hw.ramSize setting, so 1536 MB was assumed.'
      : '';
    return `Needs about ${formatMb(v.requiredMb)} `
      + `(${formatMb(v.avdRamMb)} AVD RAM + ${formatMb(LAUNCH_PREFLIGHT.EMULATOR_OVERHEAD_MB)} emulator overhead).\n`
      + `Only ${formatMb(v.availableMb)} of ${formatMb(v.totalMb)} is currently available.${assumed}`
      + describeProcesses(procs);
  };

  // 'tight' is a non-modal toast: dismissing it must not eat the launch.
  if (verdict.verdict === 'tight') {
    // Offer the daemon remedy here too, not only at 'insufficient'. A resident
    // Gradle daemon plus an emulator fits at launch and then stops fitting the
    // moment a build starts — which is the common way this actually goes wrong.
    const procs = await getTopMemoryConsumers();
    // Gated on a daemon being resident, not on finding a wrapper: without a
    // wrapper the remedy skips `gradlew --stop` and terminates by pid instead,
    // which is the only thing that clears a Kotlin daemon anyway.
    const hasDaemon = procs.some(p => p.label === 'Gradle daemon' || p.label === 'Kotlin compile daemon');
    const wrapper = hasDaemon ? findGradleWrapper() : undefined;

    const choice = await vscode.window.showWarningMessage(
      `Memory is tight for "${avdName}" — ${formatMb(verdict.availableMb)} free, ~${formatMb(verdict.requiredMb)} needed.`,
      ...(hasDaemon ? [STOP_DAEMONS] : []),
      'Launch Anyway',
      "Don't Warn Again",
    );
    if (choice === STOP_DAEMONS) {
      await runDaemonRemedy(wrapper, verdict.availableMb);
      await remeasure();
    }
    if (choice === "Don't Warn Again") {
      await cfg.update(CONFIG.CHECK_HOST_MEMORY, false, vscode.ConfigurationTarget.Global);
    }
    return true;
  }

  let current = verdict;
  for (;;) {
    const procs = await getTopMemoryConsumers();
    const detail = buildDetail(current, procs);
    Logger.warn(`Launch pre-flight for ${avdName}:\n${detail}`);

    // Both daemon kinds, matching the 'tight' tier above: a machine with a
    // resident Kotlin daemon and no Gradle daemon was offered the remedy on the
    // mild warning and not on this, the severe one.
    const hasDaemon = procs.some(p => p.label === 'Gradle daemon' || p.label === 'Kotlin compile daemon');
    const wrapper = hasDaemon ? findGradleWrapper() : undefined;
    const actions = [
      ...(hasDaemon ? [STOP_DAEMONS] : []),
      'Launch Anyway',
      'Show Details',
      "Don't Warn Again",
    ];

    const choice = await vscode.window.showWarningMessage(
      `Not enough free memory to launch "${avdName}".`,
      { modal: true, detail },
      ...actions,
    );

    if (choice === STOP_DAEMONS) {
      await runDaemonRemedy(wrapper, current.availableMb);
      current = await remeasure();
      if (current.verdict === 'ok') { return true; }
      continue;   // re-present with the updated numbers
    }

    if (choice === 'Show Details') {
      Logger.show();
      continue;
    }

    if (choice === "Don't Warn Again") {
      await cfg.update(CONFIG.CHECK_HOST_MEMORY, false, vscode.ConfigurationTarget.Global);
      return true;
    }

    return choice === 'Launch Anyway';
  }
}

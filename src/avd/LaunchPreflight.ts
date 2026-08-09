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

/** Find a Gradle wrapper in any open workspace folder. */
function findGradleWrapper(): { dir: string; script: string } | undefined {
  const script = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  for (const folder of vscode.workspace.workspaceFolders || []) {
    const candidate = path.join(folder.uri.fsPath, script);
    try {
      if (fs.existsSync(candidate)) { return { dir: folder.uri.fsPath, script: candidate }; }
    } catch { /* keep looking */ }
  }
  return undefined;
}

function stopGradleDaemons(wrapper: { dir: string; script: string }): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(wrapper.script, ['--stop'], { cwd: wrapper.dir, timeout: 30000, windowsHide: true }, (err) => {
      if (err) { reject(err); } else { resolve(); }
    });
  });
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
    const choice = await vscode.window.showWarningMessage(
      `Memory is tight for "${avdName}" — ${formatMb(verdict.availableMb)} free, ~${formatMb(verdict.requiredMb)} needed.`,
      'Launch Anyway', "Don't Warn Again",
    );
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

    const wrapper = procs.some(p => p.label === 'Gradle daemon') ? findGradleWrapper() : undefined;
    const actions = [
      ...(wrapper ? ['Stop Gradle Daemons'] : []),
      'Launch Anyway',
      'Show Details',
      "Don't Warn Again",
    ];

    const choice = await vscode.window.showWarningMessage(
      `Not enough free memory to launch "${avdName}".`,
      { modal: true, detail },
      ...actions,
    );

    if (choice === 'Stop Gradle Daemons' && wrapper) {
      try {
        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: 'Stopping Gradle daemons...', cancellable: false },
          () => stopGradleDaemons(wrapper),
        );
      } catch (err) {
        vscode.window.showWarningMessage(`Could not stop Gradle daemons: ${err}`);
      }
      const before = current.availableMb;
      current = await remeasure();
      const freed = current.availableMb - before;
      if (freed > 0) {
        vscode.window.showInformationMessage(
          `Freed ${formatMb(freed)}. Now ${formatMb(current.availableMb)} available.`,
        );
      }
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

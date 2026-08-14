import * as vscode from 'vscode';
import { CONFIG } from '../constants';
import { formatMb, getHostMemory, getTopMemoryConsumers } from '../utils/HostResources';
import { findGradleWrapper, runDaemonRemedy } from './LaunchPreflight';
import { Logger } from '../utils/Logger';

/**
 * Watch host memory while an emulator is running.
 *
 * The launch pre-flight only samples once, at launch. The failure that actually
 * bites on a 16 GB machine is a build and an emulator wanting memory at the
 * same time: the emulator starts fine, then a Gradle build begins and the guest
 * is squeezed until SystemUI ANRs. A single sample cannot see that coming.
 *
 * Warns at most once per emulator session so it can never become noise.
 */
export class MemoryWatcher implements vscode.Disposable {
  private timer: NodeJS.Timeout | undefined;
  private warned = false;
  private prompting = false;

  /** Sampling cadence. Slow on purpose: this is a background safety net. */
  private static readonly INTERVAL_MS = 15000;

  /** Begin watching. Idempotent — safe to call on every device-list change. */
  start(): void {
    if (this.timer) { return; }
    this.timer = setInterval(() => { void this.sample(); }, MemoryWatcher.INTERVAL_MS);
    Logger.debug('Host memory watch started.');
  }

  /**
   * Stop watching and re-arm the warning.
   *
   * Resetting `warned` here is what makes "once per emulator session" true:
   * the next emulator gets a fresh warning, but a single long-running one
   * cannot nag.
   */
  stop(): void {
    if (!this.timer) { return; }
    clearInterval(this.timer);
    this.timer = undefined;
    this.warned = false;
    Logger.debug('Host memory watch stopped.');
  }

  dispose(): void {
    this.stop();
  }

  private async sample(): Promise<void> {
    if (this.warned || this.prompting) { return; }

    const cfg = vscode.workspace.getConfiguration(CONFIG.SECTION);
    if (!cfg.get<boolean>(CONFIG.WATCH_HOST_MEMORY, true)) { return; }
    const floorMb = cfg.get<number>(CONFIG.LOW_MEMORY_FLOOR_MB, 512);
    if (floorMb <= 0) { return; }

    let availableMb: number;
    let totalMb: number;
    try {
      const mem = await getHostMemory();
      // totalMb === 0 means the probe could not read the host (container, or a
      // platform whose output we could not parse) — never warn on a guess.
      if (mem.totalMb === 0) { return; }
      availableMb = mem.availableMb;
      totalMb = mem.totalMb;
    } catch (err) {
      Logger.debug(`Host memory sample failed: ${err}`);
      return;
    }

    if (availableMb >= floorMb) { return; }

    this.warned = true;
    this.prompting = true;
    try {
      await this.presentWarning(availableMb, totalMb, floorMb);
    } finally {
      this.prompting = false;
    }
  }

  private async presentWarning(availableMb: number, totalMb: number, floorMb: number): Promise<void> {
    const procs = await getTopMemoryConsumers();
    const detail = procs.map(p => {
      const count = p.count > 1 ? ` ×${p.count}` : '';
      const label = p.label ? `  (${p.label})` : '';
      return `  ${p.name}${count} — ${formatMb(p.mb)}${label}`;
    }).join('\n');

    Logger.warn(
      `Host memory low while an emulator is running: ${formatMb(availableMb)} of ${formatMb(totalMb)} free `
      + `(floor ${formatMb(floorMb)}).\n${detail}`,
    );

    const daemon = procs.find(p => p.label === 'Gradle daemon' || p.label === 'Kotlin compile daemon');
    // Offered whenever a daemon is resident: with no wrapper the remedy goes
    // straight to terminating by pid, which is what clears a Kotlin daemon.
    const wrapper = daemon ? findGradleWrapper() : undefined;

    const choice = await vscode.window.showWarningMessage(
      `Only ${formatMb(availableMb)} of memory is free while an emulator is running`
      + `${daemon ? ` — ${daemon.name} is using ${formatMb(daemon.mb)}` : ''}. `
      + 'The emulator may stop responding.',
      ...(daemon ? ['Stop Build Daemons'] : []),
      'Show Details',
      "Don't Warn Again",
    );

    if (choice === 'Stop Build Daemons') {
      await runDaemonRemedy(wrapper, availableMb);
    } else if (choice === 'Show Details') {
      Logger.show();
    } else if (choice === "Don't Warn Again") {
      await vscode.workspace.getConfiguration(CONFIG.SECTION)
        .update(CONFIG.WATCH_HOST_MEMORY, false, vscode.ConfigurationTarget.Global);
    }
  }
}

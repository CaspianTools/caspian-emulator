import * as vscode from 'vscode';
import { AvdInfo } from '../types';
import { AvdManager } from '../avd/AvdManager';

export class AvdTreeItem extends vscode.TreeItem {
  constructor(public readonly avd: AvdInfo) {
    super(avd.displayName || avd.name, vscode.TreeItemCollapsibleState.None);

    const parts: string[] = [];
    if (avd.running) { parts.push('Running'); }
    parts.push(`API ${avd.apiLevel}`);
    parts.push(avd.displaySummary);
    this.description = parts.join(' • ');

    this.tooltip = [
      `Name: ${avd.name}`,
      `Device: ${avd.device || '(none)'}`,
      `API Level: ${avd.apiLevel}`,
      `ABI: ${avd.abi}`,
      `Target: ${avd.target}`,
      `Display: ${avd.lcdWidth && avd.lcdHeight
        ? `${avd.lcdWidth}×${avd.lcdHeight}${avd.lcdDensity ? ` @ ${avd.lcdDensity} dpi` : ''}`
        : 'not configured — the emulator will fall back to 320×640'}`,
      `RAM: ${avd.ramMb ? `${avd.ramMb} MB` : 'default'}`
        + (!avd.ramHealthy && avd.ramFloorMb ? ` — below the ${avd.ramFloorMb} MB this image needs` : ''),
      `Status: ${avd.running ? 'Running' : 'Stopped'}`,
      ...(avd.displayProblem
        ? ['', `⚠ ${avd.displayProblem}`, 'Run "Caspian: Check Device Configuration" to fix.']
        : []),
    ].join('\n');

    // NOTE: package.json matches these with regex (viewItem =~ /^avd\.stopped/),
    // not equality — a suffix here must not hide Launch/Stop/Delete. Suffixes
    // compose, so a low-RAM AVD with a broken display carries both.
    const state = avd.running ? 'avd.running' : 'avd.stopped';
    const suffixes = [
      ...(avd.displayHealthy ? [] : ['brokenDisplay']),
      ...(avd.ramHealthy ? [] : ['lowRam']),
    ];
    this.contextValue = [state, ...suffixes].join('.');

    const needsAttention = !avd.displayHealthy || !avd.ramHealthy;
    this.iconPath = new vscode.ThemeIcon(
      avd.running ? 'vm-running' : 'vm',
      needsAttention
        ? new vscode.ThemeColor('problemsWarningIcon.foreground')
        : avd.running ? new vscode.ThemeColor('testing.iconPassed') : undefined
    );
  }
}

export class AvdTreeProvider implements vscode.TreeDataProvider<AvdTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<AvdTreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private avds: AvdInfo[] = [];

  constructor(private avdManager: AvdManager) {}

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getTreeItem(element: AvdTreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(): Promise<AvdTreeItem[]> {
    try {
      this.avds = await this.avdManager.listAvds();
      return this.avds.map(avd => new AvdTreeItem(avd));
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to list AVDs: ${err}`);
      return [];
    }
  }

  /** Update running status for AVDs based on connected emulators */
  updateRunningStatus(runningAvdNames: Set<string>): void {
    for (const avd of this.avds) {
      avd.running = runningAvdNames.has(avd.name);
    }
    this.refresh();
  }
}

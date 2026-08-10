import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import {
  COMMANDS,
  VIEWS,
  CONFIG,
  DEVICE_PRESETS,
  DISPLAY_RULES,
  BOOT_WATCH,
  CUTOUT_MODES,
  NAVBAR_MODES,
  OVERLAY_MIN_API,
  getDefaultAbi,
} from './constants';
import { SdkManager } from './sdk/SdkManager';
import { AdbClient, assertSafeShellToken } from './adb/AdbClient';
import { DeviceTracker } from './adb/DeviceTracker';
import { AvdManager } from './avd/AvdManager';
import {
  analyzeDisplay,
  formatDisplayReport,
  guestRamFloorMb,
  heapForRamMb,
  RuntimeDisplay,
} from './avd/DisplayCheck';
import { runLaunchPreflight } from './avd/LaunchPreflight';
import { MemoryWatcher } from './avd/MemoryWatcher';
import { BootPhase, classifyBoot, describeBootPhase, probeBootState } from './avd/BootState';
import { checkAcceleration, clearAccelerationCache } from './utils/HostResources';
import { DemoModeController } from './capture/DemoMode';
import { SystemUiOverlayController, OverlayCategory } from './capture/SystemUiOverlay';
import { DeviceStateManager, DeviceStateSnapshot } from './capture/DeviceState';
import { CaptureService, RunManifest, writeRunReport } from './capture/CaptureService';
import { CaptureCancelledError, Orientation } from './capture/Orientation';
import { resolveCaptureRoot, resolveRunDirectory, suggestRunName } from './capture/CapturePaths';
import {
  FONT_SCALE_STOPS,
  MatrixDimensions,
  MatrixRunner,
  PER_APP_LOCALE_MIN_API,
  PSEUDOLOCALES,
  countCells,
} from './capture/MatrixRunner';
import { AvdTreeProvider, AvdTreeItem } from './views/AvdTreeProvider';
import { DeviceTreeProvider, DeviceTreeItem } from './views/DeviceTreeProvider';
import { FileExplorerProvider, FileTreeItem } from './views/FileExplorerProvider';
import { LogcatPanel } from './views/LogcatPanel';
import { EmulatorScreenPanel } from './views/EmulatorScreenPanel';
import { QrPairingPanel } from './views/QrPairingPanel';
import { SdkInfo, DeviceInfo, DeviceProfile, AvdHardware } from './types';
import { Logger } from './utils/Logger';

let sdkManager: SdkManager;
let adbClient: AdbClient;
let deviceTracker: DeviceTracker;
let avdManager: AvdManager;
let avdTreeProvider: AvdTreeProvider;
let deviceTreeProvider: DeviceTreeProvider;
let fileExplorerProvider: FileExplorerProvider;
let statusBarItem: vscode.StatusBarItem;
let demoStatusBarItem: vscode.StatusBarItem | undefined;
let memoryWatcher: MemoryWatcher | undefined;
/** Serials with a capture run in progress, so two runs cannot fight. */
const captureInFlight = new Set<string>();
/** Serials already offered a leftover-override cleanup this session. */
const leftoverPrompted = new Set<string>();
/**
 * AVDs whose saved snapshot is known bad — a force-kill never let qemu flush.
 * The next launch of these must be a cold boot or it will restore a corrupt
 * state and appear to hang.
 */
const snapshotSuspect = new Set<string>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  // Initialize output channel
  const outputChannel = Logger.init();
  context.subscriptions.push(outputChannel);
  Logger.info('Caspian Emulator activating...');

  sdkManager = new SdkManager();

  // Register SDK setup commands first (always available)
  context.subscriptions.push(
    vscode.commands.registerCommand(COMMANDS.SETUP_SDK, () => setupSdk(context)),
    vscode.commands.registerCommand(COMMANDS.DOWNLOAD_SDK, () => downloadSdk(context)),
    vscode.commands.registerCommand(COMMANDS.CONNECT_PHONE, () => connectPhoneGuide()),
    vscode.commands.registerCommand(COMMANDS.SHOW_OUTPUT, () => Logger.show()),
  );

  // Try to detect SDK automatically
  const sdk = await sdkManager.detect();
  if (sdk) {
    await initializeWithSdk(context, sdk);
  } else {
    // Register placeholder views that prompt setup
    registerPlaceholderCommands(context);
    vscode.window.showInformationMessage(
      'Android SDK not found. Install it automatically or configure an existing installation.',
      'Install Android SDK',
      'Configure Manually'
    ).then(choice => {
      if (choice === 'Install Android SDK') {
        vscode.commands.executeCommand(COMMANDS.DOWNLOAD_SDK);
      } else if (choice === 'Configure Manually') {
        vscode.commands.executeCommand(COMMANDS.SETUP_SDK);
      }
    });
  }

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBarItem.command = COMMANDS.SELECT_DEVICE;
  updateStatusBar([]);
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  Logger.info('Caspian Emulator activated');
}

async function setupSdk(context: vscode.ExtensionContext): Promise<void> {
  const sdk = await sdkManager.runSetupWizard();
  if (sdk) {
    await initializeWithSdk(context, sdk);
    vscode.window.showInformationMessage('Android SDK configured successfully!');
  }
}

async function downloadSdk(context: vscode.ExtensionContext): Promise<void> {
  const sdk = await sdkManager.runDownloadWizard();
  if (sdk) {
    await initializeWithSdk(context, sdk);
    if (avdTreeProvider) {
      avdTreeProvider.refresh();
    }
  }
}

async function initializeWithSdk(context: vscode.ExtensionContext, sdk: SdkInfo): Promise<void> {
  adbClient = new AdbClient(sdk);
  avdManager = new AvdManager(sdk);
  deviceTracker = new DeviceTracker(sdk, adbClient);

  // AvdManager has no vscode import, so the guest-RAM toggle is pushed in.
  const syncGuestRamSetting = () => avdManager.setCheckGuestRam(
    vscode.workspace.getConfiguration(CONFIG.SECTION).get<boolean>(CONFIG.CHECK_GUEST_RAM, true),
  );
  syncGuestRamSetting();
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration(`${CONFIG.SECTION}.${CONFIG.CHECK_GUEST_RAM}`)) {
      syncGuestRamSetting();
      avdTreeProvider?.refresh();
    }
  }));

  memoryWatcher = new MemoryWatcher();
  context.subscriptions.push(memoryWatcher);

  // Tree views
  avdTreeProvider = new AvdTreeProvider(avdManager);
  deviceTreeProvider = new DeviceTreeProvider(deviceTracker);
  fileExplorerProvider = new FileExplorerProvider(adbClient);

  context.subscriptions.push(
    vscode.window.createTreeView(VIEWS.AVD_LIST, { treeDataProvider: avdTreeProvider }),
    vscode.window.createTreeView(VIEWS.DEVICE_LIST, { treeDataProvider: deviceTreeProvider }),
    vscode.window.createTreeView(VIEWS.FILE_EXPLORER, { treeDataProvider: fileExplorerProvider }),
  );

  // Register all commands
  registerCommands(context);

  // Demo mode indicator — deliberately warning-coloured, because demo mode
  // makes the device lie about battery, signal, and time.
  demoStatusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 49);
  demoStatusBarItem.command = COMMANDS.TOGGLE_DEMO_MODE;
  demoStatusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
  context.subscriptions.push(demoStatusBarItem);
  context.subscriptions.push(DemoModeController.onDidChange(() => updateDemoStatusBar()));
  updateDemoStatusBar();

  // Notify when a phone connects but isn't authorized yet
  deviceTracker.on('deviceConnected', (device: DeviceInfo) => {
    if (device.state === 'unauthorized') {
      vscode.window.showInformationMessage(
        `Phone detected. Check your phone screen and tap "Allow USB Debugging".`,
        'How to Connect'
      ).then(choice => {
        if (choice === 'How to Connect') {
          vscode.commands.executeCommand(COMMANDS.CONNECT_PHONE);
        }
      });
    }
    if (device.state === 'device') {
      checkPendingRestores(context).catch(err => Logger.warn(`Pending-restore check failed: ${err}`));
      checkLeftoverOverrides(context, device.serial)
        .catch(err => Logger.warn(`Leftover-override check failed: ${err}`));
    }
  });

  deviceTracker.on('deviceDisconnected', (device: DeviceInfo) => {
    adbClient.clearDeviceCache(device.serial);
    DemoModeController.forget(device.serial);
    updateDemoStatusBar();
  });

  // Start device tracking
  deviceTracker.on('devicesChanged', (devices: DeviceInfo[]) => {
    updateStatusBar(devices);
    syncRunningAvds(devices);
    autoSelectFileExplorerDevice(devices);
  });

  // Handle device tracker errors gracefully (prevents uncaught EventEmitter errors)
  deviceTracker.on('error', (err: Error) => {
    Logger.error(`Device tracker: ${err.message}`);
  });

  // Ensure ADB server is running before polling for devices
  try {
    await adbClient.exec(['start-server']);
    Logger.info('ADB server started');
  } catch (err) {
    Logger.warn(`ADB server start failed (${err}). Device tracking may not work until ADB is available.`);
  }

  deviceTracker.start();
  context.subscriptions.push({ dispose: () => deviceTracker.stop() });

  Logger.info(`SDK initialized: ${sdk.path}`);
}

function registerPlaceholderCommands(context: vscode.ExtensionContext): void {
  const sdkRequired = () => {
    vscode.window.showWarningMessage(
      'Android SDK is not configured.',
      'Setup SDK'
    ).then(choice => {
      if (choice === 'Setup SDK') {
        vscode.commands.executeCommand(COMMANDS.SETUP_SDK);
      }
    });
  };

  const commandIds = Object.values(COMMANDS).filter(c =>
    c !== COMMANDS.SETUP_SDK && c !== COMMANDS.DOWNLOAD_SDK &&
    c !== COMMANDS.CONNECT_PHONE && c !== COMMANDS.SHOW_OUTPUT
  );
  for (const cmd of commandIds) {
    context.subscriptions.push(
      vscode.commands.registerCommand(cmd, sdkRequired)
    );
  }
}

function registerCommands(context: vscode.ExtensionContext): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const reg = (cmd: string, handler: (...args: any[]) => any) => {
    context.subscriptions.push(vscode.commands.registerCommand(cmd, handler));
  };

  // ── AVD commands ──

  reg(COMMANDS.REFRESH_AVDS, () => avdTreeProvider.refresh());

  reg(COMMANDS.CREATE_AVD, async () => {
    const mode = await vscode.window.showQuickPick(
      [
        { label: '$(device-mobile) From preset', description: 'Pixel 9, Pixel 8, Pixel Fold, Tablet...', value: 'preset' },
        { label: '$(settings-gear) Custom', description: 'Choose system image and device profile manually', value: 'custom' },
      ],
      { placeHolder: 'How do you want to create the virtual device?' }
    );
    if (!mode) { return; }

    if (mode.value === 'preset') {
      const abi = getDefaultAbi();
      const presetPick = await vscode.window.showQuickPick(
        DEVICE_PRESETS.map(p => ({
          label: p.name,
          description: `Android ${p.api}  •  ${abi}`,
          preset: p,
        })),
        { placeHolder: 'Select a device' }
      );
      if (!presetPick) { return; }

      const preset = presetPick.preset;
      const defaultName = `${preset.name.replace(/[\s]/g, '_')}_API${preset.api}`;
      const name = await vscode.window.showInputBox({
        prompt: 'AVD name',
        value: defaultName,
        validateInput: (v) => /^[a-zA-Z0-9_.-]+$/.test(v) ? null : 'Use only letters, numbers, underscores, dots, and hyphens',
      });
      if (!name) { return; }

      const systemImage = `system-images;android-${preset.api};${preset.tag};${abi}`;
      const images = await avdManager.listSystemImages();
      const alreadyInstalled = images.some(img => img.path === systemImage && img.installed);

      if (!alreadyInstalled) {
        const choice = await vscode.window.showWarningMessage(
          `System image for ${preset.name} (Android ${preset.api}) is not installed. Download it now? (~1 GB)`,
          'Download', 'Cancel'
        );
        if (choice !== 'Download') { return; }

        await vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title: `Downloading ${preset.name} system image...`, cancellable: false },
          async () => { await avdManager.installSystemImage(systemImage); }
        );
      }

      // Tri-state: null means enumeration failed, which is NOT the same as
      // "this SDK has no such profile". Conflating them is what silently
      // produced AVDs with no display configuration at all.
      let profiles: DeviceProfile[] | null = null;
      try {
        profiles = await avdManager.listDeviceProfiles();
      } catch (err) {
        Logger.warn(`Could not list device profiles (${err}). Will attempt -d and fall back.`);
      }

      let deviceProfile: string | undefined = preset.profile;
      if (profiles !== null && !profiles.some(p => p.id === preset.profile)) {
        // Known-missing: skip -d up front. No prompt — we supply the hardware.
        Logger.info(`Device profile "${preset.profile}" is not in this SDK; applying hardware directly.`);
        deviceProfile = undefined;
      }

      const hardware: AvdHardware = {
        width: preset.width,
        height: preset.height,
        density: preset.density,
        ram: preset.ram,
        heap: preset.heap,
        orientation: preset.orientation,
        dataPartition: preset.dataPartition,
        profileId: preset.profile,
        manufacturer: preset.manufacturer,
      };

      const result = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating ${preset.name} virtual device...` },
        async () => avdManager.createAvd(name, systemImage, deviceProfile, hardware)
      );
      avdTreeProvider.refresh();

      const res = `${result.effective.width}×${result.effective.height} @ ${result.effective.density} dpi`;
      if (result.profileApplied) {
        vscode.window.showInformationMessage(`${preset.name} virtual device "${name}" created (${res}).`);
      } else if (preset.foldable) {
        vscode.window.showWarningMessage(
          `${preset.name} virtual device "${name}" created with a ${res} display. `
          + `Your SDK does not include the "${preset.profile}" device definition, so folding postures are not emulated. `
          + 'Update the SDK command-line tools for full fold support.',
          'Update SDK Tools'
        ).then(c => { if (c === 'Update SDK Tools') { vscode.commands.executeCommand(COMMANDS.DOWNLOAD_SDK); } });
      } else {
        vscode.window.showInformationMessage(
          `${preset.name} virtual device "${name}" created (${res}). `
          + `Your SDK lacks the "${preset.profile}" device definition, so Caspian configured the display directly.`
        );
      }

    } else {
      // Custom flow
      const images = await avdManager.listSystemImages();
      if (images.length === 0) {
        vscode.window.showWarningMessage('No system images found. Use the preset flow to download one automatically.');
        return;
      }

      const picked = await vscode.window.showQuickPick(
        images.map(img => ({
          label: `API ${img.apiLevel} - ${img.tag}/${img.abi}`,
          description: img.installed ? 'Installed' : 'Not installed',
          detail: img.path,
          image: img,
        })),
        { placeHolder: 'Select a system image' }
      );
      if (!picked) { return; }

      const name = await vscode.window.showInputBox({
        prompt: 'Enter AVD name',
        placeHolder: 'MyDevice',
        validateInput: (v) => /^[a-zA-Z0-9_.-]+$/.test(v) ? null : 'Use only letters, numbers, underscores, dots, and hyphens',
      });
      if (!name) { return; }

      let profiles: DeviceProfile[] = [];
      try {
        profiles = await avdManager.listDeviceProfiles();
      } catch (err) {
        Logger.warn(`Could not list device profiles (${err}).`);
      }
      let device: string | undefined;
      if (profiles.length > 0) {
        const profilePick = await vscode.window.showQuickPick(
          profiles.map(p => ({ label: p.name, id: p.id })),
          { placeHolder: 'Select a device profile (optional)' }
        );
        device = profilePick?.id;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Creating AVD "${name}"...` },
        async () => { await avdManager.createAvd(name, picked.detail, device); }
      );
      // The device profile supplies the display, but nothing supplies RAM: the
      // custom path wrote no hw.ramSize at all, leaving the emulator's 1536 MB
      // default, which a modern Google APIs image thrashes on. Only ever raise.
      const floor = guestRamFloorMb(picked.image.apiLevel, picked.image.tag);
      const created = avdManager.readAvdConfig(name);
      const currentRam = parseInt(created['hw.ramSize'] || '0', 10) || 0;
      if (floor && currentRam < floor) {
        try {
          avdManager.updateAvdConfig(name, {
            'hw.ramSize': String(floor),
            'vm.heapSize': String(heapForRamMb(floor)),
          });
          Logger.info(`Set hw.ramSize=${floor} MB on "${name}" (API ${picked.image.apiLevel} ${picked.image.tag}).`);
        } catch (err) {
          Logger.warn(`Could not set RAM on "${name}": ${err}`);
        }
      }

      avdTreeProvider.refresh();

      // No preset to draw hardware from here, so check the result rather than
      // silently shipping a 320×640 AVD.
      const report = analyzeDisplay(avdManager.readAvdConfig(name), name, undefined, { checkGuestRam: true });
      if (!report.healthy) {
        vscode.window.showWarningMessage(
          `AVD "${name}" was created without a usable display configuration (${report.summary}).`,
          'Set Display', 'Ignore'
        ).then(c => {
          if (c === 'Set Display') { vscode.commands.executeCommand(COMMANDS.CHECK_AVD_DISPLAY, name); }
        });
      } else {
        vscode.window.showInformationMessage(`AVD "${name}" created (${report.summary}).`);
      }
    }
  });

  reg(COMMANDS.LAUNCH_AVD, async (item?: AvdTreeItem) => {
    const avdName = item?.avd.name || await pickAvd('Select AVD to launch');
    if (!avdName) { return; }
    await launchAvdWithPreflight(avdName, { coldBoot: false });
  });

  reg(COMMANDS.COLD_BOOT_AVD, async (item?: AvdTreeItem) => {
    const avdName = item?.avd.name || await pickAvd('Select AVD to cold boot');
    if (!avdName) { return; }
    await launchAvdWithPreflight(avdName, { coldBoot: true });
  });

  reg(COMMANDS.STOP_AVD, async (item?: AvdTreeItem) => {
    const avdName = item?.avd.name || await pickAvd('Select an emulator to stop');
    if (!avdName) { return; }

    // Fall back to asking adb: an emulator started before this window opened
    // has no tracked serial, and refusing to stop it was the old behaviour.
    const serial = item?.avd.serial || await resolveAvdSerial(avdName);
    if (!serial) {
      vscode.window.showWarningMessage(`"${avdName}" does not appear to be running.`);
      avdTreeProvider.refresh();
      return;
    }

    const stopped = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Stopping ${avdName}...`, cancellable: false },
      () => avdManager.stopEmulator(serial),
    );
    avdTreeProvider.refresh();

    if (!stopped) {
      vscode.window.showWarningMessage(
        `"${avdName}" did not shut down. It may be wedged.`,
        'Repair...',
      ).then(choice => {
        if (choice === 'Repair...') {
          vscode.commands.executeCommand(COMMANDS.REPAIR_AVD, { avd: { name: avdName } });
        }
      });
    }
  });

  reg(COMMANDS.REPAIR_AVD, async (item?: AvdTreeItem) => {
    const avdName = item?.avd.name || await pickAvd('Select an emulator to repair');
    if (!avdName) { return; }
    try {
      await repairAvd(avdName);
    } catch (err) {
      vscode.window.showErrorMessage(`Repair failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  reg(COMMANDS.DELETE_AVD, async (item?: AvdTreeItem) => {
    const avdName = item?.avd.name || await pickAvd('Select AVD to delete');
    if (!avdName) { return; }

    const confirm = await vscode.window.showWarningMessage(
      `Delete AVD "${avdName}"? This cannot be undone.`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') { return; }

    await avdManager.deleteAvd(avdName);
    avdTreeProvider.refresh();
    vscode.window.showInformationMessage(`AVD "${avdName}" deleted.`);
  });

  reg(COMMANDS.EDIT_AVD, async (item?: AvdTreeItem) => {
    const avdName = item?.avd.name;
    if (!avdName) { return; }
    const configPath = avdManager.getConfigPath(avdName);
    const doc = await vscode.workspace.openTextDocument(configPath);
    await vscode.window.showTextDocument(doc);
  });

  reg(COMMANDS.CLONE_AVD, async (item?: AvdTreeItem) => {
    const avdName = item?.avd.name || await pickAvd('Select AVD to clone');
    if (!avdName) { return; }

    const newName = await vscode.window.showInputBox({
      prompt: 'Name for the cloned AVD',
      value: `${avdName}_copy`,
      validateInput: (v) => /^[a-zA-Z0-9_.-]+$/.test(v) ? null : 'Use only letters, numbers, underscores, dots, and hyphens',
    });
    if (!newName) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Cloning AVD "${avdName}"...` },
      async () => { await avdManager.cloneAvd(avdName, newName); }
    );
    avdTreeProvider.refresh();
    vscode.window.showInformationMessage(`AVD "${newName}" cloned from "${avdName}".`);
  });

  // ── Device commands ──

  reg(COMMANDS.REFRESH_DEVICES, () => deviceTracker.refresh());

  reg(COMMANDS.SELECT_DEVICE, async () => {
    const devices = deviceTracker.getDevices().filter(d => d.state === 'device');
    if (devices.length === 0) {
      vscode.window.showWarningMessage('No connected devices.');
      return;
    }

    const pick = await vscode.window.showQuickPick(
      devices.map(d => ({
        label: `$(${d.type === 'emulator' ? 'vm-running' : 'device-mobile'}) ${d.model}`,
        description: d.serial,
        detail: `${d.type} • ${d.product}`,
        serial: d.serial,
        device: d,
      })),
      { placeHolder: 'Select active device' }
    );
    if (!pick) { return; }

    fileExplorerProvider.setDevice(pick.device);
    vscode.window.showInformationMessage(`Active device: ${pick.device.model}`);
    Logger.info(`Active device selected: ${pick.device.model} (${pick.serial})`);
  });

  reg(COMMANDS.INSTALL_APK, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      filters: { 'APK Files': ['apk'] },
      title: 'Select APK to install',
    });
    if (!uris || uris.length === 0) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Installing APK...' },
      async () => {
        await adbClient.installApk(serial, uris[0].fsPath);
      }
    );
    vscode.window.showInformationMessage('APK installed successfully.');
  });

  reg(COMMANDS.TAKE_SCREENSHOT, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }

    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), 'screenshot.png')),
      filters: { 'PNG Images': ['png'] },
      title: 'Save screenshot as',
    });
    if (!uri) { return; }

    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Taking screenshot...' },
      async () => {
        await adbClient.screenshot(serial, uri.fsPath);
      }
    );
    vscode.window.showInformationMessage(`Screenshot saved to ${uri.fsPath}`);
  });

  reg(COMMANDS.RECORD_SCREEN, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }

    const recording = adbClient.startScreenRecording(serial);
    const stopBtn = 'Stop Recording';
    const choice = await vscode.window.showInformationMessage(
      'Screen recording started. Click stop when done.',
      stopBtn
    );

    recording.kill('SIGINT');

    if (choice === stopBtn) {
      const uri = await vscode.window.showSaveDialog({
        defaultUri: vscode.Uri.file(path.join(os.homedir(), 'recording.mp4')),
        filters: { 'MP4 Video': ['mp4'] },
        title: 'Save recording as',
      });
      if (uri) {
        await adbClient.pullScreenRecording(serial, uri.fsPath);
        vscode.window.showInformationMessage(`Recording saved to ${uri.fsPath}`);
      }
    }
  });

  reg(COMMANDS.OPEN_SHELL, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }

    const sdk = sdkManager.getSdkInfo();
    if (!sdk) { return; }

    const terminal = vscode.window.createTerminal({
      name: `ADB Shell: ${serial}`,
      shellPath: sdk.adbPath,
      shellArgs: ['-s', serial, 'shell'],
    });
    terminal.show();
  });

  reg(COMMANDS.SHOW_LOGCAT, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }
    const name = item?.device.model || serial;
    LogcatPanel.show(context.extensionUri, adbClient, serial, name);
  });

  reg(COMMANDS.SHOW_EMULATOR_SCREEN, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }
    const name = item?.device.model || serial;
    EmulatorScreenPanel.show(context.extensionUri, adbClient, serial, name);
  });

  // ── App management commands ──

  reg(COMMANDS.LAUNCH_APP, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }

    const packageName = await pickPackage(serial, 'Select app to launch');
    if (!packageName) { return; }

    try {
      await adbClient.launchApp(serial, packageName);
      vscode.window.showInformationMessage(`Launched ${packageName}`);
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to launch app: ${err}`);
    }
  });

  reg(COMMANDS.FORCE_STOP_APP, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }

    const packageName = await pickPackage(serial, 'Select app to force stop');
    if (!packageName) { return; }

    await adbClient.forceStopApp(serial, packageName);
    vscode.window.showInformationMessage(`Force stopped ${packageName}`);
  });

  reg(COMMANDS.CLEAR_APP_DATA, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }

    const packageName = await pickPackage(serial, 'Select app to clear data');
    if (!packageName) { return; }

    const confirm = await vscode.window.showWarningMessage(
      `Clear all data for ${packageName}? This removes login state, preferences, and cached files.`,
      { modal: true },
      'Clear Data'
    );
    if (confirm !== 'Clear Data') { return; }

    await adbClient.clearAppData(serial, packageName);
    vscode.window.showInformationMessage(`Cleared data for ${packageName}`);
  });

  reg(COMMANDS.UNINSTALL_APP, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }

    const packageName = await pickPackage(serial, 'Select app to uninstall');
    if (!packageName) { return; }

    const confirm = await vscode.window.showWarningMessage(
      `Uninstall ${packageName}?`,
      { modal: true },
      'Uninstall'
    );
    if (confirm !== 'Uninstall') { return; }

    await adbClient.uninstallApp(serial, packageName);
    vscode.window.showInformationMessage(`Uninstalled ${packageName}`);
  });

  reg(COMMANDS.SHOW_APP_LOGCAT, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }
    const name = item?.device.model || serial;

    const packageName = await pickPackage(serial, 'Select app to view logs');
    if (!packageName) { return; }

    LogcatPanel.show(context.extensionUri, adbClient, serial, name, packageName);
  });

  reg(COMMANDS.LIST_PACKAGES, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }

    const packages = await adbClient.listPackages(serial, true);
    if (packages.length === 0) {
      vscode.window.showInformationMessage('No third-party apps installed.');
      return;
    }

    const pick = await vscode.window.showQuickPick(
      packages.map(p => ({
        label: p,
        buttons: [
          { iconPath: new vscode.ThemeIcon('play'), tooltip: 'Launch' },
          { iconPath: new vscode.ThemeIcon('debug-stop'), tooltip: 'Force Stop' },
          { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Uninstall' },
        ],
      })),
      { placeHolder: `${packages.length} apps installed on device` }
    );
    if (!pick) { return; }

    const action = await vscode.window.showQuickPick(
      [
        { label: '$(play) Launch', value: 'launch' },
        { label: '$(debug-stop) Force Stop', value: 'stop' },
        { label: '$(discard) Clear Data', value: 'clear' },
        { label: '$(output) Show Logcat', value: 'logcat' },
        { label: '$(trash) Uninstall', value: 'uninstall' },
      ],
      { placeHolder: `Action for ${pick.label}` }
    );
    if (!action) { return; }

    switch (action.value) {
      case 'launch':
        await adbClient.launchApp(serial, pick.label);
        vscode.window.showInformationMessage(`Launched ${pick.label}`);
        break;
      case 'stop':
        await adbClient.forceStopApp(serial, pick.label);
        vscode.window.showInformationMessage(`Stopped ${pick.label}`);
        break;
      case 'clear':
        await adbClient.clearAppData(serial, pick.label);
        vscode.window.showInformationMessage(`Cleared data for ${pick.label}`);
        break;
      case 'logcat': {
        const name = deviceTracker.getDevices().find(d => d.serial === serial)?.model || serial;
        LogcatPanel.show(context.extensionUri, adbClient, serial, name, pick.label);
        break;
      }
      case 'uninstall':
        await adbClient.uninstallApp(serial, pick.label);
        vscode.window.showInformationMessage(`Uninstalled ${pick.label}`);
        break;
    }
  });

  // ── File explorer commands ──

  reg(COMMANDS.REFRESH_FILES, () => fileExplorerProvider.refresh());

  reg(COMMANDS.PULL_FILE, async (item?: FileTreeItem) => {
    if (!item) { return; }
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(os.homedir(), item.file.name)),
      title: `Download ${item.file.name}`,
    });
    if (!uri) { return; }
    await adbClient.pullFile(item.deviceSerial, item.file.path, uri.fsPath);
    vscode.window.showInformationMessage(`Downloaded ${item.file.name}`);
  });

  reg(COMMANDS.PUSH_FILE, async () => {
    const device = fileExplorerProvider.getCurrentDevice();
    if (!device) {
      vscode.window.showWarningMessage('No device selected for file explorer.');
      return;
    }

    const uris = await vscode.window.showOpenDialog({
      canSelectFiles: true,
      canSelectMany: false,
      title: 'Select file to upload',
    });
    if (!uris || uris.length === 0) { return; }

    const remotePath = await vscode.window.showInputBox({
      prompt: 'Remote destination path',
      value: '/sdcard/',
    });
    if (!remotePath) { return; }

    await adbClient.pushFile(device.serial, uris[0].fsPath, remotePath);
    fileExplorerProvider.refresh();
    vscode.window.showInformationMessage('File uploaded.');
  });

  reg(COMMANDS.DELETE_FILE, async (item?: FileTreeItem) => {
    if (!item) { return; }
    const confirm = await vscode.window.showWarningMessage(
      `Delete ${item.file.name}?`,
      { modal: true },
      'Delete'
    );
    if (confirm !== 'Delete') { return; }
    await adbClient.deleteFile(item.deviceSerial, item.file.path, item.file.type === 'directory');
    fileExplorerProvider.refresh();
  });

  reg(COMMANDS.CREATE_FOLDER, async (item?: FileTreeItem) => {
    const device = fileExplorerProvider.getCurrentDevice();
    if (!device) {
      vscode.window.showWarningMessage('No device selected.');
      return;
    }

    const parentPath = item?.file.type === 'directory' ? item.file.path : '/sdcard';
    const folderName = await vscode.window.showInputBox({
      prompt: `Create folder in ${parentPath}`,
      placeHolder: 'New folder name',
    });
    if (!folderName) { return; }

    const fullPath = parentPath.endsWith('/') ? parentPath + folderName : parentPath + '/' + folderName;
    await adbClient.createDirectory(device.serial, fullPath);
    fileExplorerProvider.refresh();
    vscode.window.showInformationMessage(`Created folder: ${fullPath}`);
  });

  reg(COMMANDS.RENAME_FILE, async (item?: FileTreeItem) => {
    if (!item) { return; }

    const newName = await vscode.window.showInputBox({
      prompt: `Rename "${item.file.name}" to:`,
      value: item.file.name,
    });
    if (!newName || newName === item.file.name) { return; }

    const dir = item.file.path.substring(0, item.file.path.lastIndexOf('/'));
    const newPath = dir + '/' + newName;
    await adbClient.renameFile(item.deviceSerial, item.file.path, newPath);
    fileExplorerProvider.refresh();
    vscode.window.showInformationMessage(`Renamed to ${newName}`);
  });

  reg(COMMANDS.OPEN_REMOTE_FILE, async (item?: FileTreeItem) => {
    if (!item || item.file.type !== 'file') { return; }

    // Only open text-like files under 1MB
    if (item.file.size > 1024 * 1024) {
      vscode.window.showWarningMessage('File too large to preview. Use download instead.');
      return;
    }

    try {
      const content = await adbClient.readFile(item.deviceSerial, item.file.path);
      const doc = await vscode.workspace.openTextDocument({
        content,
        language: guessLanguage(item.file.name),
      });
      await vscode.window.showTextDocument(doc, { preview: true });
    } catch (err) {
      vscode.window.showErrorMessage(`Failed to read file: ${err}`);
    }
  });

  // ── Wireless ADB ──

  reg(COMMANDS.QR_PAIR, async () => {
    QrPairingPanel.show(adbClient, deviceTracker);
  });

  reg(COMMANDS.CONNECT_WIFI, async () => {
    const method = await vscode.window.showQuickPick(
      [
        { label: '$(radio-tower) Pair with QR Code (Android 11+)', description: 'Scan a QR code from your phone — fastest method', value: 'qr' },
        { label: '$(key) Wireless Debugging (Android 11+)', description: 'Pair with code, then connect', value: 'pair' },
        { label: '$(plug) TCP/IP Connect', description: 'Connect to IP:port directly', value: 'tcpip' },
      ],
      { placeHolder: 'How do you want to connect?' }
    );
    if (!method) { return; }

    if (method.value === 'qr') {
      QrPairingPanel.show(adbClient, deviceTracker);
      return;
    }

    if (method.value === 'pair') {
      const pairAddress = await vscode.window.showInputBox({
        prompt: 'Enter pairing address (IP:port) shown on your phone',
        placeHolder: '192.168.1.100:37000',
      });
      if (!pairAddress) { return; }

      const pairCode = await vscode.window.showInputBox({
        prompt: 'Enter the 6-digit pairing code shown on your phone',
        placeHolder: '123456',
      });
      if (!pairCode) { return; }

      try {
        const result = await adbClient.pair(pairAddress, pairCode);
        vscode.window.showInformationMessage(`Paired: ${result}`);

        const connectAddress = await vscode.window.showInputBox({
          prompt: 'Now enter the connection address (IP:port) from Wireless Debugging settings',
          placeHolder: '192.168.1.100:38000',
        });
        if (!connectAddress) { return; }

        const connectResult = await adbClient.connectTcp(connectAddress);
        vscode.window.showInformationMessage(`Connected: ${connectResult}`);
        deviceTracker.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Pairing failed: ${err}`);
      }
    } else {
      const address = await vscode.window.showInputBox({
        prompt: 'Enter device address (IP:port)',
        placeHolder: '192.168.1.100:5555',
      });
      if (!address) { return; }

      try {
        const result = await adbClient.connectTcp(address);
        vscode.window.showInformationMessage(`Connected: ${result}`);
        deviceTracker.refresh();
      } catch (err) {
        vscode.window.showErrorMessage(`Connection failed: ${err}`);
      }
    }
  });

  reg(COMMANDS.DISCONNECT_WIFI, async () => {
    const devices = deviceTracker.getDevices().filter(d =>
      d.state === 'device' && !d.serial.startsWith('emulator-') && d.serial.includes(':')
    );
    if (devices.length === 0) {
      vscode.window.showWarningMessage('No Wi-Fi devices connected.');
      return;
    }

    const pick = await vscode.window.showQuickPick(
      devices.map(d => ({ label: d.model, description: d.serial, serial: d.serial })),
      { placeHolder: 'Select device to disconnect' }
    );
    if (!pick) { return; }

    await adbClient.disconnectTcp(pick.serial);
    vscode.window.showInformationMessage(`Disconnected ${pick.serial}`);
    deviceTracker.refresh();
  });

  // ── AVD diagnostics ──

  reg(COMMANDS.CHECK_AVD_DISPLAY, async (arg?: AvdTreeItem | string) => {
    const avdName = typeof arg === 'string' ? arg : arg?.avd.name || await pickAvd('Select AVD to check');
    if (!avdName) { return; }
    try {
      await checkAvdDisplay(avdName);
    } catch (err) {
      vscode.window.showErrorMessage(`Display check failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  reg(COMMANDS.CHECK_ACCELERATION, async () => {
    const status = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Checking emulator acceleration...', cancellable: false },
      () => {
        clearAccelerationCache();
        return checkAcceleration((args, timeoutMs) => avdManager.execEmulatorRaw(args, timeoutMs), true);
      }
    );
    Logger.info(`Acceleration check: ${status.raw}`);
    if (status.ok) {
      vscode.window.showInformationMessage(`Hardware acceleration is available. ${status.message}`);
    } else {
      const extra = process.platform === 'win32'
        ? ' Enable "Windows Hypervisor Platform" and "Virtual Machine Platform" in Windows Features, then reboot.'
        : '';
      vscode.window.showWarningMessage(
        `Hardware acceleration is unavailable. ${status.message}${extra}`,
        'How to Fix'
      ).then(c => {
        if (c === 'How to Fix') {
          vscode.env.openExternal(vscode.Uri.parse('https://developer.android.com/studio/run/emulator-acceleration'));
        }
      });
    }
  });

  reg(COMMANDS.SHOW_EMULATOR_LOG, async (item?: AvdTreeItem) => {
    const avdName = item?.avd.name || await pickAvd('Select AVD whose launch log to open');
    if (!avdName) { return; }
    const logPath = avdManager.getLaunchLogPath(avdName);
    if (!fs.existsSync(logPath)) {
      vscode.window.showInformationMessage(`No launch log yet for "${avdName}". Launch it from Caspian to record one.`);
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(logPath));
    await vscode.window.showTextDocument(doc, { preview: false });
  });

  // ── Capture ──

  reg(COMMANDS.TOGGLE_DEMO_MODE, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }
    try {
      const on = await new DemoModeController(adbClient).toggle(serial);
      updateDemoStatusBar();
      vscode.window.showInformationMessage(
        on
          ? 'Screenshot mode on — status bar shows a fixed clock, full battery, and full signal.'
          : 'Screenshot mode off — the status bar is back to normal.'
      );
    } catch (err) {
      vscode.window.showErrorMessage(`Screenshot mode failed: ${err instanceof Error ? err.message : err}`);
    }
  });

  reg(COMMANDS.CAPTURE_STORE_SCREENSHOTS, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }
    try {
      await captureStoreScreenshots(context, serial);
    } catch (err) {
      if (!(err instanceof CaptureCancelledError)) {
        vscode.window.showErrorMessage(`Capture failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  });

  reg(COMMANDS.RUN_CAPTURE_MATRIX, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }
    try {
      await runCaptureMatrix(context, serial);
    } catch (err) {
      if (!(err instanceof CaptureCancelledError)) {
        vscode.window.showErrorMessage(`Matrix run failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  });

  reg(COMMANDS.SET_DISPLAY_CUTOUT, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }
    await applyOverlayMode(serial, 'cutout');
  });

  reg(COMMANDS.SET_NAVIGATION_MODE, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }
    await applyOverlayMode(serial, 'navbar');
  });

  reg(COMMANDS.OPEN_CAPTURE_FOLDER, async () => {
    const root = resolveCaptureRoot();
    if (root.usedFallback) {
      vscode.window.showInformationMessage(
        `No workspace is open, so captures go to ${root.dir}.`,
        'Configure'
      ).then(c => {
        if (c === 'Configure') {
          vscode.commands.executeCommand('workbench.action.openSettings', 'caspian.captureDirectory');
        }
      });
    }
    await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(root.dir));
  });

  reg(COMMANDS.RESET_DEVICE_OVERRIDES, async (item?: DeviceTreeItem) => {
    const serial = item?.device.serial || await pickDevice();
    if (!serial) { return; }

    const confirm = await vscode.window.showWarningMessage(
      `Reset display and language overrides on ${serial}?`,
      {
        modal: true,
        detail: 'Clears the display size and density overrides, font scale, forced RTL, '
          + 'rotation lock, demo mode, and any cutout or navigation-bar emulation. '
          + 'Per-app languages set by a matrix run are not touched here — use '
          + '"Restore Now" on the pending-restore prompt for those.',
      },
      'Reset'
    );
    if (confirm !== 'Reset') { return; }

    const failures = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Resetting device overrides...', cancellable: false },
      () => new DeviceStateManager(adbClient, context).resetAllOverrides(serial)
    );
    if (failures.length === 0) {
      vscode.window.showInformationMessage('Device overrides reset.');
    } else {
      vscode.window.showWarningMessage(`Reset finished, but these could not be cleared: ${failures.join(', ')}.`);
    }
  });
}

// ── Helpers ──

async function pickAvd(placeholder: string): Promise<string | undefined> {
  const avds = await avdManager.listAvds();
  if (avds.length === 0) {
    vscode.window.showWarningMessage('No AVDs found.');
    return undefined;
  }
  const pick = await vscode.window.showQuickPick(
    avds.map(a => ({ label: a.displayName || a.name, avdName: a.name })),
    { placeHolder: placeholder }
  );
  return pick?.avdName;
}

async function pickDevice(): Promise<string | undefined> {
  const devices = deviceTracker.getDevices().filter(d => d.state === 'device');
  if (devices.length === 0) {
    vscode.window.showWarningMessage('No connected devices.');
    return undefined;
  }
  if (devices.length === 1) { return devices[0].serial; }
  const pick = await vscode.window.showQuickPick(
    devices.map(d => ({ label: d.model, description: d.serial, serial: d.serial })),
    { placeHolder: 'Select a device' }
  );
  return pick?.serial;
}

async function pickPackage(serial: string, placeholder: string): Promise<string | undefined> {
  const packages = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Loading installed apps...' },
    () => adbClient.listPackages(serial, true)
  );

  if (packages.length === 0) {
    vscode.window.showInformationMessage('No third-party apps found.');
    return undefined;
  }

  const pick = await vscode.window.showQuickPick(
    packages.map(p => ({ label: p })),
    { placeHolder: placeholder }
  );
  return pick?.label;
}

function guessLanguage(filename: string): string | undefined {
  const ext = path.extname(filename).toLowerCase();
  const map: Record<string, string> = {
    '.xml': 'xml', '.json': 'json', '.properties': 'properties',
    '.txt': 'plaintext', '.log': 'log', '.sh': 'shellscript',
    '.py': 'python', '.js': 'javascript', '.html': 'html',
    '.css': 'css', '.java': 'java', '.kt': 'kotlin',
    '.gradle': 'groovy', '.conf': 'ini', '.cfg': 'ini',
  };
  return map[ext];
}

async function syncRunningAvds(devices: DeviceInfo[]): Promise<void> {
  if (!avdTreeProvider || !avdManager) { return; }

  const runningNames = new Set<string>();
  for (const d of devices) {
    if (d.type === 'emulator' && d.state === 'device') {
      try {
        const name = await adbClient.getEmulatorAvdName(d.serial);
        if (name) {
          runningNames.add(name);
          avdManager.markRunning(name, d.serial);
        }
      } catch {
        // skip
      }
    }
  }

  // Drop AVDs that are no longer running, so the tracked serial (and therefore
  // the Stop command) never points at a dead emulator.
  avdManager.reconcileRunning(runningNames);

  // Only watch host memory while there is something to protect.
  if (runningNames.size > 0) { memoryWatcher?.start(); } else { memoryWatcher?.stop(); }

  avdTreeProvider.updateRunningStatus(runningNames);
}

/** Pick and apply a cutout or navigation-bar emulation mode. */
async function applyOverlayMode(serial: string, category: OverlayCategory): Promise<void> {
  const isCutout = category === 'cutout';
  const modes = isCutout ? CUTOUT_MODES : NAVBAR_MODES;
  const minApi = isCutout ? OVERLAY_MIN_API.CUTOUT : OVERLAY_MIN_API.NAVBAR;
  const what = isCutout ? 'Display cutout' : 'Navigation mode';

  try {
    const api = await adbClient.getApiLevel(serial);
    if (api && api < minApi) {
      vscode.window.showWarningMessage(
        `${what} emulation needs Android ${minApi === 28 ? '9' : '10'} (API ${minApi}) or newer; this device is API ${api}.`,
      );
      return;
    }

    const overlays = new SystemUiOverlayController(adbClient);
    const available = await overlays.available(serial, category);
    const active = await overlays.current(serial, category);

    const items = modes
      .filter(m => !m.pkg || available.has(m.pkg))
      .map(m => ({
        label: `${m.id === active ? '$(check) ' : ''}${m.label}`,
        description: m.id === active ? 'current' : undefined,
        detail: m.description,
        id: m.id,
        pkg: m.pkg,
      }));

    if (items.length <= 1) {
      vscode.window.showWarningMessage(
        `This system image does not ship the ${isCutout ? 'cutout' : 'navigation bar'} emulation overlays.`,
      );
      return;
    }

    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: `${what} for ${serial}`,
      ignoreFocusOut: true,
    });
    if (!pick) { return; }

    const applied = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Applying ${pick.detail}...`, cancellable: false },
      () => overlays.apply(serial, category, pick.pkg),
    );

    // Read back rather than trust the command: `cmd overlay` reports success
    // even when the overlay is not actually installed or was rejected.
    if (applied === pick.id) {
      vscode.window.showInformationMessage(`${what}: ${pick.detail}.`);
    } else {
      vscode.window.showWarningMessage(
        `${what} did not change — the device still reports "${applied}". `
        + 'Some images ignore these overlays.',
      );
    }
  } catch (err) {
    vscode.window.showErrorMessage(`Could not set the ${isCutout ? 'cutout' : 'navigation mode'}: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Offer to clean up overrides left on a device by a run this session never saw
 * — a crash that lost globalState, another machine, or an older build.
 *
 * Deliberately separate from checkPendingRestores, which can only act on
 * records this extension wrote.
 */
async function checkLeftoverOverrides(context: vscode.ExtensionContext, serial: string): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG.SECTION);
  if (!cfg.get<boolean>(CONFIG.CAPTURE_DETECT_LEFTOVERS, true)) { return; }
  if (leftoverPrompted.has(serial)) { return; }
  if (captureInFlight.has(serial)) { return; }

  const manager = new DeviceStateManager(adbClient, context);
  // A pending record means checkPendingRestores owns this device; a second
  // prompt for the same thing would be noise.
  if (manager.getPending(serial)) { return; }

  const found = await manager.detectLeftoverOverrides(serial);
  if (found.length === 0) { return; }

  leftoverPrompted.add(serial);
  Logger.info(`Leftover overrides on ${serial}: ${found.join('; ')}`);

  const choice = await vscode.window.showWarningMessage(
    `${serial} still has ${found.join(', ')} from an earlier capture run.`,
    'Reset Overrides',
    "Don't Check Again",
  );
  if (choice === 'Reset Overrides') {
    vscode.commands.executeCommand(COMMANDS.RESET_DEVICE_OVERRIDES, { device: { serial } });
  } else if (choice === "Don't Check Again") {
    await cfg.update(CONFIG.CAPTURE_DETECT_LEFTOVERS, false, vscode.ConfigurationTarget.Global);
  }
}

function autoSelectFileExplorerDevice(devices: DeviceInfo[]): void {
  if (!fileExplorerProvider) { return; }

  const autoSelect = vscode.workspace.getConfiguration(CONFIG.SECTION)
    .get<boolean>(CONFIG.AUTO_SELECT_DEVICE, true);
  if (!autoSelect) { return; }

  const connected = devices.filter(d => d.state === 'device');
  if (connected.length === 0) { return; }

  const current = fileExplorerProvider.getCurrentDevice();
  if (!current) {
    const device = connected[0];
    fileExplorerProvider.setDevice(device);
    // Emulators report state=device before the shell is ready — retry a few
    // times so the file explorer populates automatically after boot
    if (device.type === 'emulator') {
      let attempts = 0;
      const retry = setInterval(() => {
        attempts++;
        fileExplorerProvider.refresh();
        if (attempts >= 5) { clearInterval(retry); }
      }, 5000);
    }
  }
}

function updateStatusBar(devices: DeviceInfo[]): void {
  if (!statusBarItem) { return; }
  const connected = devices.filter(d => d.state === 'device');
  if (connected.length === 0) {
    statusBarItem.text = '$(device-mobile) No devices';
    statusBarItem.tooltip = 'Click to select a device';
  } else {
    statusBarItem.text = `$(device-mobile) ${connected.length} device${connected.length > 1 ? 's' : ''}`;
    statusBarItem.tooltip = connected.map(d => `${d.model} (${d.serial})`).join('\n') + '\n\nClick to select active device';
  }
}

// ── Launch ──

/**
 * Shared launch path for LAUNCH_AVD and COLD_BOOT_AVD, so the two cannot drift.
 */
async function launchAvdWithPreflight(
  avdName: string,
  opts: { coldBoot: boolean; wipeData?: boolean },
): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(CONFIG.SECTION);
  // Spread: getConfiguration().get() returns shared (frozen) config state, and
  // the previous code pushed straight into it.
  const extraArgs = [...cfg.get<string[]>(CONFIG.EMULATOR_ARGS, [])];

  // A force-killed emulator left an unflushed snapshot behind; loading it is
  // exactly the hang we are trying to avoid, so escalate to a cold boot.
  const coldBoot = opts.coldBoot || opts.wipeData
    || cfg.get<boolean>(CONFIG.COLD_BOOT, false)
    || snapshotSuspect.has(avdName);
  if (coldBoot && !extraArgs.includes('-no-snapshot-load')) {
    extraArgs.push('-no-snapshot-load');
  }
  if (opts.wipeData && !extraArgs.includes('-wipe-data')) {
    extraArgs.push('-wipe-data');
  }

  if (!(await runLaunchPreflight(avdManager, avdName))) { return; }

  const captureLog = cfg.get<boolean>(CONFIG.CAPTURE_LOG, true);
  const proc = avdManager.launchEmulator(avdName, extraArgs, captureLog);
  snapshotSuspect.delete(avdName);

  const timeoutSec = cfg.get<number>(CONFIG.BOOT_TIMEOUT_SEC, BOOT_WATCH.DEFAULT_TIMEOUT_SEC);

  vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Starting ${avdName}`,
      // Cancelling stops the watch, not the emulator — the message says so.
      cancellable: true,
    },
    async (progress, token) => {
      const started = Date.now();
      const deadline = started + timeoutSec * 1000;
      let serial: string | undefined;
      let phase: BootPhase = 'offline';
      let wedgedStreak = 0;

      progress.report({ message: describeBootPhase('offline') });

      while (Date.now() < deadline) {
        if (token.isCancellationRequested) {
          Logger.info(`Stopped watching the boot of ${avdName}; the emulator is still starting.`);
          avdTreeProvider.refresh();
          return;
        }
        await new Promise(r => setTimeout(r, BOOT_WATCH.POLL_MS));

        const failure = captureLog ? avdManager.readLaunchFailure(avdName) : undefined;
        if (failure) {
          avdTreeProvider.refresh();
          reportLaunchProblem(avdName, `Emulator failed to start: ${failure}`);
          return;
        }
        if (proc.process && proc.process.exitCode !== null && proc.process.exitCode !== 0) {
          avdTreeProvider.refresh();
          reportLaunchProblem(avdName, `Emulator exited immediately (code ${proc.process.exitCode}).`);
          return;
        }

        // Resolve the serial once, then probe the guest itself. `adb devices`
        // reporting state=device is a console-port signal, not a boot signal.
        if (!serial) {
          try {
            for (const d of await adbClient.getDevices()) {
              if (d.type === 'emulator' && d.state === 'device') {
                if (await adbClient.getEmulatorAvdName(d.serial) === avdName) { serial = d.serial; break; }
              }
            }
          } catch { /* adb not ready yet */ }
          if (!serial) { continue; }
          avdManager.markRunning(avdName, serial);
          avdTreeProvider.refresh();
        }

        const signals = await probeBootState(adbClient, serial);
        const next = classifyBoot(signals, Date.now() - started);
        if (next !== phase) {
          phase = next;
          progress.report({ message: describeBootPhase(phase) });
        }

        if (phase === 'ready') {
          Logger.info(`${avdName} finished booting in ${Math.round((Date.now() - started) / 1000)}s.`);
          avdTreeProvider.refresh();
          return;
        }

        // Require the verdict twice running before giving up on a boot: a
        // single unlucky probe against a busy guest is not evidence of a hang.
        wedgedStreak = next === 'wedged' ? wedgedStreak + 1 : 0;
        if (wedgedStreak >= 2) {
          avdTreeProvider.refresh();
          reportLaunchProblem(
            avdName,
            `${avdName} started but Android never finished booting`
            + `${signals.pmError ? ` — the package manager reports "${signals.pmError.split('\n')[0].trim()}"` : ''}. `
            + 'This is usually too little guest RAM or a corrupt snapshot.',
          );
          return;
        }
      }

      avdTreeProvider.refresh();
      // Previously this fell through silently, making a slow boot and a hang
      // look identical. Say which one it was.
      reportLaunchProblem(
        avdName,
        `${avdName} has not finished booting after ${timeoutSec}s (${describeBootPhase(phase).toLowerCase()}).`,
      );
    }
  );
}

/**
 * Report a failed or stalled launch, opening the captured log automatically.
 *
 * The log is the thing that actually explains a PANIC or an OOM, and asking the
 * user to go find "Show Emulator Launch Log" after the fact is why these
 * failures read as unexplained hangs.
 */
function reportLaunchProblem(avdName: string, message: string): void {
  const captureLog = vscode.workspace.getConfiguration(CONFIG.SECTION).get<boolean>(CONFIG.CAPTURE_LOG, true);
  if (captureLog && fs.existsSync(avdManager.getLaunchLogPath(avdName))) {
    vscode.commands.executeCommand(COMMANDS.SHOW_EMULATOR_LOG, { avd: { name: avdName } });
  }
  vscode.window.showErrorMessage(message, 'Repair...', 'Show Log').then(choice => {
    if (choice === 'Repair...') {
      vscode.commands.executeCommand(COMMANDS.REPAIR_AVD, { avd: { name: avdName } });
    } else if (choice === 'Show Log') {
      vscode.commands.executeCommand(COMMANDS.SHOW_EMULATOR_LOG, { avd: { name: avdName } });
    }
  });
}

/**
 * Escalating repair for an emulator that will not start or will not stop.
 *
 * Ordered cheapest-first, and each rung states what it costs — the wipe in
 * particular destroys app data and any placed home-screen widgets, which is not
 * recoverable and not obvious from the word "wipe".
 */
async function repairAvd(avdName: string): Promise<void> {
  const serial = await resolveAvdSerial(avdName);

  interface RepairAction extends vscode.QuickPickItem { id: string }
  const actions: RepairAction[] = [];

  if (serial) {
    actions.push({
      id: 'stop',
      label: '$(debug-stop) Stop the emulator cleanly',
      description: 'adb emu kill',
      detail: 'Asks the emulator to shut down and save its snapshot. Always try this first.',
    });
  }
  actions.push({
    id: 'cold',
    label: '$(debug-restart) Cold boot — discard the saved snapshot',
    description: '-no-snapshot-load',
    detail: 'Boots from scratch. Slower, but fixes a snapshot that was saved in a bad state. App data is kept.',
  });
  actions.push({
    id: 'wipe',
    label: '$(trash) Wipe data — factory reset the virtual device',
    description: '-wipe-data',
    detail: 'Destroys all app data, accounts, and home-screen widgets on this AVD. The first boot afterwards is slow.',
  });

  const pick = await vscode.window.showQuickPick(actions, {
    placeHolder: `Repair "${avdName}" — start with the least destructive option`,
    ignoreFocusOut: true,
  });
  if (!pick) { return; }

  if (pick.id === 'stop' && serial) {
    const stopped = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Stopping ${avdName}...`, cancellable: false },
      () => avdManager.stopEmulator(serial),
    );
    avdTreeProvider.refresh();
    if (stopped) {
      vscode.window.showInformationMessage(`"${avdName}" stopped.`);
      return;
    }

    const force = await vscode.window.showWarningMessage(
      `"${avdName}" ignored the shutdown request.`,
      {
        modal: true,
        detail: 'Force-killing the emulator process stops it immediately, but qemu never gets to flush its '
          + 'state, so the saved snapshot is left corrupt. Caspian will cold boot this AVD next time to avoid '
          + 'loading it. App data is not affected.',
      },
      'Force Kill',
    );
    if (force !== 'Force Kill') { return; }

    const killed = await avdManager.forceKillEmulator(avdName);
    snapshotSuspect.add(avdName);
    avdTreeProvider.refresh();
    vscode.window.showWarningMessage(
      killed
        ? `"${avdName}" was force-killed. Its next start will be a cold boot.`
        : `Caspian has no handle on the "${avdName}" process — it was started outside this window. `
          + 'Close the emulator window directly, then cold boot it.',
    );
    return;
  }

  if (pick.id === 'wipe') {
    const confirm = await vscode.window.showWarningMessage(
      `Wipe all data on "${avdName}"?`,
      {
        modal: true,
        detail: 'This factory-resets the virtual device. Every installed app, signed-in account, and '
          + 'home-screen widget on it is destroyed and cannot be recovered. The next boot takes several minutes.',
      },
      'Wipe Data',
    );
    if (confirm !== 'Wipe Data') { return; }
  }

  if (serial) {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Stopping ${avdName}...`, cancellable: false },
      () => avdManager.stopEmulator(serial),
    );
  }
  await launchAvdWithPreflight(avdName, { coldBoot: true, wipeData: pick.id === 'wipe' });
}

/**
 * Find the serial of a running AVD.
 *
 * Prefers the tracked value, then falls back to asking every emulator its AVD
 * name — the tracked map is empty for emulators started before this window.
 */
async function resolveAvdSerial(avdName: string): Promise<string | undefined> {
  try {
    for (const d of await adbClient.getDevices()) {
      if (d.type !== 'emulator' || d.state !== 'device') { continue; }
      try {
        if (await adbClient.getEmulatorAvdName(d.serial) === avdName) { return d.serial; }
      } catch { /* device busy — try the next one */ }
    }
  } catch (err) {
    Logger.warn(`Could not resolve a serial for ${avdName}: ${err}`);
  }
  return undefined;
}

// ── AVD display check ──

/** Languages that are written right-to-left, for the matrix wizard. */
const RTL_LANGUAGES = new Set(['ar', 'he', 'iw', 'fa', 'ur', 'ps', 'sd', 'yi', 'dv']);

const COMMON_DISPLAY_SPECS = [
  { label: '1080×2400 @ 420 dpi', width: 1080, height: 2400, density: 420, hint: 'Pixel 6/7/8' },
  { label: '1080×1920 @ 420 dpi', width: 1080, height: 1920, density: 420, hint: 'Classic 16:9 phone' },
  { label: '1440×3120 @ 560 dpi', width: 1440, height: 3120, density: 560, hint: 'Pixel 6 Pro/7 Pro' },
  { label: '1280×2856 @ 480 dpi', width: 1280, height: 2856, density: 480, hint: 'Pixel 9 Pro' },
  { label: '1440×3040 @ 560 dpi', width: 1440, height: 3040, density: 560, hint: 'Pixel 4 XL' },
  { label: '2560×1600 @ 320 dpi', width: 2560, height: 1600, density: 320, hint: 'Pixel Tablet' },
  { label: '1280×800 @ 160 dpi', width: 1280, height: 800, density: 160, hint: '10" tablet' },
];

async function checkAvdDisplay(avdName: string): Promise<void> {
  const config = avdManager.readAvdConfig(avdName);

  // Runtime layer only for a running emulator — never a physical device.
  let runtime: RuntimeDisplay | undefined;
  const running = deviceTracker.getDevices().filter(d => d.type === 'emulator' && d.state === 'device');
  let runningSerial: string | undefined;
  for (const d of running) {
    try {
      if (await adbClient.getEmulatorAvdName(d.serial) === avdName) { runningSerial = d.serial; break; }
    } catch { /* keep looking */ }
  }
  if (runningSerial) {
    try {
      const [size, density] = await Promise.all([
        adbClient.getWmSize(runningSerial),
        adbClient.getWmDensity(runningSerial),
      ]);
      runtime = {
        size: size.physical,
        override: size.override,
        density: density.physical,
        densityOverride: density.override,
      };
    } catch (err) {
      Logger.warn(`wm query failed for ${runningSerial}: ${err}`);
    }
  }

  const strict = vscode.workspace.getConfiguration(CONFIG.SECTION)
    .get<boolean>(CONFIG.PLAY_STRICT_ASPECT, false);
  const report = analyzeDisplay(config, avdName, runtime, {
    strictPlayAspect: strict,
    skinPathExists: (p) => fs.existsSync(p),
    checkGuestRam: vscode.workspace.getConfiguration(CONFIG.SECTION).get<boolean>(CONFIG.CHECK_GUEST_RAM, true),
  });

  Logger.info(formatDisplayReport(report));

  if (report.issues.length === 0) {
    vscode.window.showInformationMessage(
      `"${avdName}" looks correct: ${report.summary}, ${report.ramMb || 'default'} MB RAM. `
      + `Play screenshot ratio ${report.play.ratio.toFixed(2)}:1.`
    );
    return;
  }

  interface Action { label: string; description?: string; detail?: string; id: string }
  const actions: Action[] = [];
  if (report.issues.some(i => i.kind === 'ram-below-floor' || i.kind === 'ram-implausible') && report.ramFloorMb) {
    actions.push({
      label: `$(check) Raise RAM to ${report.ramFloorMb} MB`,
      description: 'Recommended — writes hw.ramSize, survives wipe',
      detail: `Currently ${report.ramMb || 'unset'} MB. Below ${report.ramFloorMb} MB this image swaps and stops responding.`,
      id: 'fix-ram',
    });
  }
  if (report.suggestion) {
    actions.push({
      label: `$(check) Fix config.ini → ${report.suggestion.width}×${report.suggestion.height} @ ${report.suggestion.density} dpi`,
      description: 'Recommended — permanent, survives wipe',
      detail: report.suggestedPreset ? `Matched preset: ${report.suggestedPreset.name}` : undefined,
      id: 'fix-preset',
    });
  }
  actions.push({ label: '$(edit) Choose a resolution…', description: 'Pick a common display or enter W×H', id: 'fix-manual' });
  if (report.issues.some(i => i.kind === 'runtime-override')) {
    actions.push({
      label: '$(discard) Clear runtime override (wm size/density reset)',
      description: 'Undoes a temporary adb override — does not survive wipe',
      id: 'reset-wm',
    });
  }
  if (report.issues.some(i => i.kind === 'skin-conflict')) {
    actions.push({ label: '$(circle-slash) Detach conflicting skin', description: 'Sets skin.path=_no_skin', id: 'fix-skin' });
  }
  actions.push({ label: '$(go-to-file) Open config.ini', id: 'open' });

  const pick = await vscode.window.showQuickPick(actions, {
    placeHolder: `${avdName}: ${report.issues.map(i => i.message).join('  •  ')}`,
    ignoreFocusOut: true,
  });
  if (!pick) { return; }

  if (pick.id === 'open') {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(avdManager.getConfigPath(avdName)));
    await vscode.window.showTextDocument(doc);
    return;
  }

  if (pick.id === 'reset-wm') {
    if (!runningSerial) {
      vscode.window.showWarningMessage('That AVD is not running, so there is no runtime override to clear.');
      return;
    }
    await adbClient.resetWmSize(runningSerial);
    await adbClient.resetWmDensity(runningSerial);
    vscode.window.showInformationMessage('Runtime display overrides cleared.');
    return;
  }

  if (avdManager.isRunning(avdName)) {
    vscode.window.showWarningMessage('Stop the emulator before changing its configuration.');
    return;
  }

  let props: Record<string, string> | undefined;

  if (pick.id === 'fix-ram') {
    props = {
      'hw.ramSize': String(report.ramFloorMb),
      'vm.heapSize': String(heapForRamMb(report.ramFloorMb)),
    };
  } else if (pick.id === 'fix-skin') {
    props = { 'skin.path': '_no_skin' };
    if (report.config) { props['skin.name'] = `${report.config.width}x${report.config.height}`; }
  } else if (pick.id === 'fix-preset' && report.suggestion) {
    props = {
      'hw.lcd.width': String(report.suggestion.width),
      'hw.lcd.height': String(report.suggestion.height),
      'hw.lcd.density': String(report.suggestion.density),
    };
    if (report.suggestedPreset && (report.ramMb === 0 || report.ramMb <= DISPLAY_RULES.AOSP_FALLBACK_RAM_MB)) {
      props['hw.ramSize'] = String(report.suggestedPreset.ram);
      props['vm.heapSize'] = String(report.suggestedPreset.heap);
    }
  } else if (pick.id === 'fix-manual') {
    const specPick = await vscode.window.showQuickPick(
      [
        ...COMMON_DISPLAY_SPECS.map(s => ({ label: s.label, description: s.hint, spec: s })),
        { label: '$(edit) Custom…', description: 'Enter width, height, and density', spec: undefined },
      ],
      { placeHolder: 'Select a display size' }
    );
    if (!specPick) { return; }

    let width: number, height: number, density: number;
    if (specPick.spec) {
      ({ width, height, density } = specPick.spec);
    } else {
      const sizeInput = await vscode.window.showInputBox({
        prompt: 'Display size',
        placeHolder: '1080x2400',
        validateInput: v => /^\d{3,4}\s*[x×]\s*\d{3,4}$/.test(v.trim()) ? null : 'Enter a size like 1080x2400',
      });
      if (!sizeInput) { return; }
      const m = sizeInput.trim().match(/^(\d+)\s*[x×]\s*(\d+)$/)!;
      width = parseInt(m[1], 10);
      height = parseInt(m[2], 10);

      const densityInput = await vscode.window.showInputBox({
        prompt: 'Display density (dpi)',
        value: '420',
        validateInput: v => {
          const n = parseInt(v, 10);
          return Number.isFinite(n) && n >= DISPLAY_RULES.SANE_MIN_DENSITY && n <= DISPLAY_RULES.SANE_MAX_DENSITY
            ? null
            : `Enter a density between ${DISPLAY_RULES.SANE_MIN_DENSITY} and ${DISPLAY_RULES.SANE_MAX_DENSITY}`;
        },
      });
      if (!densityInput) { return; }
      density = parseInt(densityInput, 10);
    }
    props = {
      'hw.lcd.width': String(width),
      'hw.lcd.height': String(height),
      'hw.lcd.density': String(density),
    };
  }

  if (!props) { return; }

  // disk.dataPartition.size is deliberately never written here: shrinking it
  // below the existing userdata image corrupts the AVD.
  avdManager.updateAvdConfig(avdName, props, { backup: true });
  avdTreeProvider.refresh();

  vscode.window.showInformationMessage(
    `"${avdName}" updated. Changing the display or RAM invalidates the saved snapshot, so the next start must be a cold boot.`,
    'Cold Boot Now'
  ).then(c => {
    if (c === 'Cold Boot Now') { vscode.commands.executeCommand(COMMANDS.COLD_BOOT_AVD, { avd: { name: avdName } }); }
  });
}

// ── Capture ──

function deviceLabelFor(serial: string): string {
  const device = deviceTracker.getDevices().find(d => d.serial === serial);
  return device?.model || serial;
}

async function askRunName(): Promise<string | undefined> {
  return vscode.window.showInputBox({
    prompt: 'Capture run name (a folder under the capture directory)',
    value: suggestRunName(),
    validateInput: v => /^[A-Za-z0-9._-]+$/.test(v.trim()) ? null : 'Use only letters, numbers, dots, underscores, and hyphens',
  });
}

async function reportCaptureRun(
  runDir: string,
  manifest: RunManifest,
  headline: string,
): Promise<void> {
  const reportPath = writeRunReport(runDir, manifest);
  const openAfter = vscode.workspace.getConfiguration(CONFIG.SECTION).get<boolean>(CONFIG.CAPTURE_OPEN_AFTER, true);
  if (openAfter) {
    await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(reportPath));
  }
  vscode.window.showInformationMessage(headline, 'Open Folder', 'View Report').then(c => {
    if (c === 'Open Folder') { vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(runDir)); }
    if (c === 'View Report') { vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(reportPath)); }
  });
}

async function captureStoreScreenshots(context: vscode.ExtensionContext, serial: string): Promise<void> {
  if (captureInFlight.has(serial)) {
    vscode.window.showWarningMessage('A capture run is already in progress on that device.');
    return;
  }
  const runName = await askRunName();
  if (!runName) { return; }

  const useDemoMode = vscode.workspace.getConfiguration(CONFIG.SECTION)
    .get<boolean>(CONFIG.CAPTURE_USE_DEMO_MODE, true);
  const deviceLabel = deviceLabelFor(serial);

  // Persist a restore record before touching anything. captureOrientations
  // restores in a finally, but that never runs if VS Code dies mid-run — which
  // used to leave rotation pinned and demo mode on with nothing to recover from.
  const stateManager = new DeviceStateManager(adbClient, context);
  const snapshot = await stateManager.capture(serial, deviceLabel, {
    rotation: true,
    demo: useDemoMode,
    // The tablet trick moves wm density, which survives a reboot.
    density: vscode.workspace.getConfiguration(CONFIG.SECTION).get<boolean>(CONFIG.CAPTURE_TABLET_TRICK, false),
  });
  snapshot.demoModeEntered = useDemoMode;
  await stateManager.persist(snapshot);

  captureInFlight.add(serial);
  EmulatorScreenPanel.setPaused(serial, true);
  try {
    const service = new CaptureService(adbClient);
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Capturing store screenshots on ${deviceLabel}...`, cancellable: true },
      (progress, token) => service.captureOrientations(serial, deviceLabel, runName, { useDemoMode, token, progress })
    );

    const failed = outcome.results.filter(r => r.validation.level === 'fail').length;
    const warned = outcome.results.filter(r => r.validation.level === 'warn').length;
    const suffix = failed ? ` — ${failed} failed Play validation` : warned ? ` (${warned} warning${warned > 1 ? 's' : ''})` : '';

    await reportCaptureRun(outcome.runDir, {
      runName,
      startedAt: new Date().toISOString(),
      device: { serial, label: deviceLabel },
      notes: outcome.notes,
      results: outcome.results,
    }, `Captured ${outcome.results.length} screenshot${outcome.results.length === 1 ? '' : 's'}${suffix}.`);

    for (const note of outcome.notes) { vscode.window.showWarningMessage(note); }
  } finally {
    EmulatorScreenPanel.setPaused(serial, false);
    captureInFlight.delete(serial);
    // captureOrientations already restored rotation and demo mode in its own
    // finally, so the record has served its purpose either way.
    await stateManager.clearPending(serial).catch(() => { /* best effort */ });
    updateDemoStatusBar();
  }
}

async function runCaptureMatrix(context: vscode.ExtensionContext, serial: string): Promise<void> {
  if (captureInFlight.has(serial)) {
    vscode.window.showWarningMessage('A capture run is already in progress on that device.');
    return;
  }

  const packageName = await pickPackage(serial, 'Select the app to test');
  if (!packageName) { return; }

  const cfg = vscode.workspace.getConfiguration(CONFIG.SECTION);
  const apiLevel = await adbClient.getApiLevel(serial);

  // Locale axis
  let locales: string[] = [];
  if (apiLevel >= PER_APP_LOCALE_MIN_API) {
    const configured = cfg.get<string[]>(CONFIG.CAPTURE_LOCALES, []);
    const items = [
      ...configured.map(tag => ({ label: tag, description: 'From settings', tag })),
      ...PSEUDOLOCALES.map(p => ({ label: p.tag, description: p.description, tag: p.tag })),
    ];
    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: 'Select languages to capture (none = current language only)',
    });
    if (!picked) { return; }
    locales = picked.map(p => p.tag);
    for (const tag of locales) { assertSafeShellToken(tag, 'locale tag'); }
  } else {
    const choice = await vscode.window.showWarningMessage(
      'Per-app language settings require Android 13 (API 33).',
      {
        modal: true,
        detail: `This device reports API ${apiLevel}. "cmd locale set-app-locales" does not exist before `
          + 'Android 13, and the alternatives change the whole system, need a framework restart, and are '
          + 'unreliable on production images — Caspian does not do that.',
      },
      'Open Language Settings', 'Continue Without Languages'
    );
    if (choice === 'Open Language Settings') {
      await adbClient.shell(serial, ['am', 'start', '-a', 'android.settings.LOCALE_SETTINGS']);
      return;
    }
    if (choice !== 'Continue Without Languages') { return; }
  }

  // Font scale axis
  const defaultScales = cfg.get<number[]>(CONFIG.CAPTURE_FONT_SCALES, [1, 1.3]);
  const fontPick = await vscode.window.showQuickPick(
    FONT_SCALE_STOPS.map(s => ({
      label: `${s}×`,
      description: s === 1 ? 'Default' : s >= 1.8 ? 'Where text overflow usually shows up' : undefined,
      picked: defaultScales.includes(s),
      scale: s,
    })),
    { canPickMany: true, placeHolder: 'Select font scales (none = leave unchanged)' }
  );
  if (!fontPick) { return; }
  const fontScales = fontPick.map(p => p.scale);

  // Density axis — default to none selected; this is the risky one.
  let densities: number[] = [];
  try {
    const current = await adbClient.getWmDensity(serial);
    const physical = current.physical;
    if (physical) {
      const options = [
        { dpi: physical, label: `${physical} dpi (default)` },
        { dpi: Math.round(physical * 0.85), label: `${Math.round(physical * 0.85)} dpi (small)` },
        { dpi: Math.round(physical * 1.15), label: `${Math.round(physical * 1.15)} dpi (large)` },
        { dpi: Math.round(physical * 1.3), label: `${Math.round(physical * 1.3)} dpi (largest)` },
      ];
      const densityPick = await vscode.window.showQuickPick(
        options.map(o => ({ label: o.label, dpi: o.dpi })),
        { canPickMany: true, placeHolder: 'Select display sizes (none = leave unchanged)' }
      );
      if (!densityPick) { return; }
      densities = densityPick.map(p => p.dpi);
    }
  } catch (err) {
    Logger.warn(`Could not read display density on ${serial}: ${err}`);
  }

  // Orientation axis
  const orientationPick = await vscode.window.showQuickPick(
    [
      { label: 'Portrait', picked: true, value: 'portrait' as Orientation },
      { label: 'Landscape', picked: false, value: 'landscape' as Orientation },
    ],
    { canPickMany: true, placeHolder: 'Select orientations' }
  );
  if (!orientationPick || orientationPick.length === 0) { return; }
  const orientations = orientationPick.map(p => p.value);

  // Forcing RTL is only worth asking about when no RTL language was picked:
  // capturing in ar or ar-XB already gives real right-to-left layout with real
  // text, which is the stronger test.
  let forceRtl = false;
  if (!locales.some(tag => RTL_LANGUAGES.has(tag.split('-')[0].toLowerCase()) || tag === 'ar-XB')) {
    const rtlPick = await vscode.window.showQuickPick(
      [
        { label: 'No', description: 'Capture with the normal layout direction', value: false },
        { label: 'Yes', description: 'Turn on "Force RTL layout direction" for the run', value: true },
      ],
      { placeHolder: 'Force right-to-left layout?' }
    );
    if (!rtlPick) { return; }
    forceRtl = rtlPick.value;
  }

  const runName = await askRunName();
  if (!runName) { return; }

  const dims: MatrixDimensions = { locales, fontScales, densities, orientations, forceRtl };
  const total = countCells(dims);
  const deviceLabel = deviceLabelFor(serial);

  const confirm = await vscode.window.showInformationMessage(
    `Capture ${total} screenshot${total === 1 ? '' : 's'} of ${packageName} on ${deviceLabel}?`,
    {
      modal: true,
      detail: 'Display settings are changed temporarily and restored when the run finishes, '
        + 'including if you cancel it.',
    },
    'Start'
  );
  if (confirm !== 'Start') { return; }

  const stateManager = new DeviceStateManager(adbClient, context);
  let snapshot: DeviceStateSnapshot | undefined;

  captureInFlight.add(serial);
  EmulatorScreenPanel.setPaused(serial, true);
  try {
    snapshot = await stateManager.capture(serial, deviceLabel, {
      rotation: true,
      fontScale: fontScales.length > 0,
      density: densities.length > 0,
      rtl: dims.forceRtl,
      demo: true,
      packages: locales.length > 0 ? [packageName] : [],
    });
    // Persisted BEFORE the first mutation: this is the layer that survives a
    // VS Code crash, which a finally block cannot.
    await stateManager.persist(snapshot);

    const demo = new DemoModeController(adbClient);
    const useDemoMode = cfg.get<boolean>(CONFIG.CAPTURE_USE_DEMO_MODE, true);
    const notes: string[] = [];
    if (useDemoMode && !DemoModeController.isActive(serial)) {
      try {
        await demo.enter(serial);
        snapshot.demoModeEntered = true;
        await stateManager.persist(snapshot);
      } catch (err) {
        notes.push(`Screenshot mode unavailable: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Hand the runner the demo controller so it can re-apply screenshot mode
    // after a density change restarts SystemUI.
    const runner = new MatrixRunner(
      adbClient,
      new CaptureService(adbClient),
      DemoModeController.isActive(serial) ? demo : undefined,
    );
    const outcome = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Capture matrix on ${deviceLabel}`, cancellable: true },
      (progress, token) => runner.run(
        { serial, deviceLabel, packageName, runName },
        dims, progress, token
      )
    );

    const { dir: runDir } = resolveRunDirectory(runName);
    const failed = outcome.results.filter(r => r.validation.level === 'fail').length;
    await reportCaptureRun(runDir, {
      runName,
      startedAt: new Date(snapshot.takenAt).toISOString(),
      device: { serial, label: deviceLabel, apiLevel },
      packageName,
      dimensions: { ...dims },
      notes: [...notes, ...outcome.notes],
      results: outcome.results,
    }, `Captured ${outcome.results.length} screenshot${outcome.results.length === 1 ? '' : 's'}${failed ? ` — ${failed} failed Play validation` : ''}.`);
  } finally {
    if (snapshot) {
      // Restore lives OUTSIDE the cancellable progress: cancelling means "stop
      // capturing", not "abandon my device in a modified state".
      const failures = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Restoring device settings...', cancellable: false },
        () => stateManager.restore(snapshot!)
      );
      if (failures.length === 0) {
        await stateManager.clearPending(serial);
      } else {
        vscode.window.showWarningMessage(
          `Device not fully restored: ${failures.join('; ')}.`,
          'Retry Restore'
        ).then(async c => {
          if (c === 'Retry Restore') {
            const again = await stateManager.restore(snapshot!);
            if (again.length === 0) { await stateManager.clearPending(serial); }
          }
        });
      }
    }
    EmulatorScreenPanel.setPaused(serial, false);
    captureInFlight.delete(serial);
    updateDemoStatusBar();
  }
}

/** Offer to undo settings left behind by a run that did not finish cleanly. */
async function checkPendingRestores(context: vscode.ExtensionContext): Promise<void> {
  const manager = new DeviceStateManager(adbClient, context);
  const connected = new Set(deviceTracker.getDevices().filter(d => d.state === 'device').map(d => d.serial));

  for (const snapshot of manager.listPending()) {
    if (!connected.has(snapshot.serial)) { continue; }
    const choice = await vscode.window.showWarningMessage(
      `Caspian left display settings modified on ${snapshot.deviceLabel} during a previous run.`,
      'Restore Now', 'Dismiss'
    );
    if (choice === 'Restore Now') {
      const failures = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Restoring device settings...', cancellable: false },
        () => manager.restore(snapshot)
      );
      if (failures.length === 0) {
        await manager.clearPending(snapshot.serial);
        vscode.window.showInformationMessage('Device settings restored.');
      } else {
        vscode.window.showWarningMessage(`Could not restore: ${failures.join('; ')}.`);
      }
    } else if (choice === 'Dismiss') {
      await manager.clearPending(snapshot.serial);
    }
  }
}

function updateDemoStatusBar(): void {
  if (!demoStatusBarItem) { return; }
  const active = DemoModeController.activeSerials();
  if (active.length === 0) {
    demoStatusBarItem.hide();
  } else {
    demoStatusBarItem.text = '$(device-camera) Screenshot Mode';
    demoStatusBarItem.tooltip = `Demo mode is on for ${active.join(', ')}.\n`
      + 'Battery, signal, and clock are faked. Click to turn it off.';
    demoStatusBarItem.show();
  }
  vscode.commands.executeCommand('setContext', 'caspian.demoModeActive', active.length > 0);
}

export function deactivate(): void {
  deviceTracker?.stop();
}

async function connectPhoneGuide(): Promise<void> {
  const steps = [
    'Step 1/4 — Enable Developer Options: Open Settings → About Phone → tap "Build Number" 7 times until you see "You are now a developer!"',
    'Step 2/4 — Enable USB Debugging: Go to Settings → Developer Options → turn on "USB Debugging"',
    'Step 3/4 — Connect via USB: Plug your phone into your computer with a USB data cable (not a charge-only cable)',
    'Step 4/4 — Authorize the connection: A dialog will appear on your phone — tap "Allow USB Debugging". Check "Always allow from this computer" to skip this step in future.',
  ];

  for (let i = 0; i < steps.length; i++) {
    const isLast = i === steps.length - 1;
    const choice = await vscode.window.showInformationMessage(steps[i], isLast ? 'Done' : 'Next →', 'Cancel');
    if (!choice || choice === 'Cancel') { return; }
  }
}

export interface SdkInfo {
  path: string;
  adbPath: string;
  emulatorPath: string;
  avdmanagerPath: string;
  sdkmanagerPath: string;
  valid: boolean;
}

export interface AvdInfo {
  name: string;
  displayName: string;
  device: string;
  target: string;
  apiLevel: number;
  abi: string;
  skin: string;
  sdcard: string;
  path: string;
  running: boolean;
  serial?: string;
  /** hw.lcd.width — 0 when absent from config.ini */
  lcdWidth: number;
  /** hw.lcd.height — 0 when absent from config.ini */
  lcdHeight: number;
  /** hw.lcd.density — 0 when absent from config.ini */
  lcdDensity: number;
  /** hw.ramSize in MB — 0 when absent from config.ini */
  ramMb: number;
  /** Precomputed by getAvdInfo so the tree stays synchronous. */
  displayHealthy: boolean;
  /** "1280×2856" or "no display config" */
  displaySummary: string;
  /** Short reason shown in the tooltip when the display is unhealthy. */
  displayProblem?: string;
}

/** Hardware properties written into an AVD's config.ini after creation. */
export interface AvdHardware {
  width: number;
  height: number;
  /** Android density bucket in dpi (hw.lcd.density) — not physical ppi. */
  density: number;
  /** hw.ramSize, MB */
  ram: number;
  /** vm.heapSize, MB */
  heap: number;
  orientation: 'portrait' | 'landscape';
  /** disk.dataPartition.size — applied at creation only, never on repair. */
  dataPartition?: string;
  /** Written as hw.device.name when avdmanager did not accept -d. */
  profileId?: string;
  manufacturer?: string;
}

export interface AvdCreateResult {
  /** True when avdmanager accepted -d <profile>. */
  profileApplied: boolean;
  /** Keys written into config.ini after creation. */
  hardwareWritten: string[];
  /** Effective display read back from config.ini. */
  effective: { width: number; height: number; density: number };
}

export interface DeviceInfo {
  serial: string;
  state: 'device' | 'offline' | 'unauthorized' | 'no permissions';
  type: 'emulator' | 'physical';
  model: string;
  product: string;
  transportId: string;
}

export interface LogcatEntry {
  timestamp: string;
  pid: string;
  tid: string;
  priority: LogcatPriority;
  tag: string;
  message: string;
}

export type LogcatPriority = 'V' | 'D' | 'I' | 'W' | 'E' | 'F' | 'S';

export interface DeviceFile {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink';
  size: number;
  permissions: string;
  owner: string;
  group: string;
  date: string;
}

export interface SystemImage {
  path: string;
  apiLevel: number;
  tag: string;
  abi: string;
  description: string;
  installed: boolean;
}

export interface DeviceProfile {
  id: string;
  name: string;
  manufacturer: string;
  screenSize: string;
  resolution: string;
}

export interface JavaInfo {
  found: boolean;
  version: string;
  path: string;
}

export interface DiskSpaceInfo {
  available: number;
  sufficient: boolean;
}

export interface EmulatorProcess {
  avdName: string;
  serial: string;
  pid: number;
  process: import('child_process').ChildProcess;
  /** Where this launch's emulator output was redirected, when capture is on. */
  logPath?: string;
}

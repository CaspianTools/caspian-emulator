import { spawn, execFile } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { SdkInfo, DeviceInfo, LogcatEntry, DeviceFile } from '../types';
import { Logger } from '../utils/Logger';

export type SettingsNamespace = 'system' | 'secure' | 'global';

export interface WmSize {
  physical?: { w: number; h: number };
  override?: { w: number; h: number };
}

export interface WmDensity {
  physical?: number;
  override?: number;
}

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Characters safe to pass through `adb shell`, which re-parses the joined argv
 * on the device. Deliberately conservative.
 */
const SAFE_SHELL_TOKEN = /^[A-Za-z0-9._:@,+\-/]+$/;

export function assertSafeShellToken(value: string, what: string): void {
  if (!SAFE_SHELL_TOKEN.test(value)) {
    throw new Error(`Invalid ${what}: "${value}" contains characters that are unsafe to pass to the device shell.`);
  }
}

export class AdbClient {
  private adbPath: string;
  private apiLevelCache = new Map<string, number>();
  private screencapCounter = 0;

  constructor(sdk: SdkInfo) {
    this.adbPath = sdk.adbPath;
  }

  /** Execute an ADB command and return stdout */
  exec(args: string[], serial?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const fullArgs = serial ? ['-s', serial, ...args] : args;
      Logger.debug(`adb ${fullArgs.join(' ')}`);
      execFile(this.adbPath, fullArgs, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          let msg = `adb ${fullArgs.join(' ')} failed: ${stderr || err.message}`;
          // Provide actionable message for common ADB daemon issues
          if (stderr && (stderr.includes('daemon not running') || stderr.includes('cannot connect to daemon'))) {
            msg = `ADB daemon failed to start. Make sure no other process is using port 5037, then try "Caspian: Refresh Device List". Details: ${stderr.trim()}`;
          }
          Logger.error(msg);
          reject(new Error(msg));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /** Execute an ADB command and return stdout as a raw Buffer (for binary data like screencap) */
  execBinary(args: string[], serial?: string): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const fullArgs = serial ? ['-s', serial, ...args] : args;
      Logger.debug(`adb (binary) ${fullArgs.join(' ')}`);
      const proc = spawn(this.adbPath, fullArgs);
      const chunks: Buffer[] = [];
      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      let stderr = '';
      proc.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
      proc.on('error', (err) => reject(err));
      proc.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`adb (binary) exited ${code}: ${stderr}`));
          return;
        }
        resolve(Buffer.concat(chunks));
      });
    });
  }

  /** Execute an ADB command with automatic retry for transient failures */
  async execWithRetry(args: string[], serial?: string, retries: number = 3): Promise<string> {
    let lastError: Error | undefined;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        return await this.exec(args, serial);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        const msg = lastError.message;
        // Only retry on transient errors
        const transient = msg.includes('device offline') ||
          msg.includes('error: closed') ||
          msg.includes('no devices') ||
          msg.includes('Connection refused') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('protocol fault');
        if (!transient || attempt === retries) { break; }
        Logger.warn(`Transient ADB error (attempt ${attempt}/${retries}), retrying in ${attempt}s...`);
        await new Promise(r => setTimeout(r, attempt * 1000));
      }
    }
    throw lastError;
  }

  /** Get list of connected devices */
  async getDevices(): Promise<DeviceInfo[]> {
    const output = await this.exec(['devices', '-l']);
    const lines = output.trim().split('\n').slice(1); // skip header
    const devices: DeviceInfo[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) { continue; }

      const match = trimmed.match(/^(\S+)\s+(device|offline|unauthorized|no permissions)\s*(.*)/);
      if (!match) { continue; }

      const [, serial, state, rest] = match;
      const props = new Map<string, string>();
      for (const pair of rest.matchAll(/(\w+):(\S+)/g)) {
        props.set(pair[1], pair[2]);
      }

      devices.push({
        serial,
        state: state as DeviceInfo['state'],
        type: serial.startsWith('emulator-') ? 'emulator' : 'physical',
        model: props.get('model') || 'Unknown',
        product: props.get('product') || 'Unknown',
        transportId: props.get('transport_id') || '',
      });
    }

    return devices;
  }

  /** Get a device property */
  async getProp(serial: string, prop: string): Promise<string> {
    const output = await this.exec(['shell', 'getprop', prop], serial);
    return output.trim();
  }

  /** Install an APK on a device */
  async installApk(serial: string, apkPath: string, onProgress?: (msg: string) => void): Promise<void> {
    onProgress?.('Uploading APK...');
    await this.exec(['install', '-r', apkPath], serial);
    onProgress?.('APK installed successfully.');
    Logger.info(`APK installed on ${serial}: ${apkPath}`);
  }

  /** Take a screenshot and save to local path */
  async screenshot(serial: string, localPath: string): Promise<void> {
    const remotePath = '/sdcard/caspian_screenshot.png';
    await this.exec(['shell', 'screencap', '-p', remotePath], serial);
    await this.exec(['pull', remotePath, localPath], serial);
    await this.exec(['shell', 'rm', remotePath], serial);
    Logger.info(`Screenshot saved: ${localPath}`);
  }

  /** Start screen recording, returns the spawned process */
  startScreenRecording(serial: string, remotePath: string = '/sdcard/caspian_recording.mp4') {
    const args = ['-s', serial, 'shell', 'screenrecord', remotePath];
    Logger.info(`Screen recording started on ${serial}`);
    return spawn(this.adbPath, args);
  }

  /** Pull screen recording from device */
  async pullScreenRecording(serial: string, localPath: string, remotePath: string = '/sdcard/caspian_recording.mp4'): Promise<void> {
    await this.exec(['pull', remotePath, localPath], serial);
    await this.exec(['shell', 'rm', remotePath], serial);
    Logger.info(`Screen recording saved: ${localPath}`);
  }

  /** List files in a directory on the device */
  async listFiles(serial: string, remotePath: string): Promise<DeviceFile[]> {
    const output = await this.exec(['shell', 'ls', '-la', remotePath], serial);
    const lines = output.trim().split('\n');
    const files: DeviceFile[] = [];

    for (const line of lines) {
      const match = line.match(
        /^([drwxlst-]{10})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)?\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})\s+(.+)$/
      );
      if (!match) { continue; }

      const [, permissions, , owner, group, sizeStr, date, name] = match;

      if (name === '.' || name === '..') { continue; }

      let type: DeviceFile['type'] = 'file';
      if (permissions.startsWith('d')) { type = 'directory'; }
      else if (permissions.startsWith('l')) { type = 'symlink'; }

      // For symlinks, strip the target part
      const displayName = type === 'symlink' ? name.split(' -> ')[0] : name;

      files.push({
        name: displayName,
        path: remotePath.endsWith('/') ? remotePath + displayName : remotePath + '/' + displayName,
        type,
        size: parseInt(sizeStr || '0', 10),
        permissions,
        owner,
        group,
        date,
      });
    }

    return files;
  }

  /** Pull a file from the device */
  async pullFile(serial: string, remotePath: string, localPath: string): Promise<void> {
    await this.exec(['pull', remotePath, localPath], serial);
  }

  /** Push a file to the device */
  async pushFile(serial: string, localPath: string, remotePath: string): Promise<void> {
    await this.exec(['push', localPath, remotePath], serial);
  }

  /** Delete a file on the device */
  async deleteFile(serial: string, remotePath: string, isDirectory: boolean): Promise<void> {
    if (isDirectory) {
      await this.exec(['shell', 'rm', '-rf', remotePath], serial);
    } else {
      await this.exec(['shell', 'rm', remotePath], serial);
    }
  }

  /** Create a directory on the device */
  async createDirectory(serial: string, remotePath: string): Promise<void> {
    await this.exec(['shell', 'mkdir', '-p', remotePath], serial);
    Logger.info(`Created directory on ${serial}: ${remotePath}`);
  }

  /** Rename/move a file on the device */
  async renameFile(serial: string, oldPath: string, newPath: string): Promise<void> {
    await this.exec(['shell', 'mv', oldPath, newPath], serial);
    Logger.info(`Renamed on ${serial}: ${oldPath} → ${newPath}`);
  }

  /** Read a small text file from the device */
  async readFile(serial: string, remotePath: string): Promise<string> {
    return await this.exec(['shell', 'cat', remotePath], serial);
  }

  /** Start logcat stream, returns spawned process */
  startLogcat(serial: string, filter?: string) {
    const args = ['-s', serial, 'logcat', '-v', 'threadtime'];
    if (filter) {
      args.push(filter);
    }
    Logger.info(`Logcat started for ${serial}${filter ? ` (filter: ${filter})` : ''}`);
    return spawn(this.adbPath, args);
  }

  /** Parse a single logcat line */
  static parseLogcatLine(line: string): LogcatEntry | undefined {
    // Format: 02-25 12:34:56.789  1234  5678 I Tag     : Message
    const match = line.match(
      /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFS])\s+(\S+)\s*:\s*(.*)$/
    );
    if (!match) { return undefined; }

    return {
      timestamp: match[1],
      pid: match[2],
      tid: match[3],
      priority: match[4] as LogcatEntry['priority'],
      tag: match[5],
      message: match[6],
    };
  }

  /** Get the AVD name running on an emulator serial */
  async getEmulatorAvdName(serial: string): Promise<string> {
    try {
      const output = await this.exec(['emu', 'avd', 'name'], serial);
      return output.trim().split('\n')[0];
    } catch {
      return '';
    }
  }

  // ── App management ──

  /** List installed packages on a device */
  async listPackages(serial: string, thirdPartyOnly: boolean = true): Promise<string[]> {
    const args = ['shell', 'pm', 'list', 'packages'];
    if (thirdPartyOnly) { args.push('-3'); }
    const output = await this.exec(args, serial);
    return output.trim().split('\n')
      .filter(Boolean)
      .map(line => line.replace('package:', '').trim())
      .sort();
  }

  /** Launch an app by package name */
  async launchApp(serial: string, packageName: string): Promise<void> {
    await this.exec(['shell', 'monkey', '-p', packageName, '-c', 'android.intent.category.LAUNCHER', '1'], serial);
    Logger.info(`Launched app on ${serial}: ${packageName}`);
  }

  /** Force stop an app */
  async forceStopApp(serial: string, packageName: string): Promise<void> {
    await this.exec(['shell', 'am', 'force-stop', packageName], serial);
    Logger.info(`Force stopped on ${serial}: ${packageName}`);
  }

  /** Clear app data */
  async clearAppData(serial: string, packageName: string): Promise<void> {
    await this.exec(['shell', 'pm', 'clear', packageName], serial);
    Logger.info(`Cleared data on ${serial}: ${packageName}`);
  }

  /** Uninstall an app */
  async uninstallApp(serial: string, packageName: string): Promise<void> {
    await this.exec(['uninstall', packageName], serial);
    Logger.info(`Uninstalled on ${serial}: ${packageName}`);
  }

  /** Get PIDs for a given package name (for logcat filtering) */
  async getPackagePids(serial: string, packageName: string): Promise<string[]> {
    try {
      const output = await this.exec(['shell', 'pidof', packageName], serial);
      return output.trim().split(/\s+/).filter(Boolean);
    } catch {
      return [];
    }
  }

  // ── Device settings & capture ──

  /**
   * Run `adb shell <args...>`.
   *
   * IMPORTANT: exec() uses execFile, so Node does not invoke a host shell — but
   * adb joins the argv with spaces and hands the resulting string to the
   * *device's* sh, which re-parses it. Metacharacters (; & | $ ` " ' space) in
   * any element are interpreted on the device. Run untrusted values through
   * assertSafeShellToken() before they get here.
   */
  async shell(serial: string, args: string[]): Promise<string> {
    return this.exec(['shell', ...args], serial);
  }

  /** Retrying variant, for commands issued against a still-booting device. */
  async shellRetry(serial: string, args: string[]): Promise<string> {
    return this.execWithRetry(['shell', ...args], serial);
  }

  /**
   * Read a device setting. Returns null when unset — `settings get` prints the
   * literal string "null", and that distinction is what makes restore correct
   * (put the old value back vs. delete the key entirely).
   */
  async getSetting(serial: string, ns: SettingsNamespace, key: string): Promise<string | null> {
    const out = (await this.shell(serial, ['settings', 'get', ns, key])).trim();
    return out === '' || out === 'null' ? null : out;
  }

  async putSetting(serial: string, ns: SettingsNamespace, key: string, value: string | number): Promise<void> {
    await this.shell(serial, ['settings', 'put', ns, key, String(value)]);
  }

  async deleteSetting(serial: string, ns: SettingsNamespace, key: string): Promise<void> {
    await this.shell(serial, ['settings', 'delete', ns, key]);
  }

  /** Device API level, cached per serial. */
  async getApiLevel(serial: string): Promise<number> {
    const cached = this.apiLevelCache.get(serial);
    if (cached !== undefined) { return cached; }
    const level = parseInt(await this.getProp(serial, 'ro.build.version.sdk'), 10) || 0;
    this.apiLevelCache.set(serial, level);
    return level;
  }

  /** Drop cached per-device facts (call when a serial disconnects). */
  clearDeviceCache(serial: string): void {
    this.apiLevelCache.delete(serial);
  }

  /**
   * Send `am broadcast -a <action> [-e k v]...`.
   *
   * Note there is no success signal: am reports "Broadcast completed: result=0"
   * whether or not the receiver acted on the intent.
   */
  async broadcast(serial: string, action: string, extras: Array<[string, string]> = []): Promise<string> {
    const args = ['am', 'broadcast', '-a', action];
    for (const [k, v] of extras) { args.push('-e', k, v); }
    return this.shellRetry(serial, args);
  }

  /**
   * Capture the framebuffer as a PNG buffer.
   *
   * Prefers `exec-out`, which is one round trip (vs. screencap → pull → rm),
   * writes nothing to /sdcard, and uses the raw exec: service so there is no
   * PTY to mangle LF into CRLF — which corrupts PNGs on Windows. Falls back to
   * the push/pull path for old adb/devices where exec-out is unavailable.
   */
  async captureScreenshotBuffer(serial: string): Promise<Buffer> {
    try {
      const buf = await this.execBinary(['exec-out', 'screencap', '-p'], serial);
      if (buf.length >= 24 && buf.subarray(0, 8).equals(PNG_SIGNATURE)) { return buf; }
      Logger.warn(`exec-out screencap returned ${buf.length} bytes of non-PNG on ${serial}; falling back to pull.`);
    } catch (err) {
      Logger.warn(`exec-out screencap failed on ${serial}: ${err}`);
    }

    const tmp = path.join(os.tmpdir(), `caspian-screencap-${process.pid}-${this.screencapCounter++}.png`);
    try {
      await this.screenshot(serial, tmp);
      return fs.readFileSync(tmp);
    } finally {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  /** Parse `wm size` output. */
  async getWmSize(serial: string): Promise<WmSize> {
    const out = await this.shell(serial, ['wm', 'size']);
    const physical = out.match(/Physical size:\s*(\d+)x(\d+)/);
    const override = out.match(/Override size:\s*(\d+)x(\d+)/);
    return {
      physical: physical ? { w: parseInt(physical[1], 10), h: parseInt(physical[2], 10) } : undefined,
      override: override ? { w: parseInt(override[1], 10), h: parseInt(override[2], 10) } : undefined,
    };
  }

  /** Parse `wm density` output. */
  async getWmDensity(serial: string): Promise<WmDensity> {
    const out = await this.shell(serial, ['wm', 'density']);
    const physical = out.match(/Physical density:\s*(\d+)/);
    const override = out.match(/Override density:\s*(\d+)/);
    return {
      physical: physical ? parseInt(physical[1], 10) : undefined,
      override: override ? parseInt(override[1], 10) : undefined,
    };
  }

  async setWmDensity(serial: string, dpi: number): Promise<void> {
    await this.shell(serial, ['wm', 'density', String(dpi)]);
  }

  async resetWmDensity(serial: string): Promise<void> {
    await this.shell(serial, ['wm', 'density', 'reset']);
  }

  async resetWmSize(serial: string): Promise<void> {
    await this.shell(serial, ['wm', 'size', 'reset']);
  }

  /** Lock the display to an absolute rotation (0=natural, 1=90° CCW, …). */
  async setUserRotation(serial: string, rotation: 0 | 1 | 2 | 3): Promise<void> {
    await this.putSetting(serial, 'system', 'accelerometer_rotation', 0);
    await this.putSetting(serial, 'system', 'user_rotation', rotation);
  }

  /** Per-app locales (API 33+). Returns [] when the app follows the system default. */
  async getAppLocales(serial: string, packageName: string): Promise<string[]> {
    const out = await this.shell(serial, ['cmd', 'locale', 'get-app-locales', packageName]);
    const m = out.match(/\[(.*?)\]/);
    if (!m) { return []; }
    return m[1].split(',').map(s => s.trim()).filter(Boolean);
  }

  /**
   * Set per-app locales (API 33+). An empty list resets to the system default.
   *
   * The reset MUST omit --locales entirely: adb joins argv with spaces, so
   * passing '' collapses to a bare flag with no value and the device shell
   * errors. AOSP's LocaleManagerShellCommand defaults to an empty LocaleList
   * when the flag is absent, which is exactly "follow the system".
   */
  async setAppLocales(serial: string, packageName: string, tags: string[]): Promise<void> {
    const args = ['cmd', 'locale', 'set-app-locales', packageName];
    if (tags.length > 0) { args.push('--locales', tags.join(',')); }
    await this.shell(serial, args);
  }

  /** Resolve a package's launcher activity as "pkg/.Activity" (API 24+). */
  async resolveLauncherActivity(serial: string, packageName: string): Promise<string | undefined> {
    try {
      const out = await this.shell(serial, ['cmd', 'package', 'resolve-activity', '--brief', packageName]);
      if (/No activity found/i.test(out)) { return undefined; }
      const last = out.trim().split('\n').map(l => l.trim()).filter(Boolean).pop();
      return last && /^[A-Za-z0-9_.]+\/[A-Za-z0-9_.$]+$/.test(last) ? last : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Force-stop and start an app, waiting for the launch to complete.
   *
   * `am start -W -S` gives a synchronous launch-complete signal, which beats
   * guessing a sleep. Note that am exits 0 even when it prints
   * "Error: Activity not started", so stdout must be parsed.
   */
  async startActivity(serial: string, target: { component?: string; packageName?: string }): Promise<string> {
    const args = ['am', 'start', '-W', '-S'];
    if (target.component) {
      args.push('-n', target.component);
    } else if (target.packageName) {
      args.push('-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', target.packageName);
    } else {
      throw new Error('startActivity requires a component or package name.');
    }
    const out = await this.shell(serial, args);
    const err = out.match(/^Error:.*$/m);
    if (err) { throw new Error(err[0].trim()); }
    return out;
  }

  // ── Wireless ADB ──

  /** Connect to a device over TCP/IP */
  async connectTcp(address: string): Promise<string> {
    const output = await this.exec(['connect', address]);
    Logger.info(`TCP connect: ${address} → ${output.trim()}`);
    return output.trim();
  }

  /** Disconnect a TCP device */
  async disconnectTcp(address: string): Promise<string> {
    const output = await this.exec(['disconnect', address]);
    Logger.info(`TCP disconnect: ${address}`);
    return output.trim();
  }

  /** Pair with a device for wireless debugging (Android 11+) */
  async pair(address: string, code: string): Promise<string> {
    const output = await this.exec(['pair', address, code]);
    Logger.info(`Paired with ${address}`);
    return output.trim();
  }
}

import { execFile } from 'child_process';
import { spawn, ChildProcess } from 'child_process';
import { SdkInfo, AvdInfo, SystemImage, DeviceProfile, EmulatorProcess, AvdHardware, AvdCreateResult } from '../types';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { Logger } from '../utils/Logger';
import { analyzeDisplay } from './DisplayCheck';
import { BOOT_WATCH } from '../constants';

export interface UpdateConfigOptions {
  /** false = only write keys that are absent from the file. Default true. */
  overwrite?: boolean;
  /** Write config.ini.caspian-bak first if no backup exists yet. Default false. */
  backup?: boolean;
}

export class AvdManager {
  private sdk: SdkInfo;
  private runningEmulators: Map<string, EmulatorProcess> = new Map();
  /**
   * Injected rather than read from workspace config, so this module stays free
   * of `vscode` and the display analysis stays a pure function of config.ini.
   */
  private checkGuestRam = true;

  constructor(sdk: SdkInfo) {
    this.sdk = sdk;
  }

  /** Mirror of caspian.avd.checkGuestRam; extension.ts keeps this in sync. */
  setCheckGuestRam(enabled: boolean): void {
    this.checkGuestRam = enabled;
  }

  /**
   * Quote a single argument for cmd.exe.
   *
   * On win32 we must pass `shell: true` (Node >= 18.20 refuses to spawn a .bat
   * without a shell), and in that mode Node builds `cmd.exe /d /s /c "<file>
   * <args joined by spaces>"` without quoting anything. Device profile ids such
   * as `7in WSVGA (Tablet)` would otherwise word-split and expose `(` and `)`
   * as cmd metacharacters.
   *
   * Known limitation: %VAR% inside a double-quoted cmd argument is still
   * expanded. No Android device id or system-image path contains '%'.
   */
  private static quoteWin(arg: string): string {
    if (arg.length > 0 && !/[\s"&()[\]{}^=;!'+,`~|<>%]/.test(arg)) { return arg; }
    const escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
    return `"${escaped}"`;
  }

  /** Platform-correct (file, args) pair for spawn/execFile. */
  private shellSafe(file: string, args: string[]): { file: string; args: string[] } {
    if (process.platform !== 'win32') { return { file, args }; }
    return { file: AvdManager.quoteWin(file), args: args.map(a => AvdManager.quoteWin(a)) };
  }

  /** Execute avdmanager command */
  private execAvdManager(args: string[]): Promise<string> {
    const safe = this.shellSafe(this.sdk.avdmanagerPath, args);
    return new Promise((resolve, reject) => {
      execFile(safe.file, safe.args, { maxBuffer: 5 * 1024 * 1024, ...(process.platform === 'win32' ? { shell: true } : {}) }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`avdmanager ${args.join(' ')} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /** Execute emulator command */
  private execEmulator(args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(this.sdk.emulatorPath, args, { maxBuffer: 5 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`emulator ${args.join(' ')} failed: ${stderr || err.message}`));
          return;
        }
        resolve(stdout);
      });
    });
  }

  /**
   * Execute an emulator command without rejecting on a non-zero exit.
   * `-accel-check` reports its diagnosis on stdout *and* exits non-zero, so the
   * throwing variant above discards exactly the information we need.
   */
  execEmulatorRaw(args: string[], timeoutMs = 8000): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(this.sdk.emulatorPath, args, { maxBuffer: 5 * 1024 * 1024, timeout: timeoutMs }, (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number'
          ? (err as unknown as { code: number }).code
          : err ? 1 : 0;
        resolve({ code, stdout: stdout || '', stderr: stderr || '' });
      });
    });
  }

  /** List all AVDs */
  async listAvds(): Promise<AvdInfo[]> {
    const output = await this.execEmulator(['-list-avds']);
    const avdNames = output.trim().split('\n').filter(Boolean);
    const avds: AvdInfo[] = [];

    for (const name of avdNames) {
      const info = await this.getAvdInfo(name.trim());
      if (info) {
        avds.push(info);
      }
    }

    return avds;
  }

  /** Get detailed info about a single AVD by reading its config.ini */
  private async getAvdInfo(name: string): Promise<AvdInfo | undefined> {
    const avdDir = this.getAvdDirectory(name);
    const configPath = path.join(avdDir, 'config.ini');

    if (!fs.existsSync(configPath)) {
      // Minimal info if config not found
      return {
        name,
        displayName: name,
        device: '',
        target: '',
        apiLevel: 0,
        abi: '',
        skin: '',
        sdcard: '',
        path: avdDir,
        running: this.runningEmulators.has(name),
        serial: this.runningEmulators.get(name)?.serial || undefined,
        lcdWidth: 0,
        lcdHeight: 0,
        lcdDensity: 0,
        ramMb: 0,
        displayHealthy: false,
        ramHealthy: true,
        ramFloorMb: 0,
        displaySummary: 'no config.ini',
        displayProblem: 'config.ini is missing for this AVD.',
      };
    }

    const config = this.parseIniFile(configPath);
    // Config-only analysis: no adb, so listAvds() stays cheap enough to run on
    // every tree refresh.
    const report = analyzeDisplay(config, name, undefined, { checkGuestRam: this.checkGuestRam });
    const firstError = report.issues.find(i => i.severity === 'error')
      || report.issues.find(i => i.severity === 'warning');

    return {
      name,
      displayName: config['avd.ini.displayname'] || name,
      device: config['hw.device.name'] || '',
      target: config['tag.id'] || 'default',
      apiLevel: parseInt(config['image.sysdir.1']?.match(/android-(\d+)/)?.[1] || '0', 10),
      abi: config['abi.type'] || '',
      skin: config['skin.name'] || '',
      sdcard: config['sdcard.size'] || '',
      path: avdDir,
      running: this.runningEmulators.has(name),
      // Read straight off the running map, so the serial survives listAvds()
      // rebuilding every AvdInfo — without this the Stop command has no serial.
      serial: this.runningEmulators.get(name)?.serial || undefined,
      lcdWidth: report.config?.width || 0,
      lcdHeight: report.config?.height || 0,
      lcdDensity: report.config?.density || 0,
      ramMb: report.ramMb,
      displayHealthy: report.healthy,
      ramHealthy: report.ramHealthy,
      ramFloorMb: report.ramFloorMb,
      displaySummary: report.config ? `${report.config.width}×${report.config.height}` : 'no display config',
      displayProblem: firstError?.message,
    };
  }

  /**
   * Root directory holding <name>.ini and <name>.avd/.
   *
   * Uses os.homedir() rather than process.env.HOME: under Git Bash / MSYS, HOME
   * is a POSIX path (/c/Users/name) and every config write would land in a
   * garbage directory. On win32 os.homedir() resolves USERPROFILE, which is
   * what the Android tools themselves use.
   */
  private getAvdHome(): string {
    if (process.env.ANDROID_AVD_HOME) { return process.env.ANDROID_AVD_HOME; }
    const prefs = process.env.ANDROID_PREFS_ROOT || process.env.ANDROID_SDK_HOME;
    if (prefs) { return path.join(prefs, '.android', 'avd'); }
    return path.join(os.homedir(), '.android', 'avd');
  }

  /**
   * Resolve an AVD's .avd directory. Prefers the `path=` key inside <name>.ini,
   * which is authoritative and handles AVDs stored on another drive.
   */
  private getAvdDirectory(name: string): string {
    const home = this.getAvdHome();
    const pointer = path.join(home, `${name}.ini`);
    try {
      if (fs.existsSync(pointer)) {
        const p = this.parseIniFile(pointer)['path'];
        if (p && fs.existsSync(p)) { return p; }
      }
    } catch { /* fall through to the conventional location */ }
    return path.join(home, `${name}.avd`);
  }

  /** Read an AVD's config.ini as key→value. Returns {} if absent or unreadable. */
  readAvdConfig(avdName: string): Record<string, string> {
    const p = this.getConfigPath(avdName);
    try {
      return fs.existsSync(p) ? this.parseIniFile(p) : {};
    } catch (err) {
      Logger.warn(`Could not read config.ini for ${avdName}: ${err}`);
      return {};
    }
  }

  /**
   * Update keys in an AVD's config.ini, preserving unknown keys, comments,
   * blank lines, line order, and the file's existing EOL convention.
   * Returns the keys actually written.
   *
   * Duplicate keys are collapsed to the first occurrence: parseIniFile is
   * last-write-wins, so leaving a stale second `hw.lcd.width=320` behind would
   * silently defeat the write.
   */
  updateAvdConfig(
    avdName: string,
    props: Record<string, string>,
    opts: UpdateConfigOptions = {},
  ): string[] {
    const overwrite = opts.overwrite !== false;
    const configPath = this.getConfigPath(avdName);
    if (!fs.existsSync(configPath)) {
      throw new Error(`config.ini not found for AVD "${avdName}" at ${configPath}`);
    }

    const original = fs.readFileSync(configPath, 'utf-8');
    const eol = original.includes('\r\n') ? '\r\n' : '\n';
    const lines = original.split(/\r?\n/);

    const keyOf = (line: string): string | undefined => {
      const i = line.indexOf('=');
      if (i <= 0) { return undefined; }
      const trimmed = line.trimStart();
      if (trimmed.startsWith('#') || trimmed.startsWith(';')) { return undefined; }
      return line.slice(0, i).trim();
    };

    const existing = new Set<string>();
    for (const line of lines) {
      const k = keyOf(line);
      if (k) { existing.add(k); }
    }

    const pending = new Map<string, string>(
      Object.entries(props).filter(([k]) => overwrite || !existing.has(k)),
    );
    if (pending.size === 0) { return []; }

    if (opts.backup) {
      const bak = `${configPath}.caspian-bak`;
      try {
        if (!fs.existsSync(bak)) { fs.writeFileSync(bak, original, 'utf-8'); }
      } catch (err) {
        Logger.warn(`Could not write config.ini backup for ${avdName}: ${err}`);
      }
    }

    const written = new Set<string>();
    const out: string[] = [];
    for (const line of lines) {
      const key = keyOf(line);
      if (key && pending.has(key)) {
        if (written.has(key)) { continue; }   // drop duplicate occurrences
        out.push(`${key}=${pending.get(key)}`);
        written.add(key);
        continue;
      }
      out.push(line);
    }

    while (out.length > 0 && out[out.length - 1].trim() === '') { out.pop(); }
    for (const [k, v] of pending) {
      if (!written.has(k)) { out.push(`${k}=${v}`); written.add(k); }
    }

    const content = out.join(eol) + eol;
    const tmp = `${configPath}.caspian-tmp`;
    try {
      fs.writeFileSync(tmp, content, 'utf-8');
      fs.renameSync(tmp, configPath);
    } catch {
      // Windows AV scanners occasionally EPERM the rename; fall back to a
      // direct (non-atomic) write rather than losing the update.
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
      fs.writeFileSync(configPath, content, 'utf-8');
    }
    Logger.info(`config.ini updated for ${avdName}: ${[...written].join(', ')}`);
    return [...written];
  }

  /** Parse an INI file into key-value pairs */
  private parseIniFile(filePath: string): Record<string, string> {
    const content = fs.readFileSync(filePath, 'utf-8');
    const result: Record<string, string> = {};
    for (const line of content.split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) {
        result[line.substring(0, idx).trim()] = line.substring(idx + 1).trim();
      }
    }
    return result;
  }

  /** List available system images */
  async listSystemImages(): Promise<SystemImage[]> {
    try {
      await this.execAvdManager(['list', 'target', '-c']);
      return this.parseSystemImagesFromSdk();
    } catch {
      return this.parseSystemImagesFromSdk();
    }
  }

  private async parseSystemImagesFromSdk(): Promise<SystemImage[]> {
    const safe = this.shellSafe(this.sdk.sdkmanagerPath, ['--list']);
    return new Promise((resolve) => {
      execFile(safe.file, safe.args, { maxBuffer: 10 * 1024 * 1024, ...(process.platform === 'win32' ? { shell: true } : {}) }, (err, stdout) => {
        if (err) {
          resolve([]);
          return;
        }
        const images: SystemImage[] = [];
        for (const line of stdout.split('\n')) {
          const match = line.match(/^\s*(system-images;android-(\d+);([^;]+);([^|\s]+))/);
          if (match) {
            images.push({
              path: match[1],
              apiLevel: parseInt(match[2], 10),
              tag: match[3],
              abi: match[4],
              description: match[1],
              installed: line.includes('Installed') || line.includes('installed'),
            });
          }
        }
        resolve(images);
      });
    });
  }

  /**
   * List available device profiles.
   *
   * Rejects when enumeration fails. Callers must distinguish "this SDK has no
   * such profile" from "we could not ask" — swallowing the error into an empty
   * array made a failed lookup indistinguishable from a genuinely empty list,
   * which silently produced AVDs with no display configuration at all.
   */
  async listDeviceProfiles(): Promise<DeviceProfile[]> {
    const output = await this.execAvdManager(['list', 'device', '-c']);
    return output.trim().split('\n').filter(Boolean).map(id => ({
      id: id.trim(),
      name: id.trim(),
      manufacturer: '',
      screenSize: '',
      resolution: '',
    }));
  }

  /** Run `avdmanager create avd`, capturing output instead of throwing. */
  private runAvdManagerCreate(
    name: string,
    systemImage: string,
    deviceProfile?: string,
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    const args = ['create', 'avd', '-n', name, '-k', systemImage, '--force'];
    if (deviceProfile) {
      args.push('-d', deviceProfile);
    }
    const safe = this.shellSafe(this.sdk.avdmanagerPath, args);

    return new Promise((resolve) => {
      const proc = spawn(safe.file, safe.args, { stdio: 'pipe', ...(process.platform === 'win32' ? { shell: true } : {}) });
      // Auto-answer "no" to custom hardware profile
      proc.stdin?.write('no\n');
      proc.stdin?.end();

      let stdout = '';
      let stderr = '';
      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });
      proc.on('error', (err) => { resolve({ code: -1, stdout, stderr: stderr || err.message }); });
      proc.on('close', (code) => { resolve({ code: code ?? -1, stdout, stderr }); });
    });
  }

  /**
   * Build the config.ini hardware properties for a preset.
   *
   * When avdmanager did not accept `-d`, nothing has written hw.lcd.* at all
   * and the emulator falls back to the AOSP hardware-properties.ini defaults
   * (320x640 @ 160 dpi, 96 MB RAM) — so we must supply a full display and an
   * explicit no-skin framebuffer of exactly our size.
   */
  private buildHardwareProps(hw: AvdHardware, profileApplied: boolean): Record<string, string> {
    const props: Record<string, string> = {
      'hw.lcd.width': String(hw.width),
      'hw.lcd.height': String(hw.height),
      'hw.lcd.density': String(hw.density),
      'hw.ramSize': String(hw.ram),
      'vm.heapSize': String(hw.heap),
      'hw.initialOrientation': hw.orientation,
      'hw.keyboard': 'yes',
    };
    if (hw.dataPartition) { props['disk.dataPartition.size'] = hw.dataPartition; }
    if (!profileApplied) {
      props['skin.name'] = `${hw.width}x${hw.height}`;
      props['skin.path'] = '_no_skin';
      if (hw.profileId) { props['hw.device.name'] = hw.profileId; }
      if (hw.manufacturer) { props['hw.device.manufacturer'] = hw.manufacturer; }
    }
    return props;
  }

  /**
   * Create a new AVD, guaranteeing it ends up with a real display.
   *
   * If `-d <profile>` fails because this SDK's cmdline-tools predate the device
   * definition, we retry without it and write the hardware ourselves.
   */
  async createAvd(
    name: string,
    systemImage: string,
    deviceProfile?: string,
    hardware?: AvdHardware,
  ): Promise<AvdCreateResult> {
    let result = await this.runAvdManagerCreate(name, systemImage, deviceProfile);
    let profileApplied = !!deviceProfile;

    if (result.code !== 0 && deviceProfile
        && /(no device|unknown device|device definition).*(found|exist)|Error: Device .* not found/i.test(result.stderr)) {
      Logger.warn(`Device profile "${deviceProfile}" was rejected by avdmanager; retrying without it.`);
      result = await this.runAvdManagerCreate(name, systemImage, undefined);
      profileApplied = false;
    }

    if (result.code !== 0) {
      throw new Error(`Failed to create AVD: ${result.stderr || result.stdout || `exit ${result.code}`}`);
    }

    let hardwareWritten: string[] = [];
    if (hardware) {
      const props = this.buildHardwareProps(hardware, profileApplied);
      // When -d applied, the SDK already wrote self-consistent hw.lcd.* and a
      // matching skin. Our static table is a fallback, not an authority — only
      // fill the gaps so a density estimate can't overwrite a correct value.
      hardwareWritten = this.updateAvdConfig(name, props, { overwrite: !profileApplied });

      // Escalate if the AOSP fallback fingerprint survived anyway.
      const after = this.readAvdConfig(name);
      const w = parseInt(after['hw.lcd.width'] || '0', 10);
      const h = parseInt(after['hw.lcd.height'] || '0', 10);
      if (!w || !h || (w === 320 && h === 640)) {
        Logger.warn(`AVD "${name}" still had no usable display after creation; forcing hardware properties.`);
        hardwareWritten = [...new Set([...hardwareWritten, ...this.updateAvdConfig(name, props, { overwrite: true })])];
      }
    }

    const final = this.readAvdConfig(name);
    return {
      profileApplied,
      hardwareWritten,
      effective: {
        width: parseInt(final['hw.lcd.width'] || '0', 10),
        height: parseInt(final['hw.lcd.height'] || '0', 10),
        density: parseInt(final['hw.lcd.density'] || '0', 10),
      },
    };
  }

  /** Install a system image via sdkmanager */
  async installSystemImage(systemImage: string): Promise<void> {
    const safe = this.shellSafe(this.sdk.sdkmanagerPath, ['--install', systemImage]);
    return new Promise((resolve, reject) => {
      const proc = execFile(
        safe.file,
        safe.args,
        { maxBuffer: 50 * 1024 * 1024, ...(process.platform === 'win32' ? { shell: true } : {}) },
        (err, _stdout, stderr) => {
          if (err) {
            reject(new Error(`Failed to install system image: ${stderr || err.message}`));
          } else {
            resolve();
          }
        }
      );
      // Accept any license prompts
      proc.stdin?.write('y\n'.repeat(10));
      proc.stdin?.end();
    });
  }

  /** Delete an AVD */
  async deleteAvd(name: string): Promise<void> {
    await this.execAvdManager(['delete', 'avd', '-n', name]);
  }

  /** Path of the launch log for an AVD. */
  getLaunchLogPath(avdName: string): string {
    return path.join(os.tmpdir(), 'caspian-emulator', `${avdName.replace(/[^\w.-]/g, '_')}.log`);
  }

  /**
   * Launch an emulator for the given AVD.
   *
   * Output is redirected to a per-AVD log file rather than 'ignore' (which
   * discarded PANIC: lines, making a failed launch look like a hang) and rather
   * than 'pipe' — with detached:true, an undrained 64 KB pipe buffer would
   * block the emulator on write and create a brand-new hang.
   */
  launchEmulator(avdName: string, extraArgs: string[] = [], captureLog = true): EmulatorProcess {
    const args = ['-avd', avdName, ...extraArgs];

    let stdio: 'ignore' | ['ignore', number, number] = 'ignore';
    let logPath: string | undefined;
    let fd: number | undefined;
    if (captureLog) {
      try {
        logPath = this.getLaunchLogPath(avdName);
        fs.mkdirSync(path.dirname(logPath), { recursive: true });
        fd = fs.openSync(logPath, 'w');
        stdio = ['ignore', fd, fd];
      } catch (err) {
        Logger.warn(`Could not open emulator log (${err}); launching without capture.`);
        logPath = undefined;
      }
    }

    const proc = spawn(this.sdk.emulatorPath, args, { stdio, detached: true });
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* the child holds its own handle */ }
    }

    // Allow the parent process to exit without waiting for the emulator
    proc.unref();

    const emulatorProc: EmulatorProcess = {
      avdName,
      serial: '', // Will be populated when device connects
      pid: proc.pid || 0,
      process: proc,
      logPath,
    };

    this.runningEmulators.set(avdName, emulatorProc);

    // Previously unhandled: an ENOENT on emulatorPath raised an 'error' event
    // with no listener, which crashes the extension host.
    proc.on('error', (err) => {
      Logger.error(`Failed to spawn emulator "${avdName}": ${err.message}`);
      this.runningEmulators.delete(avdName);
    });

    proc.on('exit', (code, signal) => {
      this.runningEmulators.delete(avdName);
      if (code !== null && code !== 0) {
        Logger.error(`Emulator ${avdName} exited with code ${code}${signal ? ` (${signal})` : ''}`);
      }
    });

    return emulatorProc;
  }

  /**
   * Patterns that mean the emulator died trying to set up rendering.
   *
   * Kept separate from the generic fatal list because these are the only
   * failures worth retrying with a different -gpu mode. The Qt one is what a
   * Windows host with a broken GL driver actually prints, and it matches none
   * of the generic patterns below — it carries no PANIC:/ERROR: prefix, so
   * before this it presented as a hang with no diagnosis.
   */
  private static readonly GRAPHICS_LOG_PATTERNS: RegExp[] = [
    /UpdateLayeredWindowIndirect failed/i,
    /Could not initialize (?:Open)?GL(?:ES)? emulation/i,
    /Failed to (?:initialize|create) (?:EGL|GL|OpenGL|renderer|the GPU)/i,
    /(?:emuglConfig_init|initOpenglesEmulation) failed/i,
    /No OpenGL ES (?:driver|renderer) (?:found|available)/i,
    /gpu (?:mode|emulation) .*(?:not supported|unavailable|failed)/i,
  ];

  /** Fatal patterns that mean the emulator will never finish booting. */
  private static readonly FATAL_LOG_PATTERNS: RegExp[] = [
    ...AvdManager.GRAPHICS_LOG_PATTERNS,
    /^PANIC:\s*(.+)$/m,
    /^ERROR:\s*(.+)$/m,
    /x86 emulation currently requires hardware acceleration/i,
    /^emulator: ERROR: (.+)$/m,
    /Failed to (?:open|create|load) .+/i,
  ];

  /** Whether a failure string is one a different -gpu mode might survive. */
  static isGraphicsFailure(text: string): boolean {
    return AvdManager.GRAPHICS_LOG_PATTERNS.some(p => p.test(text));
  }

  /**
   * Scan an AVD's launch log for a fatal error. Returns the first match, so a
   * boot that has actually died can be reported instead of polling for 60s.
   */
  readLaunchFailure(avdName: string): string | undefined {
    const logPath = this.getLaunchLogPath(avdName);
    try {
      if (!fs.existsSync(logPath)) { return undefined; }
      const stat = fs.statSync(logPath);
      const readLen = Math.min(stat.size, 64 * 1024);
      if (readLen === 0) { return undefined; }
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(readLen);
        fs.readSync(fd, buf, 0, readLen, Math.max(0, stat.size - readLen));
        const text = buf.toString('utf-8');
        for (const pattern of AvdManager.FATAL_LOG_PATTERNS) {
          const m = text.match(pattern);
          // "unknown device" is expected on the no-profile path — not fatal.
          if (m && !/unknown device/i.test(m[0])) { return m[0].trim(); }
        }
      } finally {
        fs.closeSync(fd);
      }
    } catch (err) {
      Logger.warn(`Could not read emulator log for ${avdName}: ${err}`);
    }
    return undefined;
  }

  /**
   * Stop a running emulator with `adb emu kill` and confirm it actually went.
   *
   * `adb emu kill` returning OK only means the console accepted the command —
   * a wedged guest can acknowledge it and keep running. Callers need to know
   * the difference, because the remedy (force-killing qemu) costs the snapshot.
   *
   * Returns true when the device left the device list within verifyMs.
   */
  async stopEmulator(serial: string, opts: { verifyMs?: number } = {}): Promise<boolean> {
    await new Promise<void>((resolve, reject) => {
      execFile(this.sdk.adbPath, ['-s', serial, 'emu', 'kill'], (err) => {
        if (err) { reject(err); }
        else { resolve(); }
      });
    });

    const verifyMs = opts.verifyMs ?? BOOT_WATCH.STOP_VERIFY_MS;
    const deadline = Date.now() + verifyMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, BOOT_WATCH.STOP_POLL_MS));
      if (!(await this.isSerialPresent(serial))) {
        for (const [name, proc] of this.runningEmulators) {
          if (proc.serial === serial) { this.runningEmulators.delete(name); }
        }
        Logger.info(`Emulator ${serial} stopped.`);
        return true;
      }
    }
    Logger.warn(`Emulator ${serial} did not stop within ${verifyMs}ms of "adb emu kill".`);
    return false;
  }

  /** True when adb still lists this serial at all, in any state. */
  private async isSerialPresent(serial: string): Promise<boolean> {
    return new Promise((resolve) => {
      execFile(this.sdk.adbPath, ['devices'], (err, stdout) => {
        if (err) { resolve(false); return; }
        resolve(stdout.split('\n').slice(1).some(l => l.trim().startsWith(serial)));
      });
    });
  }

  /**
   * Kill the emulator's own process, for a guest that ignored `adb emu kill`.
   *
   * This is the expensive rung: qemu never flushes, so the saved snapshot is
   * left corrupt and the next start must be a cold boot. Callers must say so
   * before calling this.
   */
  async forceKillEmulator(avdName: string): Promise<boolean> {
    const proc = this.runningEmulators.get(avdName);
    if (proc?.process && proc.process.exitCode === null) {
      try {
        proc.process.kill();
        this.runningEmulators.delete(avdName);
        Logger.warn(`Force-killed the emulator process for ${avdName}; its snapshot is now unusable.`);
        return true;
      } catch (err) {
        Logger.warn(`Could not force-kill ${avdName}: ${err}`);
      }
    }
    // Launched outside this session (detached + unref'd), so there is no handle.
    return false;
  }

  /** Check if an AVD is currently running */
  isRunning(avdName: string): boolean {
    return this.runningEmulators.has(avdName);
  }

  /** Mark an AVD as running (for externally launched emulators) */
  markRunning(avdName: string, serial: string): void {
    if (!this.runningEmulators.has(avdName)) {
      this.runningEmulators.set(avdName, {
        avdName,
        serial,
        pid: 0,
        process: null as unknown as ChildProcess,
      });
    } else {
      const existing = this.runningEmulators.get(avdName)!;
      existing.serial = serial;
    }
  }

  /** Mark AVD as stopped */
  markStopped(avdName: string): void {
    this.runningEmulators.delete(avdName);
  }

  /**
   * Drop tracked emulators that adb no longer reports.
   *
   * Entries whose spawned process is still alive are kept: an emulator we just
   * launched is tracked seconds before it appears in `adb devices`, and
   * forgetting it there would throw away the handle a force-kill needs.
   */
  reconcileRunning(liveAvdNames: Set<string>): void {
    for (const [name, proc] of [...this.runningEmulators]) {
      if (liveAvdNames.has(name)) { continue; }
      if (proc.process && proc.process.exitCode === null) { continue; }
      this.runningEmulators.delete(name);
      Logger.debug(`Emulator ${name} is no longer running.`);
    }
  }

  /** Clone an AVD by copying its directory and creating a new .ini reference */
  async cloneAvd(sourceName: string, newName: string): Promise<void> {
    const sourceDir = this.getAvdDirectory(sourceName);
    const targetDir = this.getAvdDirectory(newName);

    if (!fs.existsSync(sourceDir)) {
      throw new Error(`Source AVD directory not found: ${sourceDir}`);
    }
    if (fs.existsSync(targetDir)) {
      throw new Error(`Target AVD directory already exists: ${targetDir}`);
    }

    // Copy AVD directory
    fs.cpSync(sourceDir, targetDir, { recursive: true });

    // Update config.ini with new name
    const configPath = path.join(targetDir, 'config.ini');
    if (fs.existsSync(configPath)) {
      let config = fs.readFileSync(configPath, 'utf-8');
      config = config.replace(/avd\.ini\.displayname=.*/, `avd.ini.displayname=${newName}`);
      fs.writeFileSync(configPath, config);
    }

    // Create the .ini file that points to the AVD directory
    const avdHome = this.getAvdHome();
    const iniPath = path.join(avdHome, `${newName}.ini`);
    const sourceIniPath = path.join(avdHome, `${sourceName}.ini`);

    if (fs.existsSync(sourceIniPath)) {
      let iniContent = fs.readFileSync(sourceIniPath, 'utf-8');
      iniContent = iniContent.replace(sourceName, newName);
      fs.writeFileSync(iniPath, iniContent);
    }

    Logger.info(`AVD cloned: ${sourceName} → ${newName}`);
  }

  /** Get the config.ini path for editing */
  getConfigPath(avdName: string): string {
    return path.join(this.getAvdDirectory(avdName), 'config.ini');
  }
}

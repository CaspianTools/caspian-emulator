import * as https from 'https';
import * as http from 'http';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFile, spawn } from 'child_process';
import { JavaInfo, DiskSpaceInfo } from '../types';
import { SDK_DOWNLOAD, SDK_TOOLS } from '../constants';

export interface DownloadProgress {
  message: string;
  increment?: number;
}

type ProgressCallback = (p: DownloadProgress) => void;

export class SdkDownloader {
  private sdkRoot: string;

  /**
   * The image installComponents actually downloaded.
   *
   * Resolved once and reused by createDefaultAvd: querying twice would risk
   * downloading one image and creating the AVD against another, which fails
   * with a confusing "package path is not valid" at the very end of setup.
   */
  private resolvedSystemImage: string | undefined;

  constructor(sdkRoot?: string) {
    this.sdkRoot = sdkRoot || SdkDownloader.getDefaultInstallPath();
  }

  static getDefaultInstallPath(): string {
    switch (process.platform) {
      case 'win32':
        return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Android', 'Sdk');
      case 'darwin':
        return path.join(os.homedir(), 'Library', 'Android', 'sdk');
      default:
        return path.join(os.homedir(), 'Android', 'Sdk');
    }
  }

  getSdkRoot(): string {
    return this.sdkRoot;
  }

  /** The ABI whose system images run natively on this host. */
  static getSystemImageAbi(): string {
    const arch = os.arch();
    return (process.platform === 'darwin' && arch === 'arm64') ? 'arm64-v8a' : 'x86_64';
  }

  /**
   * Offline fallback image.
   *
   * Only used when `sdkmanager --list` cannot be read. Prefer
   * resolveLatestSystemImage, which asks the SDK what it actually offers
   * instead of shipping a number that goes stale every Android release.
   */
  static getDefaultSystemImage(): string {
    return `system-images;android-${SDK_DOWNLOAD.FALLBACK_API_LEVEL};google_apis;${SdkDownloader.getSystemImageAbi()}`;
  }

  /**
   * Ask the SDK for the newest stable Google APIs image it can install.
   *
   * The `android-(\d+)` anchor is doing real work: it rejects the `-ext`
   * sidegrade packages and the preview codename channels, both of which sort
   * unhelpfully and neither of which is what a first-run user wants.
   *
   * Never throws — a probe failure degrades to the pinned fallback.
   */
  static async resolveLatestSystemImage(sdkmanagerPath: string): Promise<string> {
    const abi = SdkDownloader.getSystemImageAbi();
    const fallback = SdkDownloader.getDefaultSystemImage();

    try {
      const stdout = await new Promise<string>((resolve, reject) => {
        // sdkmanager is a .bat on Windows, which needs a shell to run at all —
        // and a shell means the path must be quoted, or an SDK under a user
        // folder with a space in it splits into two arguments.
        // Node warns when an args array is combined with shell:true, so on
        // Windows the flag goes into the command string itself. It is a
        // constant, so there is nothing to escape.
        const isWin = process.platform === 'win32';
        execFile(
          isWin ? `"${sdkmanagerPath}" --list` : sdkmanagerPath,
          isWin ? [] : ['--list'],
          { timeout: 120000, maxBuffer: 32 * 1024 * 1024, windowsHide: true, shell: isWin },
          (err, out) => {
            // sdkmanager exits non-zero on warnings while still listing.
            if (err && !out) { reject(err); } else { resolve(out || ''); }
          },
        );
      });

      const pattern = new RegExp(`system-images;android-(\\d+);google_apis;${abi}(?![\\w-])`, 'g');
      let best = 0;
      for (const m of stdout.matchAll(pattern)) {
        const api = parseInt(m[1], 10);
        if (Number.isFinite(api) && api > best) { best = api; }
      }
      // Whatever the SDK offers wins, even if it is older than the pinned
      // fallback: an image that exists beats one that does not.
      if (best > 0) {
        return `system-images;android-${best};google_apis;${abi}`;
      }
    } catch {
      /* fall through to the pinned image */
    }

    return fallback;
  }

  /** Detect Java 17+ installation */
  async detectJava(): Promise<JavaInfo> {
    const notFound: JavaInfo = { found: false, version: '', path: '' };

    // Try JAVA_HOME first
    const javaHome = process.env.JAVA_HOME;
    if (javaHome) {
      const javaBin = path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java');
      if (fs.existsSync(javaBin)) {
        const version = await this.getJavaVersion(javaBin);
        if (version) {
          return { found: true, version, path: javaBin };
        }
      }
    }

    // Try java on PATH
    const javaBinName = process.platform === 'win32' ? 'java.exe' : 'java';
    const version = await this.getJavaVersion(javaBinName);
    if (version) {
      return { found: true, version, path: javaBinName };
    }

    // macOS: try /usr/libexec/java_home
    if (process.platform === 'darwin') {
      try {
        const jHome = await this.execCommand('/usr/libexec/java_home', ['-v', '17+']);
        const javaBin = path.join(jHome.trim(), 'bin', 'java');
        if (fs.existsSync(javaBin)) {
          const ver = await this.getJavaVersion(javaBin);
          if (ver) { return { found: true, version: ver, path: javaBin }; }
        }
      } catch { /* not found */ }
    }

    // Windows: check common JDK paths
    if (process.platform === 'win32') {
      const programFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
      const dirs = [
        path.join(programFiles, 'Java'),
        path.join(programFiles, 'Eclipse Adoptium'),
        path.join(programFiles, 'Microsoft'),
      ];
      for (const dir of dirs) {
        if (!fs.existsSync(dir)) { continue; }
        const entries = fs.readdirSync(dir).filter(e => e.startsWith('jdk'));
        for (const entry of entries) {
          const javaBin = path.join(dir, entry, 'bin', 'java.exe');
          if (fs.existsSync(javaBin)) {
            const ver = await this.getJavaVersion(javaBin);
            if (ver) { return { found: true, version: ver, path: javaBin }; }
          }
        }
      }
    }

    return notFound;
  }

  private getJavaVersion(javaBin: string): Promise<string> {
    return new Promise((resolve) => {
      execFile(javaBin, ['-version'], (err, _stdout, stderr) => {
        if (err) { resolve(''); return; }
        // java -version outputs to stderr: openjdk version "17.0.9" or java version "17.0.9"
        const output = stderr || _stdout;
        const match = output.match(/version "(\d+)/);
        resolve(match ? match[1] : '');
      });
    });
  }

  /** Check available disk space at the target path */
  async checkDiskSpace(): Promise<DiskSpaceInfo> {
    const targetDir = this.sdkRoot;
    // Find an existing parent directory to check
    let checkPath = targetDir;
    while (!fs.existsSync(checkPath)) {
      const parent = path.dirname(checkPath);
      if (parent === checkPath) { break; }
      checkPath = parent;
    }

    try {
      if (process.platform === 'win32') {
        const drive = checkPath.substring(0, 2); // e.g., "C:"
        // -NoProfile matters: a user profile script printing to stdout would
        // otherwise poison this parse and silently report 0 free bytes.
        const output = await this.execCommand('powershell', [
          '-NoProfile', '-NonInteractive',
          '-Command', `(Get-PSDrive ${drive[0]}).Free`,
        ]);
        const available = parseInt(output.trim(), 10);
        return { available, sufficient: available >= SDK_DOWNLOAD.MIN_DISK_SPACE };
      } else {
        const output = await this.execCommand('df', ['-k', checkPath]);
        const lines = output.trim().split('\n');
        if (lines.length >= 2) {
          const parts = lines[1].split(/\s+/);
          const available = parseInt(parts[3], 10) * 1024; // Convert KB to bytes
          return { available, sufficient: available >= SDK_DOWNLOAD.MIN_DISK_SPACE };
        }
      }
    } catch { /* fallback */ }

    // Fallback: assume sufficient (can't check)
    return { available: 0, sufficient: true };
  }

  /** Download Android SDK command-line tools */
  async downloadCommandLineTools(progress: ProgressCallback): Promise<string> {
    const platformKey = SDK_DOWNLOAD.PLATFORM_KEY[process.platform];
    if (!platformKey) {
      throw new Error(`Unsupported platform: ${process.platform}`);
    }

    const url = `${SDK_DOWNLOAD.BASE_URL}-${platformKey}-${SDK_DOWNLOAD.BUILD_NUMBER}_latest.zip`;
    const destPath = path.join(os.tmpdir(), `android-cmdline-tools-${Date.now()}.zip`);

    progress({ message: 'Downloading Android SDK command-line tools...' });
    await this.downloadFile(url, destPath, progress);
    return destPath;
  }

  /** Extract command-line tools and set up directory structure */
  async extractCommandLineTools(zipPath: string, progress: ProgressCallback): Promise<void> {
    progress({ message: 'Extracting command-line tools...' });

    // Create SDK root
    fs.mkdirSync(this.sdkRoot, { recursive: true });

    const tempExtractDir = path.join(this.sdkRoot, '_temp_extract');
    fs.mkdirSync(tempExtractDir, { recursive: true });

    try {
      // Extract zip
      if (process.platform === 'win32') {
        await this.execCommand('powershell', [
          '-NoProfile', '-NonInteractive',
          '-Command',
          `Expand-Archive -Path '${zipPath}' -DestinationPath '${tempExtractDir}' -Force`,
        ]);
      } else {
        await this.execCommand('unzip', ['-o', zipPath, '-d', tempExtractDir]);
      }

      // Reorganize: move extracted cmdline-tools/* to cmdline-tools/latest/
      const targetDir = path.join(this.sdkRoot, 'cmdline-tools', 'latest');
      fs.mkdirSync(path.dirname(targetDir), { recursive: true });

      const extractedDir = path.join(tempExtractDir, 'cmdline-tools');
      if (fs.existsSync(extractedDir)) {
        // Remove existing latest dir if present
        if (fs.existsSync(targetDir)) {
          fs.rmSync(targetDir, { recursive: true, force: true });
        }
        fs.renameSync(extractedDir, targetDir);
      }
    } finally {
      // Cleanup temp
      if (fs.existsSync(tempExtractDir)) {
        fs.rmSync(tempExtractDir, { recursive: true, force: true });
      }
      // Cleanup zip
      if (fs.existsSync(zipPath)) {
        fs.unlinkSync(zipPath);
      }
    }
  }

  /** Check if cmdline-tools are already installed (for recovery) */
  hasCommandLineTools(): boolean {
    const sdkmanagerPath = path.join(
      this.sdkRoot, 'cmdline-tools', 'latest', 'bin', SDK_TOOLS.SDKMANAGER
    );
    return fs.existsSync(sdkmanagerPath);
  }

  /** Accept all SDK licenses */
  async acceptLicenses(sdkmanagerPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(sdkmanagerPath, ['--licenses'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? { shell: true } : {}),
      });

      // Keep piping "y" for all license prompts
      const interval = setInterval(() => {
        try { proc.stdin?.write('y\n'); } catch { /* stdin closed */ }
      }, 500);

      let stderr = '';
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        clearInterval(interval);
        // sdkmanager --licenses exits with 0 when all accepted, non-zero if issues
        // But it can also exit with non-zero even after accepting all — ignore exit code
        resolve();
      });

      proc.on('error', (err) => {
        clearInterval(interval);
        reject(new Error(`License acceptance failed: ${err.message}`));
      });

      // Timeout after 60 seconds
      setTimeout(() => {
        clearInterval(interval);
        proc.kill();
        resolve(); // Assume accepted
      }, 60000);
    });
  }

  /** Install SDK components via sdkmanager */
  async installComponents(sdkmanagerPath: string, progress: ProgressCallback): Promise<void> {
    progress({ message: 'Checking which Android versions are available...' });
    const systemImage = await SdkDownloader.resolveLatestSystemImage(sdkmanagerPath);
    this.resolvedSystemImage = systemImage;

    const packages = [
      { name: 'platform-tools', label: 'Installing platform-tools (adb)...' },
      { name: 'emulator', label: 'Installing Android emulator...' },
      { name: systemImage, label: 'Downloading system image (this may take a while)...' },
    ];

    for (const pkg of packages) {
      progress({ message: pkg.label });
      await this.installPackage(sdkmanagerPath, pkg.name);
    }
  }

  private installPackage(sdkmanagerPath: string, packageName: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const proc = spawn(sdkmanagerPath, [packageName], {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? { shell: true } : {}),
      });

      // Auto-accept any prompts
      proc.stdin?.write('y\n');

      let stderr = '';
      proc.stdout?.on('data', () => { /* consume */ });
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) { resolve(); }
        else { reject(new Error(`Failed to install ${packageName}: ${stderr}`)); }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run sdkmanager: ${err.message}`));
      });
    });
  }

  /** Create a default AVD */
  async createDefaultAvd(progress: ProgressCallback): Promise<string> {
    progress({ message: 'Creating default virtual device...' });

    const avdmanagerPath = path.join(
      this.sdkRoot, 'cmdline-tools', 'latest', 'bin', SDK_TOOLS.AVDMANAGER
    );
    // The image installComponents downloaded, not a fresh guess.
    const systemImage = this.resolvedSystemImage || SdkDownloader.getDefaultSystemImage();
    const avdName = SDK_DOWNLOAD.DEFAULT_AVD_NAME;

    return new Promise((resolve, reject) => {
      const args = [
        'create', 'avd',
        '-n', avdName,
        '-k', systemImage,
        '-d', SDK_DOWNLOAD.DEFAULT_DEVICE_PROFILE,
        '--force',
      ];

      const proc = spawn(avdmanagerPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(process.platform === 'win32' ? { shell: true } : {}),
      });

      // Auto-answer "no" to custom hardware profile
      proc.stdin?.write('no\n');
      proc.stdin?.end();

      let stderr = '';
      proc.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });

      proc.on('close', (code) => {
        if (code === 0) { resolve(avdName); }
        else { reject(new Error(`Failed to create AVD: ${stderr}`)); }
      });

      proc.on('error', (err) => {
        reject(new Error(`Failed to run avdmanager: ${err.message}`));
      });
    });
  }

  /** Download a file with progress reporting, following redirects */
  private downloadFile(url: string, destPath: string, progress: ProgressCallback): Promise<void> {
    return new Promise((resolve, reject) => {
      const file = fs.createWriteStream(destPath);
      const protocol = url.startsWith('https') ? https : http;

      const request = protocol.get(url, (response) => {
        // Follow redirects
        if (response.statusCode === 301 || response.statusCode === 302) {
          file.close();
          if (fs.existsSync(destPath)) { fs.unlinkSync(destPath); }
          const redirectUrl = response.headers.location;
          if (!redirectUrl) {
            reject(new Error('Redirect with no location header'));
            return;
          }
          this.downloadFile(redirectUrl, destPath, progress).then(resolve, reject);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          if (fs.existsSync(destPath)) { fs.unlinkSync(destPath); }
          reject(new Error(`Download failed: HTTP ${response.statusCode}`));
          return;
        }

        const totalBytes = parseInt(response.headers['content-length'] || '0', 10);
        let downloadedBytes = 0;

        response.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (totalBytes > 0) {
            const pct = Math.round((downloadedBytes / totalBytes) * 100);
            progress({ message: `Downloading SDK tools... ${pct}%` });
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          resolve();
        });
      });

      request.on('error', (err) => {
        file.close();
        if (fs.existsSync(destPath)) { fs.unlinkSync(destPath); }
        reject(new Error(`Download error: ${err.message}`));
      });
    });
  }

  private execCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(command, args, { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) { reject(new Error(stderr || err.message)); return; }
        resolve(stdout);
      });
    });
  }
}

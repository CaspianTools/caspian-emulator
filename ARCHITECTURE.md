# Architecture

System design and component overview for Caspian Emulator.

## High-Level Overview

```
┌─────────────────────────────────────────────────────┐
│                    VS Code                          │
│                                                     │
│  ┌──────────┐  ┌──────────┐  ┌───────────────────┐ │
│  │ Activity  │  │ Tree     │  │ Webview Panels    │ │
│  │ Bar Icon  │  │ Views    │  │ (Logcat, Screen)  │ │
│  └──────────┘  └────┬─────┘  └────────┬──────────┘ │
│                     │                  │            │
│              ┌──────┴──────────────────┴──────┐     │
│              │        extension.ts            │     │
│              │   (commands, activation)       │     │
│              └──────┬────────────┬────────────┘     │
│                     │            │                  │
│         ┌───────────┴──┐  ┌─────┴──────────┐       │
│         │  AvdManager  │  │   AdbClient    │       │
│         └──────┬───────┘  └──┬──────┬──────┘       │
│                │             │      │               │
│         ┌──────┴─────┐      │  ┌───┴────────┐      │
│         │ SdkManager │      │  │DeviceTracker│     │
│         └──────┬─────┘      │  └───┬─────────┘     │
│                │            │      │                │
│         ┌──────┴────────┐   │      │                │
│         │ SdkDownloader │   │      │                │
│         └──────┬────────┘   │      │                │
└────────────────┼────────────┼──────┼────────────────┘
                 │            │      │
         ┌───────┴────────────┴──────┴──────┐
         │         Android SDK              │
         │  (adb, emulator, avdmanager)     │
         └──────────────────────────────────┘
```

## Source Tree

```
src/
├── extension.ts                   — Entry point, command registration, activation
├── constants.ts                   — Command IDs, view IDs, config keys, SDK download config
├── types.ts                       — TypeScript interfaces
├── sdk/
│   ├── SdkManager.ts              — SDK auto-detection, validation, setup wizard
│   └── SdkDownloader.ts           — Zero-dependency SDK download and installation
├── adb/
│   ├── AdbClient.ts               — ADB command wrapper
│   ├── DeviceTracker.ts           — Real-time device connection monitoring
│   ├── QrPairingServer.ts         — QR code pairing: mDNS + TLS + SPAKE2 + encrypted peer info
│   └── Spake2.ts                  — SPAKE2 key exchange (BoringSSL Ed25519 variant)
├── avd/
│   ├── AvdManager.ts              — AVD CRUD, config.ini read/write, emulator launch/verified stop
│   ├── BootState.ts               — Pure boot-phase classifier + guest readiness probe
│   ├── DisplayCheck.ts            — Pure display/RAM analysis and Play Console rules
│   ├── LaunchPreflight.ts         — Host RAM and acceleration gate before launch
│   └── MemoryWatcher.ts           — Host memory watch while an emulator is running
├── capture/
│   ├── CapturePaths.ts            — Capture directory resolver, run folders, filenames
│   ├── DemoMode.ts                — SystemUI demo mode (screenshot mode) controller
│   ├── DeviceState.ts             — Device setting snapshot/restore + crash recovery
│   ├── Orientation.ts             — Rotation control, settle detection, PNG header parsing
│   ├── SystemUiOverlay.ts         — Display-cutout and navigation-bar emulation overlays
│   ├── CaptureService.ts          — Screencap, validation, Markdown/JSON reports
│   └── MatrixRunner.ts            — Locale x font scale x density cross-product runner
├── utils/
│   ├── Logger.ts                  — Output channel logger
│   └── HostResources.ts           — Host memory, top consumers, acceleration probe
└── views/
    ├── AvdTreeProvider.ts         — Sidebar: Virtual Devices
    ├── DeviceTreeProvider.ts      — Sidebar: Connected Devices
    ├── FileExplorerProvider.ts    — Sidebar: Device file browser
    ├── LogcatPanel.ts             — Webview: live logcat viewer
    ├── EmulatorScreenPanel.ts     — Webview: emulator screen mirror
    └── QrPairingPanel.ts          — Webview: QR code pairing display
```

## Module Descriptions

### Entry Point

### Layering rule

`src/adb/` and `src/avd/` are the process-wrapper layer and stay free of `vscode`
imports where practical; `src/capture/` is feature orchestration and may use
`vscode` for progress, settings, and prompts. All device and emulator I/O still
goes through `AdbClient` or `AvdManager` — never `child_process` from a view or
a command handler.

### Two invariants worth knowing

**AVD hardware is written to `config.ini`, not applied at runtime.** `avdmanager
create avd` writes no `hw.lcd.*` when it has no `-d <profile>` to work from, and
the emulator then falls back to 320x640 @ 160 dpi with 96 MB of RAM. `AvdManager`
therefore writes the preset's real hardware into `config.ini` after creation.
`adb shell wm size` is deliberately never used as a fix — it only changes
WindowManager's logical size, lives in `/data`, and is lost on wipe. It is
offered as `reset` only.

**Device mutations are always recoverable.** Anything that changes a device
setting (rotation, font scale, density, locale, demo mode) first snapshots the
prior values and persists them to `globalState` *before* the first write. A
`finally` block restores on success, failure, and cancellation; the persisted
record covers a VS Code crash, which a `finally` cannot. `wm density` in
particular survives a device reboot, so a half-finished run would otherwise
leave a permanently mis-scaled device.

**`src/extension.ts`** — Extension activation and command registration. Orchestrates SDK detection on startup, initializes all managers and views, and wires commands to handlers. If the SDK isn't found, registers placeholder commands that prompt the setup wizard or SDK download.

### Core Services

**`src/sdk/SdkManager.ts`** — Detects the Android SDK by checking user settings, environment variables (`ANDROID_HOME`, `ANDROID_SDK_ROOT`), and platform-specific default paths. Validates that required tools (`adb`, `emulator`) exist. Provides a setup wizard with three options: use detected SDK, download automatically, or browse for an existing installation.

**`src/sdk/SdkDownloader.ts`** — Handles zero-dependency SDK download and installation. Enables running Android emulators without Android Studio. Responsibilities:
- **Java detection** — checks `JAVA_HOME`, system PATH, macOS `/usr/libexec/java_home`, and common Windows JDK paths
- **Disk space check** — validates ~5 GB available (PowerShell on Windows, `df` on Unix)
- **SDK download** — downloads command-line tools from Google's CDN with redirect following and progress reporting
- **Extraction** — uses PowerShell `Expand-Archive` on Windows, `unzip` on Unix; reorganizes to `cmdline-tools/latest/`
- **License acceptance** — pipes "y" to `sdkmanager --licenses` with a 60-second timeout
- **Component installation** — installs platform-tools, emulator, and a system image via `sdkmanager`
- **Default AVD creation** — creates "Caspian_Default" with Pixel 6 profile, Android 35
- **Architecture awareness** — selects arm64-v8a on Apple Silicon, x86_64 elsewhere
- **Recovery** — detects partial installations and resumes from the last completed step

**`src/adb/AdbClient.ts`** — Wrapper around the `adb` command-line tool. Provides typed methods for:
- Device listing and property queries
- APK installation
- Screenshot and screen recording
- File operations (ls, pull, push, delete)
- Logcat streaming
- Logcat line parsing (static method)

All methods use `child_process.execFile` for one-shot commands and `child_process.spawn` for streaming operations (logcat, screen recording).

**`src/adb/DeviceTracker.ts`** — Monitors device connections via polling (every 3 seconds). Emits `devicesChanged`, `deviceConnected`, and `deviceDisconnected` events. The extension uses these events to update the device tree view, status bar, and sync running AVD status.

**`src/adb/QrPairingServer.ts`** — Orchestrates the full ADB wireless debugging QR code pairing protocol. Advertises an mDNS service (`_adb-tls-pairing._tcp`), runs a TLS server, performs SPAKE2 key exchange with the phone, and exchanges encrypted peer info (ADB public keys) via AES-128-GCM. Generates self-signed TLS certificates using DER/ASN.1 encoding in pure Node.js.

**`src/adb/Spake2.ts`** — SPAKE2 password-authenticated key exchange implementation compatible with BoringSSL's Ed25519 variant. Generates M/N points from SHA-256 seeds, implements the cofactor-clearing password scalar hack, and produces a 64-byte shared key via SHA-512 transcript hash. Uses `@noble/curves` for elliptic curve operations.

**`src/avd/AvdManager.ts`** — Manages Android Virtual Devices via `avdmanager` and `emulator` CLI tools. Handles:
- Listing AVDs (via `emulator -list-avds` + config.ini parsing)
- Creating/deleting AVDs
- Launching emulators (detached processes)
- Stopping emulators via `adb emu kill`, **verified** by watching the serial leave the device list; `forceKillEmulator` is the explicit, snapshot-destroying fallback
- Tracking running emulator processes, and publishing each running AVD's serial onto `AvdInfo` so the tree can act on it
- System image and device profile listing

Deliberately carries no `vscode` import. Settings it needs (currently the guest-RAM toggle) are pushed in from `extension.ts`.

**`src/avd/BootState.ts`** — Decides whether a guest is `offline`, `booting`, `ready`, or `wedged`. `classifyBoot()` is pure — no vscode, no adb, no fs — so the state machine is testable in isolation; `probeBootState()` is the thin adb layer that gathers `sys.boot_completed`, `init.svc.bootanim`, and a `pm path android` round trip. Never throws: a shell that refuses the call *is* the signal.

**`src/avd/MemoryWatcher.ts`** — Samples host memory every 15 seconds while any emulator is running and warns once per emulator session when free memory crosses `caspian.emulator.lowMemoryFloorMb`. Complements `LaunchPreflight`, which only samples at launch and therefore cannot see a build starting afterwards. Started and stopped from `syncRunningAvds`.

### Views

**`src/views/AvdTreeProvider.ts`** — `TreeDataProvider` for the "Virtual Devices" sidebar panel. Shows each AVD with its name, API level, resolution, and running status. Context menu items (play/stop/edit/delete) are driven by `contextValue` (`avd.running` / `avd.stopped`), which is a **dot-suffixed composite matched by regex in `package.json`, never by equality** — health suffixes (`.brokenDisplay`, `.lowRam`) compose onto the base state, so adding one must never hide Launch/Stop/Delete.

**`src/views/DeviceTreeProvider.ts`** — `TreeDataProvider` for the "Connected Devices" sidebar panel. Automatically updates when `DeviceTracker` emits `devicesChanged`. Shows device model, serial, and connection state with color-coded icons.

**`src/views/FileExplorerProvider.ts`** — `TreeDataProvider` for the "Device Files" sidebar panel. Lazy-loads directory contents via `adb shell ls -la`. Supports nested directory expansion. Sorts directories before files.

**`src/views/LogcatPanel.ts`** — Webview panel that streams logcat output. Features:
- Priority filtering (Verbose through Fatal)
- Text search by tag or message
- Pause/resume
- Auto-scroll with manual override
- Line count display
- Color-coded output by priority level

**`src/views/EmulatorScreenPanel.ts`** — Webview panel that mirrors the emulator screen. Uses periodic `screencap` + base64 encoding as a fallback (~1 FPS). Supports:
- Tap input forwarding (click position → `adb shell input tap`)
- Navigation buttons (Back, Home, Recents)
- scrcpy detection for future higher-quality streaming

**`src/views/QrPairingPanel.ts`** — Webview panel that displays a QR code for wireless debugging pairing. Shows the QR code image, a manual pairing code, and live status updates as the protocol progresses (waiting → TLS connected → exchanging keys → paired). Supports retry and cancel actions.

### Shared

**`src/types.ts`** — TypeScript interfaces for all data models: `SdkInfo`, `AvdInfo`, `DeviceInfo`, `LogcatEntry`, `DeviceFile`, `SystemImage`, `DeviceProfile`, `JavaInfo`, `DiskSpaceInfo`, `EmulatorProcess`.

**`src/constants.ts`** — Extension-wide constants: command IDs, view IDs, configuration keys, SDK default paths, platform-specific tool binary names, and SDK download configuration (CDN URLs, build numbers, minimum Java version, disk space requirements).

## Data Flow

### SDK Auto-Download Flow

```
User clicks "Download & Install Android SDK"
  → SdkManager.runDownloadWizard()
    → SdkDownloader.detectJava()           — verify Java 17+
    → SdkDownloader.checkDiskSpace()       — verify ~5 GB free
    → User confirms installation
    → SdkDownloader.downloadCommandLineTools()  — HTTP GET from Google CDN
    → SdkDownloader.extractCommandLineTools()   — unzip + reorganize
    → SdkDownloader.acceptLicenses()            — pipe "y" to sdkmanager
    → SdkDownloader.installComponents()         — platform-tools, emulator, image
    → SdkManager.validatePath()                 — verify tools exist
    → SdkDownloader.createDefaultAvd()          — Caspian_Default, Pixel 6
    → SdkManager.saveSdkPath()                  — persist to VS Code settings
```

### Device Connection Lifecycle

```
DeviceTracker (poll every 3s)
  → adb devices -l
  → Parse output into DeviceInfo[]
  → Compare with previous state
  → Emit devicesChanged / deviceConnected / deviceDisconnected
    → DeviceTreeProvider updates tree view
    → Status bar updates device count
    → syncRunningAvds() maps emulator serials to AVD names
    → autoSelectFileExplorerDevice() sets default device for file browser
```

### AVD Launch Flow

```
User clicks Play on AVD
  → runLaunchPreflight()  — host RAM, Gradle daemons, acceleration
  → AvdManager.launchEmulator(avdName)
  → spawn(emulator, ['-avd', name], { detached: true, stdio: [ignore, fd, fd] })
  → Process unref'd (emulator runs independently)
  → Boot watch loop, every 2s until caspian.emulator.bootTimeoutSec:
      ├─ readLaunchFailure()   — PANIC/ERROR in the captured log → fail fast
      ├─ resolve serial once   — adb devices + adb emu avd name
      └─ probeBootState()      — sys.boot_completed, init.svc.bootanim, pm path android
           → classifyBoot() → offline | booting | ready | wedged
  → ready:  refresh the tree, done
  → wedged / timeout: open the launch log, offer Repair
```

Readiness is deliberately *not* `adb devices` reporting `state=device`: that is a
console-port signal that fires long before Android is usable. The wedged state
has a specific fingerprint — the boot animation stopped but `sys.boot_completed`
was never set, or the package manager answers `Broken pipe`.

### Emulator Stop Flow

```
Stop → AvdManager.stopEmulator(serial)
  → adb -s <serial> emu kill
  → poll adb devices until the serial disappears (10s)
  → returns true (gone) / false (ignored the request)
  → false → Repair offers a force kill, which states that killing qemu
            leaves the snapshot corrupt, then marks the AVD for a cold boot
```

### Logcat Streaming

```
User opens logcat for a device
  → LogcatPanel spawns adb logcat -v threadtime
  → stdout chunks buffered and split by newline
  → Each line parsed via AdbClient.parseLogcatLine()
  → Parsed entries posted to webview via postMessage
  → Webview filters by priority/search, appends to DOM
  → Old lines trimmed when exceeding maxLines config
```

## Extension Points

To add a new command:
1. Add the command ID to `COMMANDS` in `src/constants.ts`
2. Add the command entry to `contributes.commands` in `package.json`
3. Add menu placement in `contributes.menus` in `package.json`
4. Register the handler in `registerCommands()` in `src/extension.ts`

To add a new tree view:
1. Add the view ID to `VIEWS` in `src/constants.ts`
2. Add the view to `contributes.views.caspian` in `package.json`
3. Create a `TreeDataProvider` in `src/views/`
4. Register it in `initializeWithSdk()` in `src/extension.ts`

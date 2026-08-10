# Setup Guide

Detailed setup, configuration, and troubleshooting for Caspian Emulator.

## Android SDK Setup

Caspian Emulator does **not** require Android Studio. You can either let the extension download the SDK automatically or point it to an existing installation.

### Option 1: Automatic SDK Download (Recommended)

The extension can download and configure the entire Android SDK for you.

**Prerequisites:**
- **Java 17+** (JDK) — install from [Eclipse Adoptium](https://adoptium.net/) if needed
- **~5 GB disk space** for SDK components

**Steps:**
1. Open the Caspian Emulator sidebar (phone icon in the Activity Bar)
2. Click **"Download & Install Android SDK"** in the welcome view
3. The extension will:
   - Verify Java 17+ is installed
   - Check available disk space
   - Ask you to confirm the installation location
4. Once confirmed, it downloads and installs:
   - **Command-line tools** — from Google's official CDN
   - **Platform-tools** — adb
   - **Emulator** — Android emulator
   - **System image** — Android 35, Google APIs (x86_64 or arm64-v8a on Apple Silicon)
5. A default AVD named **Caspian_Default** is created (Pixel 6 profile, Android 35)
6. SDK licenses are accepted automatically

**Default install locations:**
| Platform | Path |
|----------|------|
| Windows | `%LOCALAPPDATA%\Android\Sdk` |
| macOS | `~/Library/Android/sdk` |
| Linux | `~/Android/Sdk` |

**Recovery:** If the download is interrupted, run the command again. The extension detects partially installed components and resumes from where it left off.

### Option 2: Automatic Detection

If you already have the Android SDK installed (e.g., from Android Studio), the extension detects it automatically by checking:

1. **VS Code setting** `caspian.androidSdkPath` (if configured)
2. **Environment variables** `ANDROID_HOME`, `ANDROID_SDK_ROOT`
3. **Default paths:**
   - Windows: `%LOCALAPPDATA%\Android\Sdk`
   - macOS: `~/Library/Android/sdk`
   - Linux: `~/Android/Sdk`

### Option 3: Manual Configuration

If auto-detection doesn't find your SDK:

1. Open Command Palette (`Ctrl+Shift+P`)
2. Run **"Caspian: Setup Android SDK"**
3. Browse to your SDK root folder
4. The extension validates that `adb` and `emulator` exist

Or set it directly in VS Code settings:

```json
{
  "caspian.androidSdkPath": "/path/to/your/Android/Sdk"
}
```

### Required SDK Components

The extension needs these tools inside the SDK:

| Tool | Location | Required |
|------|----------|----------|
| `adb` | `platform-tools/adb` | Yes |
| `emulator` | `emulator/emulator` | Yes |
| `avdmanager` | `cmdline-tools/latest/bin/avdmanager` | For AVD creation |
| `sdkmanager` | `cmdline-tools/latest/bin/sdkmanager` | For system image listing |

If using an existing SDK with missing components, install them via:

```bash
sdkmanager "platform-tools" "emulator" "cmdline-tools;latest"
```

## Extension Settings

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `caspian.androidSdkPath` | string | `""` | Android SDK root path (auto-detected if empty) |
| `caspian.emulatorArgs` | string[] | `[]` | Extra args passed to `emulator` on launch |
| `caspian.logcat.maxLines` | number | `10000` | Max lines retained in logcat viewer |
| `caspian.scrcpyPath` | string | `""` | Path to scrcpy binary (auto-detected if empty) |
| `caspian.emulator.checkHostMemory` | boolean | `true` | Warn when free host RAM is below what the AVD needs |
| `caspian.emulator.memoryHeadroomMb` | number | `1024` | Memory to leave for the host beyond the requirement |
| `caspian.emulator.checkAcceleration` | boolean | `true` | Check WHPX/HAXM/KVM before the first launch of a session |
| `caspian.emulator.captureLog` | boolean | `true` | Capture emulator output so launch failures can be reported |
| `caspian.emulator.bootTimeoutSec` | number | `180` | How long to wait for Android to finish booting before reporting a stall |
| `caspian.emulator.watchHostMemory` | boolean | `true` | Warn when host memory runs low while an emulator is running |
| `caspian.emulator.lowMemoryFloorMb` | number | `512` | Free memory below which that warning fires (`0` disables it) |
| `caspian.avd.checkGuestRam` | boolean | `true` | Flag AVDs with less RAM than their system image needs |
| `caspian.avd.playStoreStrictAspect` | boolean | `false` | Enforce Play's documented 16:9 rule |
| `caspian.captureDirectory` | string | `"${workspaceFolder}/.caspian/captures"` | Where capture runs are written |
| `caspian.capture.useDemoMode` | boolean | `true` | Use screenshot mode during capture runs |
| `caspian.capture.maxAspectRatio` | number | `2` | Max long/short ratio accepted when validating captures |
| `caspian.demoMode.clock` | string | `"1000"` | Clock shown in screenshot mode (24-hour HHMM) |

See the [readme](readme.md#settings) for the full list of 34 settings.

### Emulator Launch Arguments

Pass custom flags when launching emulators:

```json
{
  "caspian.emulatorArgs": ["-no-snapshot", "-gpu", "swiftshader_indirect"]
}
```

Common flags:
- `-no-snapshot` — cold boot every time
- `-no-audio` — disable audio
- `-gpu swiftshader_indirect` — software rendering (for machines without GPU)
- `-memory 2048` — set RAM size
- `-no-boot-anim` — skip boot animation for faster startup

## Screen Mirroring

### With scrcpy (Recommended)

[scrcpy](https://github.com/Genymobile/scrcpy) provides higher quality screen mirroring. Install it:

- **Windows:** `winget install Genymobile.scrcpy` or `scoop install scrcpy`
- **macOS:** `brew install scrcpy`
- **Linux:** `sudo apt install scrcpy` or `sudo snap install scrcpy`

The extension auto-detects scrcpy on PATH. Or set the path manually:

```json
{
  "caspian.scrcpyPath": "/usr/local/bin/scrcpy"
}
```

### Without scrcpy

The extension falls back to `adb shell screencap` which captures screenshots at ~1 FPS. Functional but not smooth.

## Troubleshooting

### SDK Auto-Download Issues

**"Java 17 or later is required"**
- Install a JDK 17+ from [Eclipse Adoptium](https://adoptium.net/)
- Set `JAVA_HOME` environment variable if Java is installed but not detected
- Restart VS Code after installing Java

**"Insufficient disk space"**
- At least 5 GB of free space is required for the SDK download
- Free up disk space or choose a different install location

**Download interrupted or failed**
- Run **"Caspian: Download & Install Android SDK"** again — it resumes from where it left off
- If command-line tools are already downloaded, the extension skips to component installation
- Check your internet connection and firewall settings

**"SDK installation completed but validation failed"**
- Some SDK components may have failed to install
- Try running the download command again to retry failed components
- Check disk space and permissions on the install directory

### General Issues

**"Android SDK not found"**
- Verify the SDK path contains `platform-tools/adb` and `emulator/emulator`
- Set `caspian.androidSdkPath` explicitly in settings
- Run `adb version` in a terminal to confirm adb is installed

**No AVDs listed**
- Create an AVD using the **+** button in the Virtual Devices panel
- Or create one via command line:
  ```bash
  avdmanager create avd -n MyDevice -k "system-images;android-35;google_apis;x86_64"
  ```
- Click the **refresh** button in the Virtual Devices panel

**Emulator won't start, or hangs partway through boot**
- Caspian now waits for Android itself rather than for the device to appear in `adb devices`, and reports a stalled boot instead of giving up silently. The launch log opens automatically when that happens
- Run **Caspian: Repair Virtual Device** — it walks the ladder from least to most destructive: stop cleanly, cold boot (discards the snapshot, keeps app data), then wipe data (destroys app data and any placed home-screen widgets)
- Run **Caspian: Show Emulator Launch Log** — the emulator's own output is captured on every launch and usually names the cause
- Run **Caspian: Check Emulator Acceleration** to confirm WHPX, HAXM, or KVM is available. Without it the emulator runs in software mode and can take minutes or fail outright. On Windows 11, enable **Windows Hypervisor Platform** and **Virtual Machine Platform** in Windows Features, then reboot
- Run **Caspian: Check Device Configuration**. Two RAM faults show up here: a virtual device created before v1.1.0 may have only 96 MB, which cannot boot Android at all; and an API 33+ Google APIs image on the emulator's 1536 MB default will boot and then swap, ANR, and show "System UI isn't responding". Both are fixed in `config.ini`, so wiping data will not help
- Close memory-heavy processes. Caspian warns before launching when free RAM is short, warns again if memory runs out *while* the emulator is running, and can stop Gradle daemons for you either way
- Try adding `-gpu swiftshader_indirect` to `caspian.emulatorArgs`

**The emulator won't stop**
- **Caspian: Stop Emulator** now confirms the emulator actually went, rather than assuming `adb emu kill` worked
- If it is ignored, **Caspian: Repair Virtual Device** offers a force kill. Take the warning seriously: killing the emulator process means qemu never flushes, so the saved snapshot is left corrupt. Caspian cold boots that AVD next time so the bad snapshot is never loaded
- Never kill the emulator or `qemu-system-*` process yourself for this reason — it buys a wipe and a slow first boot

**Testing notches, gesture navigation, and edge-to-edge layout**
- **Caspian: Set Display Cutout (Notch)** switches a running device between corner, double, punch-hole, tall, and waterfall cutouts, or none. Use it to confirm your `displayCutout` insets are actually applied
- **Caspian: Set Navigation Mode** switches between gesture, 2-button, and 3-button navigation
- Both need Android 9 (cutouts) or Android 10 (navigation) and are verified by reading the overlay state back, because the underlying command reports success either way. Some system images do not ship the overlays at all, and Caspian says so rather than claiming a change it could not make
- Both are undone by **Caspian: Reset Device Display & Language Overrides**

**Landscape home-screen or widget screenshots**
- The Pixel launcher refuses to rotate on a phone-sized display, and `wm set-ignore-orientation-request` is itself ignored below sw600dp, so a landscape home-screen shot is normally impossible
- Set `caspian.capture.tabletTrickForLandscape` to `true`. Caspian then retries the shot at a lower density, which makes the same panel measure wide enough in dp for the launcher to allow landscape
- Any shot taken this way is **marked in the capture report**, because the layout is real but the scale is not the device's own. Leave the setting off for store screenshots you intend to upload

**Play Console rejects my screenshots**
- Run **Caspian: Check Device Configuration** on the virtual device. If it reports 320x640, the AVD was created without a device profile and is not the device it claims to be — repair it from the same menu, then cold boot
- Use **Caspian: Capture Store Screenshots**, which validates every shot against Play's size and aspect rules and tells you exactly what to change
- A full-resolution modern phone screenshot (a Pixel 9 Pro is 2.23:1) exceeds Play's 2:1 limit and needs cropping or padding. The capture report gives you the target height

**A device is stuck at the wrong size, font, or language**
- Run **Caspian: Reset Device Display & Language Overrides**. `wm density` and `wm size` overrides survive a reboot, so an interrupted matrix run can leave a device mis-scaled
- Caspian also checks a device for leftover overrides when it connects and offers to clear them, even when the run that caused them happened in another window or on another machine. Turn that off with `caspian.capture.detectLeftoverOverrides`

**Device shows "unauthorized"**
- Check the emulator/device screen for a USB debugging authorization prompt
- Accept the prompt, then refresh the device list

**Logcat not showing output**
- Ensure the device state is "device" (not offline/unauthorized)
- Try clearing and restarting logcat via the **Clear** button

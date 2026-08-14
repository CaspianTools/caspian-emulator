# Changelog

All notable changes to Caspian Emulator will be documented in this file.

## [1.4.0] - 2026-08-14

### Added
- **21 new device presets, and the picker is now grouped.** The preset list was thirteen Pixels, a Nexus 5X, and two generic tablets — so "test on a range of devices" meant testing on one manufacturer. Added the Pixel 10 line (10, 10 Pro, 10 Pro XL, 10 Pro Fold), Pixel 9 Pro XL and 9a, six Samsung Galaxy phones (S25 Ultra / S25 Plus / S25 / S24 Ultra / S24 / A55), the Galaxy Z Fold 6 and Z Flip 6, OnePlus 13 and 12, Xiaomi 14, Redmi Note 13, and four more tablets (Galaxy Tab S10 Ultra, Galaxy Tab S9, OnePlus Pad 2, Pixel Tablet). 37 devices in all, under **Google Pixel**, **Samsung Galaxy**, **Other phones**, **Foldables** and **Tablets** headings, searchable by manufacturer or resolution as well as by name
- **Non-Google devices are configured directly, and said so honestly.** `avdmanager` has never shipped a Samsung, OnePlus, or Xiaomi device definition, so these presets skip `-d` entirely rather than attempting it and falling back. Densities are chosen so the resulting **dp** size matches the real hardware — a Galaxy S25 Ultra is 1440 px wide at 600 dpi, i.e. 384dp, not the 411dp a Pixel-like 560 dpi would give — because dp is what layouts actually respond to

### Fixed
- **Every preset AVD was born wearing a "low RAM" warning.** All presets carried `ram: 2048`, but the guest-RAM floor for a Google APIs image at API 33+ is 2560 MB, so a freshly created device failed the extension's own health check on the spot. Phones are now 2560 MB and foldables/tablets 3072 MB, with heap sizes derived from the floor rather than hand-written. This applies to the older presets too: an API level is a floor, so a Pixel 6 preset is routinely paired with a far newer system image
- **A preset whose name contained anything but letters or spaces produced an AVD name the next prompt rejected.** The default name stripped whitespace only, so `7" Tablet` became `7"_Tablet_API36` and failed validation immediately
- **A Pixel 6 virtual device offered Pixel 6a hardware when repaired.** Preset matching strips punctuation before comparing, which fuses the *A* of `_API32` onto the model number: `Pixel_6_API32` becomes `pixel6api32`, which contains `pixel6a`. The API suffix is now removed before matching

### Changed
- **The repair dialog's resolution list is derived from the preset table** instead of being a second hardcoded copy of it, so the two can no longer drift apart

## [1.3.0] - 2026-08-14

### Added
- **Blank captures are detected instead of shipped** — an emulator that boots, runs your app, and answers `screencap` with an entirely black frame used to pass every check: the PNG has the right dimensions, the right aspect ratio, and the right format, so it validated clean and went to the Play Console. Caspian now measures the image itself. A frame carrying too little data for its size is decoded and sampled, and a single flat colour is a hard validation failure naming the fix. This covers **Take Screenshot**, **Capture Store Screenshots**, and every cell of a matrix run — where one blank frame was otherwise multiplied across every locale, font scale, and density
- **`caspian.emulator.gpuMode`** — the `-gpu` flag is now a setting (`auto`, `host`, `swiftshader`, `swiftshader_indirect`, `angle_indirect`) rather than something to hand-type into `caspian.emulatorArgs`. Previously Caspian passed no `-gpu` at all and had no opinion about rendering, while owning the screenshot feature that depends on it
- **Automatic software-rendering fallback** — when the mode is `auto` and a launch dies with a graphics error, Caspian retries down a ladder (`auto` → `swiftshader_indirect` → `swiftshader`), once per device per session, then names the mode that worked and offers to save it. Disable with `caspian.emulator.gpuFallback`. An explicit `-gpu` in `caspian.emulatorArgs`, or any non-`auto` setting, is treated as a stated preference and never overridden
- **Graphics failures are recognised** — a host with a broken OpenGL driver fails with a Qt error (`UpdateLayeredWindowIndirect failed — A device attached to the system is not functioning`) that carried no `PANIC:` or `ERROR:` prefix, so it matched none of the fatal-log patterns and presented as a 180-second hang with no diagnosis. It is now classified, reported, and used to trigger the fallback
- **"Stop Build Daemons" can stop the daemon that is actually holding the memory** — a follow-up action terminates whatever survived, by pid
- **`caspian.avd.preferInstalledSystemImage`** — device presets now treat their API level as a floor rather than an exact match, so creating a Pixel 9 Pro uses the newest system image you already have instead of downloading an older one

### Fixed
- **The low-memory remedy reported nothing when it achieved nothing.** `gradlew --stop` cannot stop the Kotlin compile daemon — which is routinely the larger of the two, holding around a gigabyte — yet the preflight named it as the culprit and then offered a remedy that could not clear it. All three sites re-measured afterwards but only spoke when memory had been freed, so the common case was silence, which reads as success. Caspian now says plainly when nothing was freed, names what is still resident, and offers to stop it
- **The severe low-memory warning never offered the remedy for a Kotlin daemon.** The "memory is tight" tier checked for both daemon kinds; the "not enough memory" tier checked for Gradle only, so the more serious warning was the one missing the button
- **Only one process per group could ever be stopped** — top-consumer rows are aggregated by name, and a build routinely leaves two or three daemons resident, but only the first pid was kept. Every pid in a group is now tracked
- **The blank-frame guard used a flat 10 KB floor**, which at 1080×1920 works out to 0.0049 bytes per pixel — *below* a real all-black frame at 0.0060 — so it never fired on the thing it was written for. It is now a ratio, and a frame that is still empty after the retry is reported rather than returned silently
- **Screenshot mode did not survive an emulator restart** — demo-mode state is keyed by serial, and a restarted emulator reclaims the same serial with a fresh SystemUI. The status bar went on saying screenshot mode was on while the device quietly showed a real clock, so the first capture after a restart carried wall-clock time. It is now re-applied when a device reconnects
- **Take Screenshot never validated anything** — it used a separate three-round-trip path (device-side `screencap`, `pull`, `rm`) that never held the image bytes. It now uses the single-round-trip buffer path, needs no device-side temp file, and checks the frame before reporting success

### Changed
- **The setup wizard installs the newest stable Google APIs image the SDK offers** rather than a pinned Android 15, resolving it once so the image downloaded and the image the default AVD is created against cannot diverge. API 35 remains the offline fallback
- **Pixel 9, Pixel 9 Pro, and both tablet presets default to API 36 (Android 16)**. Older Pixel presets stay pinned to their real launch API
- **A stalled boot now names a GPU mode this host cannot drive** as a third possible cause, alongside too little guest RAM and a corrupt snapshot
- **"Stop Gradle Daemons" is now "Stop Build Daemons"**, because it stops the Kotlin compile daemon too


## [1.2.0] - 2026-08-11

### Added
- **Real boot detection** — launching an emulator now waits for Android itself, not for `adb devices`. Readiness means `sys.boot_completed` is set *and* a package-manager round trip succeeds; the notification says which of "waiting for the device", "Android is booting", or "boot stalled" you are in. Previously the extension declared success the moment the emulator's console port answered, which happens long before the guest is usable
- **A stalled boot is reported instead of timing out in silence** — a guest that finishes its boot animation but never sets `sys.boot_completed`, or whose shell answers `Broken pipe`, is detected as wedged. The captured launch log opens automatically rather than waiting for you to find "Show Emulator Launch Log", and the message offers Repair. The wait is now configurable and defaults to 180 seconds, because a cold boot after a data wipe takes longer than the old 60-second cap
- **Repair Virtual Device** — an escalating ladder for an emulator that will not start or will not stop: stop cleanly, cold boot, or wipe data. Each rung states its cost up front, and the wipe spells out that it destroys app data and any placed home-screen widgets
- **Stopping is verified** — `adb emu kill` is confirmed by watching the device leave the device list. If the emulator ignores it, Caspian offers a force kill and says plainly that this corrupts the saved snapshot, then automatically cold boots that AVD next time so the bad snapshot is never loaded
- **Guest RAM check** — a virtual device configured with less RAM than its system image needs is flagged in the sidebar with a one-click fix. An API 33+ Google APIs image needs 2560 MB; at the emulator's 1536 MB default it boots, then swaps and ANRs ("System UI isn't responding") under any real load. This is distinct from the existing host-memory check, which asks whether your machine can spare the RAM, not whether the amount is enough
- **Host memory is watched while the emulator runs**, not only sampled at launch — the common failure on a 16 GB machine is a build starting *after* a successful launch. One warning fires when free memory crosses a floor, naming the process responsible, with the same one-click "Stop Gradle Daemons" remedy. The pre-flight now offers that remedy at the "memory is tight" tier too, not only at "not enough memory"
- **Display cutout emulation** — switch a running device between corner, double, punch-hole, tall, and waterfall notches, or none. Verifies the change by reading the overlay state back
- **Navigation mode emulation** — switch between gesture, 2-button, and 3-button navigation. Together with cutouts these are what edge-to-edge layout work needs, and Android 15's edge-to-edge enforcement makes it a recurring need for every Compose app
- **Landscape home-screen captures** (opt-in, `caspian.capture.tabletTrickForLandscape`) — the Pixel launcher refuses to rotate on a phone profile and ignores `wm set-ignore-orientation-request` below sw600dp, so the only lever is density. When enabled, a landscape shot that will not rotate is retried at a lower density and the report records that the shot is not at the device's own density
- **Leftover overrides are detected on connect** — a device still carrying a display, rotation, or screenshot-mode override from an interrupted run is now spotted by probing the device, and Caspian offers to clear it. Previously only overrides this extension had recorded could be recovered
- 6 new settings covering the boot timeout, the memory watch and its floor, the guest-RAM check, the landscape density trick, and leftover detection

### Fixed
- **Stop on a virtual device never worked** — `AvdInfo.serial` was declared but never populated, so "Stop" always failed with "Cannot determine emulator serial". The serial is now read from the running-emulator map, and falls back to asking adb for emulators started before the window opened
- **A rotation that silently did not happen is now a validation failure** — capture already had the check but nothing ever enabled it, so a landscape shot that stayed portrait was filed under the orientation it happened to measure, with no warning. This is the kind of wrong output that looks fine
- **Tablet and foldable captures were labelled against the wrong axis** — `user_rotation` is relative to the device's *natural* orientation, which is landscape on tablets, so mapping portrait to rotation 0 was wrong for them. The natural orientation is now measured once per run
- **Screenshot mode is re-applied after a display density change** — a density change restarts SystemUI and dropped demo mode part-way, leaving a status bar with duplicated icons (two Wi-Fi glyphs, two data labels)
- **A clean status bar is actually clean** — the Wi-Fi glyph no longer carries a "!" (the link is now marked validated) and the "3G" data label is gone (`datatype none` is handled explicitly, where the documented `datatype false` fell through to a visible label on several images)
- **The connect-time restore prompt never fired for the device that triggered it** — the device tracker emitted `deviceConnected` before publishing the updated device list, and since `emit` is synchronous the handler saw a list that did not yet contain that device
- **Store screenshot capture had no crash recovery** — unlike the matrix run it never wrote a pending-restore record, so a crash mid-run left rotation pinned and screenshot mode on with nothing to recover from
- **Custom virtual devices were created with no RAM setting at all** — the preset flow writes `hw.ramSize`, but the custom system-image flow passed no hardware, leaving the emulator's 1536 MB default. It now writes the floor for the chosen image

### Changed
- **"Check Display Configuration" is now "Check Device Configuration"** — it covers RAM as well as the display. The command id is unchanged
- **Cutout and navigation-bar overlays join the restore machinery** — they are snapshotted, restored, and cleared by "Reset Device Display & Language Overrides"
- **Watching a boot can be cancelled** without stopping the emulator


## [1.1.0] - 2026-08-10

### Fixed
- **Virtual devices created from a preset had a 320x640 display and 96 MB of RAM** — when your SDK's command-line tools did not include a device definition (every Pixel 8 and Pixel 9 profile is missing from the tools Caspian ships), AVD creation fell back to running `avdmanager` with no device profile. Nothing then wrote `hw.lcd.*` or `hw.ramSize` into `config.ini`, so the emulator used its own 320x640 @ 160 dpi / 96 MB defaults. A "Pixel 9 Pro" was neither. Screenshots were rejected by the Play Console, and the emulator could hang partway through boot with no error because 96 MB is not enough to start Android. Caspian now carries the real hardware for all 16 presets and writes it into `config.ini` directly, so a Pixel 9 Pro is 1280x2856 @ 480 dpi with 2048 MB whether or not your SDK knows the profile
- **Removed the "Create anyway" prompt** shown when a device profile was unavailable — there is no longer a decision to make, because the display is configured either way
- **Device profile lookup failures are no longer silently ignored** — `avdmanager list device` failing was indistinguishable from "this SDK has no such profile", which routed creation straight into the bug above
- **Device profile names containing spaces or brackets** (`7" Tablet`, `10" Tablet`, `Nexus 5X`) no longer break AVD creation on Windows, where arguments were passed to `cmd.exe` unquoted
- **AVD paths resolve correctly when VS Code is launched from Git Bash** — `HOME` is a POSIX path there, which sent config reads and writes to a non-existent directory
- **Emulator launch failures are reported instead of appearing as a hang** — emulator output was discarded, so a `PANIC:` on startup showed up only as a progress notification that spun for 60 seconds. Output is now captured to a log file, scanned for fatal errors, and surfaced with a "Show Log" button
- **A failure to spawn the emulator no longer crashes the extension host** — the spawn `error` event had no listener
- **Emulator launch arguments no longer mutate shared settings state** — `caspian.emulatorArgs` was pushed into directly

### Added
- **Screenshot mode** — one toggle puts the status bar into a clean, deterministic state for store screenshots: fixed clock, full battery, full signal, no notification or system icons. Replaces the seven-broadcast SystemUI demo-mode incantation. A warning-coloured status bar item shows while it is on, because the device is reporting fake battery and signal
- **Capture Store Screenshots** — captures the current screen in portrait and landscape into a named run folder, validates each shot against Play Console's size and aspect rules, and writes a Markdown report plus a machine-readable `manifest.json`. Orientation is labelled from the measured image, so tablets and foldables (whose natural orientation is landscape) are labelled correctly, and an orientation-locked app is reported rather than producing a duplicate file
- **Locale & accessibility matrix** — runs an app across languages, font scales, display densities, and orientations, capturing each combination. Language switching uses the official per-app locale API (`cmd locale set-app-locales`, Android 13+), which needs no root, no reboot, and works on Play system images. Includes the `en-XA` and `ar-XB` pseudolocales for finding text overflow and RTL layout bugs without a translator
- **Device settings are restored when a run ends**, including if you cancel it or VS Code crashes mid-run — a pending-restore record is written before the first change and offered on the next launch. `wm density` in particular survives a reboot, so a half-finished run would otherwise leave a permanently mis-scaled device
- **Reset Device Display & Language Overrides** — an unconditional panic button for a device left in a modified state
- **Check Display Configuration** — reports an AVD's display against Play Console rules and offers a permanent fix in `config.ini`, a manual resolution, clearing a temporary `wm size`/`wm density` override, or detaching a conflicting skin. Backs up `config.ini` before writing
- **Virtual devices show their resolution in the sidebar**, with a warning icon and a one-click fix on any AVD whose display is misconfigured
- **Low-memory pre-flight check before launching** — compares the AVD's configured RAM against free host memory and, when short, names the processes responsible. Offers to run `gradlew --stop` when resident Gradle daemons are the cause, then re-measures
- **Hardware acceleration check** — warns when WHPX, HAXM, or KVM is unavailable, since the emulator then runs in software mode and can appear to hang
- **Show Emulator Launch Log** — opens the captured output for a virtual device
- 17 new settings covering the capture directory, screenshot-mode appearance, validation strictness, and pre-flight behaviour

### Changed
- **`hw.keyboard` is enabled on new virtual devices** so the host keyboard works out of the box
- **The Play Console 16:9 rule is reported, not enforced** — every current Pixel is about 20:9, so treating 16:9 as a hard requirement would flag correctly configured devices as broken. Set `caspian.avd.playStoreStrictAspect` to enforce it
- **Documentation workflow** — release notes and feature announcements now go to GitHub Discussions only; the GitHub Wiki is no longer maintained

## [1.0.0] - 2026-07-03

### Changed
- **First stable release** — published directly to the VS Code Marketplace. Functionally identical to 0.5.0; the release marked the feature set as production-ready

## [0.5.0] - 2026-03-13

### Added
- **QR code pairing for wireless debugging** — scan a QR code on your Android 11+ phone to pair instantly, no manual IP/port or pairing code needed. Uses the full ADB wireless pairing protocol (mDNS + TLS + SPAKE2 key exchange)
- **"Pair with QR Code" option** in the Wi-Fi connect menu — generates a QR code in a webview panel with live status updates as the pairing progresses
- **Automatic fallback** — if QR pairing isn't available, the manual pairing code flow remains accessible

## [0.4.2] - 2026-03-13

### Fixed
- **Fix screen mirror for physical devices** — screen capture now works reliably on USB-connected phones. The previous implementation depended on a `base64` binary on the device (not available on many phones) and corrupted binary PNG data through UTF-8 string encoding. Frames are now captured as raw binary via `adb exec-out screencap -p` and converted to base64 in Node.js

## [0.4.1] - 2026-03-12

### Fixed
- **Fix uncaught ADB error on activation** — the extension no longer crashes when the ADB daemon isn't running. The device tracker now handles errors gracefully and logs them to the output channel instead of throwing an uncaught exception
- **Start ADB server on activation** — the extension now runs `adb start-server` before polling for devices, preventing "daemon not running" errors
- **Actionable ADB error messages** — daemon failures now suggest checking port 5037 and using "Caspian: Refresh Device List" instead of showing raw stderr

### Changed
- **Improved marketplace page** — added gallery banner, version/install badges, expanded keywords for discoverability (scrcpy, screen mirror, android sdk, virtual device, mobile), added "Programming Languages" category
- **Better welcome views** — all three sidebar panels (Virtual Devices, Connected Devices, Device Files) now show helpful empty-state messages with action buttons including Wi-Fi connect and device selector
- **File Explorer welcome** — added empty-state message with "Select Device" action when no device is selected

## [0.4.0] - 2026-03-12

### Added
- **Diagnostics Output Channel** — all ADB commands, device events, and errors are logged to the "Caspian Emulator" output panel for easy debugging (`Caspian: Show Output Log` command)
- **ADB retry logic** — transient ADB failures (device offline, connection reset) are automatically retried with exponential backoff
- **App management commands** — Launch App, Force Stop, Clear Data, Uninstall, and List Installed Apps with interactive QuickPick menus
- **Package-level logcat filtering** — show logs from a specific app only (filters by PID, auto-refreshes when app restarts)
- **Logcat regex search** — filter logs with `/regex/` patterns or toggle the Regex checkbox; plain text search still works
- **Logcat export** — save captured logs to a `.txt` or `.log` file via the Export button
- **App Logcat** — right-click a device and choose "Show App Logcat" to open a logcat panel pre-filtered to a specific package
- **Active device selector** — click the status bar device count to switch the active device; all commands default to the active device (`Ctrl+Shift+D`)
- **File Explorer: Create Folder** — right-click a directory to create new folders on-device
- **File Explorer: Rename** — rename files and folders on the device
- **File Explorer: Open Remote File** — view small text files directly in VS Code without downloading
- **File Explorer: configurable root path** — set `caspian.fileExplorer.defaultPath` to start browsing from `/sdcard` instead of `/`
- **File Explorer: hide dotfiles** — toggle hidden files via `caspian.fileExplorer.showHidden` setting
- **Screen Mirror: swipe gestures** — click-and-drag on the screen to swipe (scroll, fling, drag)
- **Screen Mirror: scrcpy launch** — if scrcpy is installed, it launches in a separate window with full 30+ FPS touch & keyboard support
- **Screen Mirror: physical device support** — screen mirroring now works for USB-connected phones, not just emulators
- **Screen Mirror: FPS counter** — shows real-time frame rate in the bottom bar
- **Screen Mirror: faster fallback** — screencap interval reduced from 1s to 350ms (~3 FPS)
- **AVD Clone** — duplicate an existing AVD to create variations for testing
- **AVD Cold Boot** — launch an emulator without loading snapshots (inline button + setting)
- **Emulator boot progress** — notification with progress bar while the emulator boots (up to 60s)
- **Wireless ADB** — connect devices over Wi-Fi via TCP/IP or Android 11+ wireless debugging with pairing code
- **Keyboard shortcuts** — `Ctrl+Shift+L` (Show Logcat), `Ctrl+Shift+D` (Select Device), `Ctrl+Shift+O` (Show Output)
- 8 new configurable settings: device polling interval, logcat font size, logcat line wrap, file explorer defaults, cold boot mode, auto-select device

### Changed
- Status bar now opens the device selector QuickPick instead of just refreshing
- Logcat toolbar redesigned with Export button and Regex toggle
- Screen mirror panel renamed from "Emulator Screen" to "Device Screen" (works for all devices)
- Pre-existing lint warnings in AvdManager fixed (unused variables)

## [0.3.1] - 2026-03-05

### Fixed
- AVD creation from preset no longer fails with "No device found" on older SDK command-line tools — if the preset's device profile (e.g. `pixel_9_pro`) is not available in the installed SDK, the user is prompted to create the AVD without a device skin instead of crashing

## [0.3.0] - 2026-03-04

### Added
- **Named device presets** — Create AVDs from a curated list (Pixel 9 Pro, Pixel 8, Pixel Fold, Pixel Tablet, Nexus 5X, 7"/10" tablets) instead of raw system image strings
  - Automatically downloads the required system image if not installed (~1 GB)
  - AVD name pre-filled based on selected device and API level
  - Architecture-aware: x86_64 on Intel/AMD, arm64-v8a on Apple Silicon
- **USB phone connection guide** — "Connect Phone via USB" steps through Developer Options → USB Debugging → USB cable → Allow authorization
- **Unauthorized device detection** — proactively notifies when a phone connects without USB debugging enabled
- **All device states visible in sidebar** — unauthorized/offline devices now appear with contextual icons and descriptions
- **"How to Connect a Phone" link** in the Connected Devices welcome view
- ADB context menu items (Install APK, Screenshot, etc.) now only appear on ready devices

## [0.2.2] - 2026-03-04

### Fixed
- Fix "error: closed" popup when opening the file explorer while an emulator is still booting — the error is now suppressed silently and the file explorer auto-retries every 5 seconds (up to 5 times) until the shell is ready

## [0.2.1] - 2026-03-04

### Fixed
- Fix "spawn EINVAL" error when running SDK setup on Windows — `.bat` files (`sdkmanager.bat`, `avdmanager.bat`) now spawn with `shell: true`
- Fix AVD creation and system image listing failing on Windows for the same reason

## [0.2.0] - 2026-03-04

### Changed
- Full documentation rewrite for GitHub and VS Code Marketplace
- README rewritten as a polished marketplace listing with zero-setup messaging
- QUICKSTART updated with auto-download as the primary setup path
- SETUP_GUIDE reorganized with three setup options (auto-download, auto-detect, manual)
- ARCHITECTURE updated with SdkDownloader module, source tree, and SDK download flow diagram
- Updated extension description to highlight "no Android Studio required"

## [0.1.0] - 2026-02-25

### Added
- **Automatic SDK download and setup** — download Android SDK command-line tools, platform-tools, emulator, and system images without Android Studio
  - Java 17+ detection across Windows, macOS, and Linux
  - Disk space validation (requires ~5 GB)
  - Automatic SDK license acceptance
  - Default AVD creation (Caspian_Default, Pixel 6, Android 35)
  - Architecture-aware system image selection (x86_64 on Intel, arm64-v8a on Apple Silicon)
  - Recovery support for partial installations
- SDK auto-detection (ANDROID_HOME, ANDROID_SDK_ROOT, common paths) with setup wizard
- AVD management sidebar: list, create, delete, launch, stop, and edit virtual devices
- Connected devices sidebar with live polling (3-second interval)
- ADB controls: install APK, take screenshot, record screen, open ADB shell
- Logcat webview with priority filtering, tag/message search, pause/resume, color-coded output
- Embedded emulator screen mirror with tap input forwarding and navigation buttons
- Device file explorer: browse, download, upload, and delete files on device
- Status bar showing connected device count
- Configurable settings: SDK path, emulator args, logcat max lines, scrcpy path
- Optional scrcpy integration for higher quality screen mirroring

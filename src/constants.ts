export const EXTENSION_ID = 'caspian-emulator';

export const COMMANDS = {
  SETUP_SDK: 'caspian.setupSdk',
  DOWNLOAD_SDK: 'caspian.downloadSdk',
  CONNECT_PHONE: 'caspian.connectPhone',
  REFRESH_AVDS: 'caspian.refreshAvds',
  CREATE_AVD: 'caspian.createAvd',
  LAUNCH_AVD: 'caspian.launchAvd',
  STOP_AVD: 'caspian.stopAvd',
  DELETE_AVD: 'caspian.deleteAvd',
  EDIT_AVD: 'caspian.editAvd',
  REFRESH_DEVICES: 'caspian.refreshDevices',
  INSTALL_APK: 'caspian.installApk',
  TAKE_SCREENSHOT: 'caspian.takeScreenshot',
  RECORD_SCREEN: 'caspian.recordScreen',
  OPEN_SHELL: 'caspian.openShell',
  SHOW_LOGCAT: 'caspian.showLogcat',
  SHOW_EMULATOR_SCREEN: 'caspian.showEmulatorScreen',
  REFRESH_FILES: 'caspian.refreshFiles',
  PULL_FILE: 'caspian.pullFile',
  PUSH_FILE: 'caspian.pushFile',
  DELETE_FILE: 'caspian.deleteFile',
  CREATE_FOLDER: 'caspian.createFolder',
  RENAME_FILE: 'caspian.renameFile',
  OPEN_REMOTE_FILE: 'caspian.openRemoteFile',
  SELECT_DEVICE: 'caspian.selectDevice',
  SHOW_OUTPUT: 'caspian.showOutput',
  // App management
  LIST_PACKAGES: 'caspian.listPackages',
  LAUNCH_APP: 'caspian.launchApp',
  FORCE_STOP_APP: 'caspian.forceStopApp',
  CLEAR_APP_DATA: 'caspian.clearAppData',
  UNINSTALL_APP: 'caspian.uninstallApp',
  SHOW_APP_LOGCAT: 'caspian.showAppLogcat',
  // AVD enhancements
  CLONE_AVD: 'caspian.cloneAvd',
  COLD_BOOT_AVD: 'caspian.coldBootAvd',
  // Wireless ADB
  CONNECT_WIFI: 'caspian.connectWifi',
  DISCONNECT_WIFI: 'caspian.disconnectWifi',
  QR_PAIR: 'caspian.qrPair',
  // AVD diagnostics
  CHECK_AVD_DISPLAY: 'caspian.checkAvdDisplay',
  CHECK_ACCELERATION: 'caspian.checkAcceleration',
  SHOW_EMULATOR_LOG: 'caspian.showEmulatorLog',
  REPAIR_AVD: 'caspian.repairAvd',
  // Screenshot & capture
  TOGGLE_DEMO_MODE: 'caspian.toggleDemoMode',
  CAPTURE_STORE_SCREENSHOTS: 'caspian.captureStoreScreenshots',
  RUN_CAPTURE_MATRIX: 'caspian.runCaptureMatrix',
  OPEN_CAPTURE_FOLDER: 'caspian.openCaptureFolder',
  RESET_DEVICE_OVERRIDES: 'caspian.resetDeviceOverrides',
  SET_DISPLAY_CUTOUT: 'caspian.setDisplayCutout',
  SET_NAVIGATION_MODE: 'caspian.setNavigationMode',
} as const;

export const VIEWS = {
  AVD_LIST: 'caspian.avdList',
  DEVICE_LIST: 'caspian.deviceList',
  FILE_EXPLORER: 'caspian.fileExplorer',
} as const;

export const CONFIG = {
  SECTION: 'caspian',
  SDK_PATH: 'androidSdkPath',
  EMULATOR_ARGS: 'emulatorArgs',
  LOGCAT_MAX_LINES: 'logcat.maxLines',
  LOGCAT_FONT_SIZE: 'logcat.fontSize',
  LOGCAT_WRAP_LINES: 'logcat.wrapLines',
  SCRCPY_PATH: 'scrcpyPath',
  DEVICE_TRACKER_INTERVAL: 'deviceTracker.interval',
  FILE_EXPLORER_SHOW_HIDDEN: 'fileExplorer.showHidden',
  FILE_EXPLORER_DEFAULT_PATH: 'fileExplorer.defaultPath',
  AUTO_SELECT_DEVICE: 'autoSelectDevice',
  COLD_BOOT: 'emulator.coldBoot',
  // Launch pre-flight
  CHECK_HOST_MEMORY: 'emulator.checkHostMemory',
  MEMORY_HEADROOM_MB: 'emulator.memoryHeadroomMb',
  CHECK_ACCELERATION: 'emulator.checkAcceleration',
  CAPTURE_LOG: 'emulator.captureLog',
  PLAY_STRICT_ASPECT: 'avd.playStoreStrictAspect',
  BOOT_TIMEOUT_SEC: 'emulator.bootTimeoutSec',
  WATCH_HOST_MEMORY: 'emulator.watchHostMemory',
  LOW_MEMORY_FLOOR_MB: 'emulator.lowMemoryFloorMb',
  CHECK_GUEST_RAM: 'avd.checkGuestRam',
  EMULATOR_GPU_MODE: 'emulator.gpuMode',
  EMULATOR_GPU_FALLBACK: 'emulator.gpuFallback',
  PREFER_INSTALLED_IMAGE: 'avd.preferInstalledSystemImage',
  // Capture
  CAPTURE_DIRECTORY: 'captureDirectory',
  CAPTURE_OPEN_AFTER: 'capture.openAfterCapture',
  CAPTURE_USE_DEMO_MODE: 'capture.useDemoMode',
  CAPTURE_SETTLE_DELAY: 'capture.settleDelayMs',
  CAPTURE_MAX_ASPECT_RATIO: 'capture.maxAspectRatio',
  CAPTURE_FONT_SCALES: 'capture.fontScales',
  CAPTURE_LOCALES: 'capture.locales',
  CAPTURE_TABLET_TRICK: 'capture.tabletTrickForLandscape',
  CAPTURE_DETECT_LEFTOVERS: 'capture.detectLeftoverOverrides',
  // Demo mode
  DEMO_CLOCK: 'demoMode.clock',
  DEMO_BATTERY_LEVEL: 'demoMode.batteryLevel',
  DEMO_SIGNAL_LEVEL: 'demoMode.signalLevel',
  DEMO_HIDE_NOTIFICATIONS: 'demoMode.hideNotifications',
  DEMO_HIDE_STATUS_ICONS: 'demoMode.hideStatusIcons',
} as const;

/** Common SDK install locations per platform */
export const SDK_DEFAULT_PATHS: Record<string, string[]> = {
  win32: [
    `${process.env.LOCALAPPDATA}\\Android\\Sdk`,
    `${process.env.HOME}\\AppData\\Local\\Android\\Sdk`,
    'C:\\Android\\sdk',
  ],
  darwin: [
    `${process.env.HOME}/Library/Android/sdk`,
    '/usr/local/share/android-sdk',
  ],
  linux: [
    `${process.env.HOME}/Android/Sdk`,
    '/usr/local/android-sdk',
    '/opt/android-sdk',
  ],
};

/**
 * SDK download configuration.
 * Build number from: https://developer.android.com/studio#command-tools
 */
export const SDK_DOWNLOAD = {
  BASE_URL: 'https://dl.google.com/android/repository/commandlinetools',
  BUILD_NUMBER: '11076708',
  MIN_JAVA_VERSION: 17,
  MIN_DISK_SPACE: 5 * 1024 * 1024 * 1024,
  DEFAULT_AVD_NAME: 'Caspian_Default',
  DEFAULT_DEVICE_PROFILE: 'pixel_6',
  /**
   * Floor for the first-run system image, used only when `sdkmanager --list`
   * cannot be read.
   *
   * The setup wizard normally installs the newest stable Google APIs image the
   * SDK offers, so this number is a safety net rather than the usual outcome —
   * which is the point, because a pinned API level goes stale every year.
   */
  FALLBACK_API_LEVEL: 36,
  PLATFORM_KEY: {
    win32: 'win',
    darwin: 'mac',
    linux: 'linux',
  } as Record<string, string>,
} as const;

/** Picker grouping. Foldables and tablets group by form factor, phones by brand. */
export type DeviceGroup = 'pixel' | 'samsung' | 'phone' | 'foldable' | 'tablet';

/** Separator order in the device picker. */
export const DEVICE_GROUP_ORDER: DeviceGroup[] = ['pixel', 'samsung', 'phone', 'foldable', 'tablet'];

export const DEVICE_GROUP_LABELS: Record<DeviceGroup, string> = {
  pixel: 'Google Pixel',
  samsung: 'Samsung Galaxy',
  phone: 'Other phones',
  foldable: 'Foldables',
  tablet: 'Tablets',
};

export interface DevicePreset {
  name: string;
  /**
   * Stable identity for this preset: written to hw.device.name and the key for
   * findPresetByProfileId. NOT necessarily an id avdmanager knows — see sdkProfile.
   */
  profile: string;
  /**
   * The avdmanager `-d` id, when a real SDK device definition exists. Absent for
   * every non-Google device: no SDK has ever shipped a Samsung or Xiaomi profile,
   * so creation skips `-d` up front and writes the hardware below directly.
   */
  sdkProfile?: string;
  group: DeviceGroup;
  api: number;
  tag: string;
  /** Framebuffer width in px (hw.lcd.width), portrait-natural. */
  width: number;
  /** Framebuffer height in px (hw.lcd.height), portrait-natural. */
  height: number;
  /** Android density bucket in dpi (hw.lcd.density) — not physical ppi. */
  density: number;
  /** hw.ramSize, MB */
  ram: number;
  /** vm.heapSize, MB */
  heap: number;
  /** hw.initialOrientation */
  orientation: 'portrait' | 'landscape';
  /** disk.dataPartition.size — applied at creation only, never on repair. */
  dataPartition: string;
  manufacturer: string;
  /** True when the real device has more than one physical display. */
  foldable?: boolean;
}

/**
 * Curated list of popular Android devices for one-click AVD creation.
 *
 * For rows that carry an `sdkProfile`, the hardware fields are a *fallback* used
 * when this SDK's cmdline-tools do not carry the device definition (e.g. build
 * 11076708 predates every Pixel 9 profile). Without them `avdmanager create avd`
 * omits hw.lcd.* entirely and the emulator falls back to 320x640 @ 160 dpi with
 * 96 MB of RAM. When the SDK *does* have the profile, its values win — see
 * AvdManager.createAvd.
 *
 * For rows with no `sdkProfile` — every Samsung, OnePlus and Xiaomi entry — no
 * device definition exists anywhere, so these values *are* the device. Densities
 * are picked so the resulting dp size matches the real hardware (dp = px*160/dpi),
 * because dp is what layouts actually respond to: a Galaxy S25 Ultra is 1440 px
 * wide at 600 dpi, i.e. 384dp, not the 411dp a Pixel-ish 560 dpi would give.
 *
 * `ram` must clear guestRamFloorMb() for the image that ends up being used, and
 * `api` is only a floor — pickInstalledSystemImage happily pairs an old preset
 * with the newest installed image — so every GMS row sits at 2560 MB or above
 * regardless of its declared API level. Otherwise the AVD is born wearing the
 * "low RAM" warning badge. Pair `heap` with heapForRamMb(ram).
 */
export const DEVICE_PRESETS: DevicePreset[] = [
  // ── Google Pixel ──────────────────────────────────────────────────────────
  { name: 'Pixel 10 Pro XL', profile: 'pixel_10_pro_xl',      sdkProfile: 'pixel_10_pro_xl',      group: 'pixel',    api: 36, tag: 'google_apis', width: 1344, height: 2992, density: 480, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 10 Pro',    profile: 'pixel_10_pro',         sdkProfile: 'pixel_10_pro',         group: 'pixel',    api: 36, tag: 'google_apis', width: 1280, height: 2856, density: 480, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 10',        profile: 'pixel_10',             sdkProfile: 'pixel_10',             group: 'pixel',    api: 36, tag: 'google_apis', width: 1080, height: 2424, density: 420, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 9 Pro XL',  profile: 'pixel_9_pro_xl',       sdkProfile: 'pixel_9_pro_xl',       group: 'pixel',    api: 36, tag: 'google_apis', width: 1344, height: 2992, density: 480, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 9 Pro',     profile: 'pixel_9_pro',          sdkProfile: 'pixel_9_pro',          group: 'pixel',    api: 36, tag: 'google_apis', width: 1280, height: 2856, density: 480, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 9',         profile: 'pixel_9',              sdkProfile: 'pixel_9',              group: 'pixel',    api: 36, tag: 'google_apis', width: 1080, height: 2424, density: 420, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 9a',        profile: 'pixel_9a',             sdkProfile: 'pixel_9a',             group: 'pixel',    api: 36, tag: 'google_apis', width: 1080, height: 2424, density: 420, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 8 Pro',     profile: 'pixel_8_pro',          sdkProfile: 'pixel_8_pro',          group: 'pixel',    api: 34, tag: 'google_apis', width: 1344, height: 2992, density: 480, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 8',         profile: 'pixel_8',              sdkProfile: 'pixel_8',              group: 'pixel',    api: 34, tag: 'google_apis', width: 1080, height: 2400, density: 420, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 7 Pro',     profile: 'pixel_7_pro',          sdkProfile: 'pixel_7_pro',          group: 'pixel',    api: 33, tag: 'google_apis', width: 1440, height: 3120, density: 560, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 7',         profile: 'pixel_7',              sdkProfile: 'pixel_7',              group: 'pixel',    api: 33, tag: 'google_apis', width: 1080, height: 2400, density: 420, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 7a',        profile: 'pixel_7a',             sdkProfile: 'pixel_7a',             group: 'pixel',    api: 33, tag: 'google_apis', width: 1080, height: 2400, density: 420, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 6 Pro',     profile: 'pixel_6_pro',          sdkProfile: 'pixel_6_pro',          group: 'pixel',    api: 32, tag: 'google_apis', width: 1440, height: 3120, density: 560, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 6',         profile: 'pixel_6',              sdkProfile: 'pixel_6',              group: 'pixel',    api: 32, tag: 'google_apis', width: 1080, height: 2400, density: 420, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 6a',        profile: 'pixel_6a',             sdkProfile: 'pixel_6a',             group: 'pixel',    api: 32, tag: 'google_apis', width: 1080, height: 2400, density: 420, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Pixel 4 XL',      profile: 'pixel_4_xl',           sdkProfile: 'pixel_4_xl',           group: 'pixel',    api: 30, tag: 'google_apis', width: 1440, height: 3040, density: 560, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Nexus 5X',        profile: 'Nexus 5X',             sdkProfile: 'Nexus 5X',             group: 'pixel',    api: 28, tag: 'google_apis', width: 1080, height: 1920, density: 420, ram: 2560, heap: 320, orientation: 'portrait',  dataPartition: '2G', manufacturer: 'Google' },

  // ── Samsung Galaxy ────────────────────────────────────────────────────────
  // No sdkProfile: avdmanager has never shipped a Samsung device definition, so
  // the hardware below is authoritative rather than a fallback.
  { name: 'Galaxy S25 Ultra', profile: 'samsung_galaxy_s25_ultra', group: 'samsung', api: 35, tag: 'google_apis', width: 1440, height: 3120, density: 600, ram: 2560, heap: 320, orientation: 'portrait', dataPartition: '6G', manufacturer: 'Samsung' },
  { name: 'Galaxy S25 Plus',  profile: 'samsung_galaxy_s25_plus',  group: 'samsung', api: 35, tag: 'google_apis', width: 1440, height: 3120, density: 560, ram: 2560, heap: 320, orientation: 'portrait', dataPartition: '6G', manufacturer: 'Samsung' },
  { name: 'Galaxy S25',       profile: 'samsung_galaxy_s25',       group: 'samsung', api: 35, tag: 'google_apis', width: 1080, height: 2340, density: 480, ram: 2560, heap: 320, orientation: 'portrait', dataPartition: '6G', manufacturer: 'Samsung' },
  { name: 'Galaxy S24 Ultra', profile: 'samsung_galaxy_s24_ultra', group: 'samsung', api: 34, tag: 'google_apis', width: 1440, height: 3120, density: 600, ram: 2560, heap: 320, orientation: 'portrait', dataPartition: '6G', manufacturer: 'Samsung' },
  { name: 'Galaxy S24',       profile: 'samsung_galaxy_s24',       group: 'samsung', api: 34, tag: 'google_apis', width: 1080, height: 2340, density: 480, ram: 2560, heap: 320, orientation: 'portrait', dataPartition: '6G', manufacturer: 'Samsung' },
  { name: 'Galaxy A55',       profile: 'samsung_galaxy_a55',       group: 'samsung', api: 34, tag: 'google_apis', width: 1080, height: 2340, density: 420, ram: 2560, heap: 320, orientation: 'portrait', dataPartition: '6G', manufacturer: 'Samsung' },

  // ── Other phones ──────────────────────────────────────────────────────────
  { name: 'OnePlus 13',    profile: 'oneplus_13',    group: 'phone', api: 35, tag: 'google_apis', width: 1440, height: 3168, density: 560, ram: 2560, heap: 320, orientation: 'portrait', dataPartition: '6G', manufacturer: 'OnePlus' },
  { name: 'OnePlus 12',    profile: 'oneplus_12',    group: 'phone', api: 34, tag: 'google_apis', width: 1440, height: 3168, density: 560, ram: 2560, heap: 320, orientation: 'portrait', dataPartition: '6G', manufacturer: 'OnePlus' },
  { name: 'Xiaomi 14',     profile: 'xiaomi_14',     group: 'phone', api: 34, tag: 'google_apis', width: 1200, height: 2670, density: 480, ram: 2560, heap: 320, orientation: 'portrait', dataPartition: '6G', manufacturer: 'Xiaomi' },
  { name: 'Redmi Note 13', profile: 'redmi_note_13', group: 'phone', api: 34, tag: 'google_apis', width: 1080, height: 2400, density: 440, ram: 2560, heap: 320, orientation: 'portrait', dataPartition: '6G', manufacturer: 'Xiaomi' },

  // ── Foldables (dimensions are the unfolded inner display) ─────────────────
  { name: 'Pixel 10 Pro Fold', profile: 'pixel_10_pro_fold', sdkProfile: 'pixel_10_pro_fold', group: 'foldable', api: 36, tag: 'google_apis', width: 2152, height: 2076, density: 420, ram: 3072, heap: 384, orientation: 'landscape', dataPartition: '6G', manufacturer: 'Google',  foldable: true },
  { name: 'Pixel Fold',        profile: 'pixel_fold',        sdkProfile: 'pixel_fold',        group: 'foldable', api: 34, tag: 'google_apis', width: 2208, height: 1840, density: 420, ram: 3072, heap: 384, orientation: 'landscape', dataPartition: '6G', manufacturer: 'Google',  foldable: true },
  { name: 'Galaxy Z Fold 6',   profile: 'samsung_galaxy_z_fold_6', group: 'foldable', api: 35, tag: 'google_apis', width: 2160, height: 1856, density: 420, ram: 3072, heap: 384, orientation: 'landscape', dataPartition: '6G', manufacturer: 'Samsung', foldable: true },
  { name: 'Galaxy Z Flip 6',   profile: 'samsung_galaxy_z_flip_6', group: 'foldable', api: 35, tag: 'google_apis', width: 1080, height: 2640, density: 420, ram: 3072, heap: 384, orientation: 'portrait',  dataPartition: '6G', manufacturer: 'Samsung', foldable: true },

  // ── Tablets ───────────────────────────────────────────────────────────────
  { name: 'Pixel Tablet',         profile: 'pixel_tablet',              sdkProfile: 'pixel_tablet',              group: 'tablet', api: 34, tag: 'google_apis', width: 2560, height: 1600, density: 320, ram: 3072, heap: 384, orientation: 'landscape', dataPartition: '6G', manufacturer: 'Google' },
  { name: 'Galaxy Tab S10 Ultra', profile: 'samsung_galaxy_tab_s10_ultra', group: 'tablet', api: 35, tag: 'google_apis', width: 2960, height: 1848, density: 320, ram: 3072, heap: 384, orientation: 'landscape', dataPartition: '6G', manufacturer: 'Samsung' },
  { name: 'Galaxy Tab S9',        profile: 'samsung_galaxy_tab_s9',        group: 'tablet', api: 34, tag: 'google_apis', width: 2560, height: 1600, density: 320, ram: 3072, heap: 384, orientation: 'landscape', dataPartition: '6G', manufacturer: 'Samsung' },
  { name: 'OnePlus Pad 2',        profile: 'oneplus_pad_2',                group: 'tablet', api: 34, tag: 'google_apis', width: 3000, height: 2120, density: 320, ram: 3072, heap: 384, orientation: 'landscape', dataPartition: '6G', manufacturer: 'OnePlus' },
  { name: '7" Tablet',            profile: '7in WSVGA (Tablet)',   sdkProfile: '7in WSVGA (Tablet)',   group: 'tablet', api: 36, tag: 'google_apis', width: 1024, height:  600, density: 160, ram: 3072, heap: 384, orientation: 'landscape', dataPartition: '6G', manufacturer: 'Generic' },
  { name: '10" Tablet',           profile: '10.1in WXGA (Tablet)', sdkProfile: '10.1in WXGA (Tablet)', group: 'tablet', api: 36, tag: 'google_apis', width: 1280, height:  800, density: 160, ram: 3072, heap: 384, orientation: 'landscape', dataPartition: '6G', manufacturer: 'Generic' },
];

/**
 * Default AVD name for a preset, safe for the `/^[a-zA-Z0-9_.-]+$/` validator.
 *
 * Stripping only whitespace is not enough: `7" Tablet` produced `7"_Tablet_API36`,
 * which the very next input box rejected.
 */
export function avdNameForPreset(preset: DevicePreset): string {
  const slug = preset.name.replace(/[^a-zA-Z0-9_.-]+/g, '_').replace(/^_+|_+$/g, '');
  return `${slug}_API${preset.api}`;
}

/** Look up a preset by its avdmanager device-profile id. */
export function findPresetByProfileId(id: string): DevicePreset | undefined {
  return DEVICE_PRESETS.find(p => p.profile === id);
}

/** Best-effort preset match for an existing AVD, for repair suggestions. */
export function findPresetForAvd(
  config: Record<string, string>,
  avdName: string,
): DevicePreset | undefined {
  const byDevice = config['hw.device.name'];
  if (byDevice) {
    const hit = findPresetByProfileId(byDevice);
    if (hit) { return hit; }
  }
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  // Drop a trailing "_API34"/"API 34" first. Slugging eats the separators, so
  // the A of API fuses onto the model number and "Pixel_6_API32" -> "pixel6api32"
  // matches the "pixel6a" of Pixel 6a — the wrong device, one letter away.
  const dropApiSuffix = (s: string) => s.replace(/[_\s-]*api[_\s-]*\d+\s*$/i, '');
  const haystack = slug(
    `${dropApiSuffix(config['avd.ini.displayname'] || '')} ${dropApiSuffix(avdName)}`
  );
  // Longest name first, so "Pixel 9 Pro" wins over "Pixel 9".
  return [...DEVICE_PRESETS]
    .sort((a, b) => b.name.length - a.name.length)
    .find(p => haystack.includes(slug(p.name)) || haystack.includes(slug(p.profile)));
}

/** Display sanity and Play Console screenshot rules, shared by AVD checks and capture validation. */
export const DISPLAY_RULES = {
  /** Play Console: each side must be at least this many pixels. */
  PLAY_MIN_SIDE: 320,
  /** Play Console: each side must be at most this many pixels. */
  PLAY_MAX_SIDE: 3840,
  /**
   * Play's documented promotional-eligibility ratio. Reported, never the gate:
   * a Pixel 8 is 2.222:1 and a Pixel 9 Pro is 2.231:1, so enforcing this would
   * fail every device in DEVICE_PRESETS.
   */
  PLAY_PROMO_ASPECT: 16 / 9,
  /** Practical upload ceiling for long-side / short-side. */
  PLAY_MAX_ASPECT: 2.0,
  /**
   * Backstop for garbage display sizes. Kept below the smallest legitimate
   * preset (the 1024x600 WSVGA tablet) on purpose — the AOSP 320x640 fallback
   * has its own explicit fingerprint check, so this floor only needs to catch
   * sizes no real device profile uses. Raising it to a "modern phone" value
   * would flag correctly configured tablets as broken.
   */
  SANE_MIN_SHORT_SIDE: 600,
  SANE_MAX_ASPECT: 2.5,
  SANE_MIN_DENSITY: 120,
  SANE_MAX_DENSITY: 640,
  /** Play caps screenshots per listing type. */
  PLAY_MAX_SHOTS_PER_LOCALE: 8,
  /** The AOSP hardware-properties.ini fallback — the exact bug fingerprint. */
  AOSP_FALLBACK_WIDTH: 320,
  AOSP_FALLBACK_HEIGHT: 640,
  AOSP_FALLBACK_DENSITY: 160,
  AOSP_FALLBACK_RAM_MB: 96,
  /**
   * Deflated bytes per pixel below which a capture is suspected of carrying no
   * image — a screenshot from an emulator that is not rendering.
   *
   * Measured on the frame that prompted this check: 12,504 bytes for 1080x1920
   * black is 0.0060 B/px, against 0.384 B/px for the same screen rendering. The
   * threshold sits ~8x above the former and ~7.7x below the latter.
   *
   * Deliberately a ratio, not a flat byte count: the previous flat 10 KB floor
   * came to 0.0049 B/px at that resolution — under the black frame it existed
   * to catch — and scaled the wrong way across display sizes.
   */
  MIN_BYTES_PER_PIXEL: 0.05,
} as const;

/** Emulator launch pre-flight thresholds. */
export const LAUNCH_PREFLIGHT = {
  /** The emulator's own default when hw.ramSize is absent from config.ini. */
  DEFAULT_AVD_RAM_MB: 1536,
  /** QEMU + GPU/ANGLE + emulator UI overhead beyond the guest RAM. */
  EMULATOR_OVERHEAD_MB: 768,
  /** Free memory to leave for the host on top of the requirement. */
  DEFAULT_HEADROOM_MB: 1024,
  TOP_PROCESS_COUNT: 4,
  PROCESS_QUERY_TIMEOUT_MS: 2500,
  ACCEL_CHECK_TIMEOUT_MS: 8000,
} as const;

/**
 * GPU rendering modes passed to the emulator as `-gpu <mode>`.
 *
 * 'auto' means "add no -gpu flag at all" and let the emulator decide, which is
 * the behaviour every version before this one had.
 */
export const GPU_MODES = ['auto', 'host', 'swiftshader', 'swiftshader_indirect', 'angle_indirect'] as const;
export type GpuMode = typeof GPU_MODES[number];

/**
 * The order tried when a launch fails and fallback is enabled.
 *
 * Ends at plain 'swiftshader' because that is the mode with no dependency on
 * the host's graphics stack at all — the last thing that can still work on a
 * machine whose GL is broken. 'swiftshader_indirect' sits in front of it
 * because it is faster when it works, and it often does.
 */
export const GPU_FALLBACK_LADDER: GpuMode[] = ['auto', 'swiftshader_indirect', 'swiftshader'];

/**
 * Guest RAM floors — how much memory Android itself needs inside the VM.
 *
 * Distinct from LAUNCH_PREFLIGHT, which asks whether the *host* can spare the
 * AVD's configured RAM. This asks whether that configured RAM is enough for the
 * system image at all. A modern Play/Google-APIs image on 1536 MB boots, then
 * sits at ~100 MB free, swaps, and ANRs ("System UI isn't responding") — which
 * looks like a broken app rather than an under-provisioned device.
 */
export const RAM_RULES = {
  /** API 33+ with Google APIs or Play Store. Below this the guest thrashes. */
  GMS_MIN_RAM_MB: 2560,
  /** AOSP images carry no Play services and boot comfortably on less. */
  AOSP_MIN_RAM_MB: 1536,
  /** Google-APIs images below this API predate the memory growth. */
  GMS_MIN_API: 33,
  /** vm.heapSize written alongside a RAM repair, as a fraction of ramSize. */
  HEAP_FRACTION: 1 / 8,
  /** Floor and ceiling for the derived vm.heapSize, MB. */
  MIN_HEAP_MB: 192,
  MAX_HEAP_MB: 512,
} as const;

/**
 * Boot-readiness watch.
 *
 * `adb devices` reports state=device as soon as the emulator's console port is
 * up, which is long before Android is usable — the shell can still return
 * "Broken pipe" from package manager. These govern the real readiness probe.
 */
export const BOOT_WATCH = {
  /** Default ceiling on the boot wait. A cold boot after -wipe-data is slow. */
  DEFAULT_TIMEOUT_SEC: 180,
  /** Gap between readiness probes. */
  POLL_MS: 2000,
  /** How long to wait for `adb emu kill` to actually drop the device. */
  STOP_VERIFY_MS: 10000,
  STOP_POLL_MS: 500,
} as const;

/** SystemUI overlay categories used for cutout and navigation-bar emulation. */
export const OVERLAY_CATEGORIES = {
  CUTOUT: 'com.android.internal.display.cutout.emulation',
  NAVBAR: 'com.android.internal.systemui.navbar',
} as const;

/** Display-cutout emulation overlays. `cutout` is the value shown in the picker. */
export const CUTOUT_MODES: { id: string; label: string; description: string; pkg?: string }[] = [
  { id: 'none', label: 'None', description: 'No cutout — the default display' },
  { id: 'corner', label: 'Corner', description: 'Corner cutout', pkg: `${OVERLAY_CATEGORIES.CUTOUT}.corner` },
  { id: 'double', label: 'Double', description: 'Cutouts on both edges', pkg: `${OVERLAY_CATEGORIES.CUTOUT}.double` },
  { id: 'hole', label: 'Punch Hole', description: 'Hole-punch camera', pkg: `${OVERLAY_CATEGORIES.CUTOUT}.hole` },
  { id: 'tall', label: 'Tall', description: 'Tall notch', pkg: `${OVERLAY_CATEGORIES.CUTOUT}.tall` },
  { id: 'waterfall', label: 'Waterfall', description: 'Curved waterfall edges', pkg: `${OVERLAY_CATEGORIES.CUTOUT}.waterfall` },
];

/** Navigation-bar mode emulation overlays. */
export const NAVBAR_MODES: { id: string; label: string; description: string; pkg: string }[] = [
  { id: 'gestural', label: 'Gesture Navigation', description: 'Full-screen gestures (Android 10+ default)', pkg: `${OVERLAY_CATEGORIES.NAVBAR}.gestural` },
  { id: 'twobutton', label: '2-Button Navigation', description: 'Pill and back button (Android 9)', pkg: `${OVERLAY_CATEGORIES.NAVBAR}.twobutton` },
  { id: 'threebutton', label: '3-Button Navigation', description: 'Back, home, and recents', pkg: `${OVERLAY_CATEGORIES.NAVBAR}.threebutton` },
];

/** Minimum API levels for the overlay-based emulation commands. */
export const OVERLAY_MIN_API = {
  /** Cutout emulation overlays ship from Android 9. */
  CUTOUT: 28,
  /** Gestural navigation, and the navbar overlay set, ship from Android 10. */
  NAVBAR: 29,
} as const;

/** Returns the appropriate system image ABI for the current machine */
export function getDefaultAbi(): string {
  return process.platform === 'darwin' && process.arch === 'arm64' ? 'arm64-v8a' : 'x86_64';
}

export const SDK_TOOLS = {
  ADB: process.platform === 'win32' ? 'adb.exe' : 'adb',
  EMULATOR: process.platform === 'win32' ? 'emulator.exe' : 'emulator',
  AVDMANAGER: process.platform === 'win32' ? 'avdmanager.bat' : 'avdmanager',
  SDKMANAGER: process.platform === 'win32' ? 'sdkmanager.bat' : 'sdkmanager',
} as const;

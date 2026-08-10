import { AdbClient } from '../adb/AdbClient';
import { CUTOUT_MODES, NAVBAR_MODES, OVERLAY_CATEGORIES } from '../constants';
import { Logger } from '../utils/Logger';

/**
 * Display-cutout and navigation-bar emulation via runtime resource overlays.
 *
 * Every Android system image ships these overlays disabled; enabling one makes
 * the framework report a real cutout inset or switch navigation mode without
 * touching the AVD's hardware profile. They are the only way to check
 * edge-to-edge layout — which Android 15 now enforces — against a notch, a
 * hole-punch, or gesture navigation without creating an AVD per shape.
 *
 * Like demo mode, `cmd overlay` reports success unreliably, so every change is
 * verified by reading `cmd overlay list` back.
 */

export type OverlayCategory = 'cutout' | 'navbar';

const CATEGORY_PKG: Record<OverlayCategory, string> = {
  cutout: OVERLAY_CATEGORIES.CUTOUT,
  navbar: OVERLAY_CATEGORIES.NAVBAR,
};

/** All overlay packages belonging to a category, whether or not installed. */
export function packagesInCategory(category: OverlayCategory): string[] {
  return category === 'cutout'
    ? CUTOUT_MODES.map(m => m.pkg).filter((p): p is string => !!p)
    : NAVBAR_MODES.map(m => m.pkg);
}

/** The mode id currently enabled in a category, from an overlay listing. */
export function activeModeId(
  category: OverlayCategory,
  overlays: Array<{ pkg: string; enabled: boolean }>,
): string {
  const modes = category === 'cutout' ? CUTOUT_MODES : NAVBAR_MODES;
  const hit = overlays.find(o => o.enabled && o.pkg.startsWith(CATEGORY_PKG[category]));
  if (!hit) { return category === 'cutout' ? 'none' : 'threebutton'; }
  return modes.find(m => m.pkg === hit.pkg)?.id ?? 'none';
}

export class SystemUiOverlayController {
  constructor(private adb: AdbClient) {}

  /** Which overlay packages in a category are installed on this image. */
  async available(serial: string, category: OverlayCategory): Promise<Set<string>> {
    const overlays = await this.adb.listOverlays(serial);
    const known = new Set(packagesInCategory(category));
    return new Set(overlays.map(o => o.pkg).filter(p => known.has(p)));
  }

  /** The mode id currently active in a category. */
  async current(serial: string, category: OverlayCategory): Promise<string> {
    return activeModeId(category, await this.adb.listOverlays(serial));
  }

  /**
   * Apply a mode. Pass `undefined` as pkg to disable the whole category —
   * which is what "no cutout" means, since there is no "none" overlay.
   *
   * Returns the mode id actually in force afterwards, read back from the
   * device, so a caller can report a silent no-op rather than claim success.
   */
  async apply(
    serial: string,
    category: OverlayCategory,
    pkg: string | undefined,
  ): Promise<string> {
    if (pkg) {
      await this.adb.enableOverlayExclusive(serial, pkg);
    } else {
      for (const candidate of packagesInCategory(category)) {
        try {
          await this.adb.disableOverlay(serial, candidate);
        } catch {
          // Not installed on this image, or already off — both are fine.
        }
      }
    }

    const applied = await this.current(serial, category);
    Logger.info(`Overlay category ${category} on ${serial} is now "${applied}".`);
    return applied;
  }

  /** Disable every overlay this extension knows how to enable. */
  async resetAll(serial: string): Promise<void> {
    for (const category of ['cutout', 'navbar'] as OverlayCategory[]) {
      for (const pkg of packagesInCategory(category)) {
        try {
          await this.adb.disableOverlay(serial, pkg);
        } catch { /* not installed, or already disabled */ }
      }
    }
  }
}

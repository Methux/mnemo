// SPDX-License-Identifier: MIT
/**
 * License check — determines whether enhanced features are available.
 * When @mnemoai/pro is installed and configured, additional strategies activate.
 */

import { log } from "./logger.js";

let _cachedResult: boolean | null = null;
let _warnedOnce = false;

/**
 * Check if enhanced features are available.
 */
export function isProLicensed(): boolean {
  if (_cachedResult !== null) return _cachedResult;

  // Check if @mnemoai/pro module is resolvable
  try {
    require.resolve("@mnemoai/pro");
    _cachedResult = true;
    return true;
  } catch {
    // Not installed
  }

  _cachedResult = false;
  return false;
}

/**
 * Async version — for initialization flows.
 */
export async function ensureProLicense(): Promise<boolean> {
  return isProLicensed();
}

/**
 * Gate a feature behind enhanced license.
 */
export function requirePro(featureName: string): boolean {
  if (isProLicensed()) return true;

  if (!_warnedOnce && process.env.MNEMO_DEBUG) {
    log.info(
      `Enhanced feature "${featureName}" requires @mnemoai/pro. ` +
      `Core functionality is fully available. https://m-nemo.ai`,
    );
    _warnedOnce = true;
  }
  return false;
}

export function getLicenseInfo(): null {
  return null;
}

export function _resetLicenseCache(): void {
  _cachedResult = null;
  _warnedOnce = false;
}

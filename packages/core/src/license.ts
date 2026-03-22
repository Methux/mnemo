// SPDX-License-Identifier: MIT
/**
 * Mnemo Pro License Validation
 *
 * Validates MNEMO_PRO_KEY using Ed25519 signature verification.
 * Free users get full Core functionality; Pro features degrade gracefully.
 *
 * Key format: base64(JSON payload).base64(Ed25519 signature)
 * Payload: { licensee, email, plan, issued, expires }
 */

import { verify, createPublicKey } from "node:crypto";

// Ed25519 public key (DER/SPKI, base64) — safe to publish
const PUBLIC_KEY_B64 =
  "MCowBQYDK2VwAyEAe8cshR0FAlDoILPw0aW1AyUNGbQXSOZaQKEZ7T2mXV8=";

let _cachedResult: boolean | null = null;
let _cachedPayload: LicensePayload | null = null;
let _warnedOnce = false;

export interface LicensePayload {
  licensee: string;   // Company or individual name
  email: string;      // Contact email
  plan: "indie" | "team" | "enterprise";
  issued: string;     // ISO date
  expires: string;    // ISO date (empty = perpetual)
}

/**
 * Check whether a valid Mnemo Pro license key is present.
 * Result is cached for the lifetime of the process.
 */
export function isProLicensed(): boolean {
  if (_cachedResult !== null) return _cachedResult;

  const key = process.env.MNEMO_PRO_KEY?.trim();
  if (!key) {
    _cachedResult = false;
    return false;
  }

  // Key format: base64(payload).base64(signature)
  const dotIdx = key.indexOf(".");
  if (dotIdx < 1) {
    _cachedResult = false;
    return false;
  }

  try {
    const payloadB64 = key.slice(0, dotIdx);
    const signatureB64 = key.slice(dotIdx + 1);

    const payloadBuf = Buffer.from(payloadB64, "base64");
    const signatureBuf = Buffer.from(signatureB64, "base64");

    const pubKeyObj = createPublicKey({
      key: Buffer.from(PUBLIC_KEY_B64, "base64"),
      format: "der",
      type: "spki",
    });

    const valid = verify(null, payloadBuf, pubKeyObj, signatureBuf);
    if (!valid) {
      _cachedResult = false;
      return false;
    }

    // Parse and validate payload
    const payload: LicensePayload = JSON.parse(payloadBuf.toString("utf8"));
    if (payload.expires) {
      const expiresAt = new Date(payload.expires).getTime();
      if (expiresAt < Date.now()) {
        console.warn(`[mnemo] Pro license expired on ${payload.expires}. Renew at https://mnemo.dev/pro`);
        _cachedResult = false;
        return false;
      }
    }

    _cachedPayload = payload;
    _cachedResult = true;
  } catch {
    _cachedResult = false;
  }

  return _cachedResult;
}

/**
 * Get the decoded license payload (null if unlicensed).
 */
export function getLicenseInfo(): LicensePayload | null {
  isProLicensed(); // ensure cache is populated
  return _cachedPayload;
}

/**
 * Guard for Pro features. Returns true if licensed, false if not.
 * Logs a one-time warning when Pro feature is accessed without a license.
 */
export function requirePro(featureName: string): boolean {
  if (isProLicensed()) return true;

  if (!_warnedOnce) {
    console.warn(
      `[mnemo] Pro features disabled — set MNEMO_PRO_KEY to enable. ` +
      `Core functionality is fully available. https://mnemo.dev/pro`,
    );
    _warnedOnce = true;
  }
  if (process.env.MNEMO_DEBUG) {
    console.debug(`[mnemo] Pro feature skipped: ${featureName}`);
  }
  return false;
}

/**
 * Reset cached license result (for testing).
 */
export function _resetLicenseCache(): void {
  _cachedResult = null;
  _cachedPayload = null;
  _warnedOnce = false;
}

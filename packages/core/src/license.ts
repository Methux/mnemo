// SPDX-License-Identifier: MIT
/**
 * Mnemo Pro License Validation
 *
 * Two modes:
 *   1. MNEMO_PRO_KEY — pre-activated key (offline, machine-bound)
 *   2. MNEMO_LICENSE_TOKEN — auto-activate on first run (online, one-time)
 *
 * Machine fingerprint: SHA-256(hostname + arch + cpuModel + platform)
 * Indie keys are bound to one machine. Team/Enterprise keys are per-seat.
 */

import { verify, createPublicKey, createHash } from "node:crypto";
import { hostname, arch, cpus, platform } from "node:os";
import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

// Ed25519 public key (DER/SPKI, base64) — safe to publish
const PUBLIC_KEY_B64 =
  "MCowBQYDK2VwAyEAe8cshR0FAlDoILPw0aW1AyUNGbQXSOZaQKEZ7T2mXV8=";

const ACTIVATION_URL =
  process.env.MNEMO_ACTIVATION_URL || "https://activation.m-nemo.ai";

const KEY_CACHE_PATH = join(homedir(), ".mnemo", "pro-key.json");

let _cachedResult: boolean | null = null;
let _cachedPayload: LicensePayload | null = null;
let _warnedOnce = false;

export interface LicensePayload {
  licensee: string;
  email: string;
  plan: "indie" | "team" | "enterprise";
  issued: string;
  expires: string;
  machine_id?: string;
}

// ── Machine Fingerprint ──

export function getMachineFingerprint(): string {
  const cpu = cpus()[0]?.model || "unknown";
  const raw = `${hostname()}:${arch()}:${cpu}:${platform()}`;
  return createHash("sha256").update(raw).digest("hex");
}

// ── Key Verification (offline) ──

function verifyKey(key: string): LicensePayload | null {
  const dotIdx = key.indexOf(".");
  if (dotIdx < 1) return null;

  try {
    const payloadBuf = Buffer.from(key.slice(0, dotIdx), "base64");
    const signatureBuf = Buffer.from(key.slice(dotIdx + 1), "base64");

    const pubKeyObj = createPublicKey({
      key: Buffer.from(PUBLIC_KEY_B64, "base64"),
      format: "der",
      type: "spki",
    });

    const valid = verify(null, payloadBuf, pubKeyObj, signatureBuf);
    if (!valid) return null;

    const payload: LicensePayload = JSON.parse(payloadBuf.toString("utf8"));

    // Check expiry
    if (payload.expires) {
      if (new Date(payload.expires).getTime() < Date.now()) return null;
    }

    // Check machine binding (if present in payload)
    if (payload.machine_id) {
      const localFP = getMachineFingerprint();
      if (payload.machine_id !== localFP) return null;
    }

    return payload;
  } catch {
    return null;
  }
}

// ── Auto-Activation (online, one-time) ──

async function autoActivate(token: string): Promise<string | null> {
  try {
    const machine_id = getMachineFingerprint();
    const resp = await fetch(`${ACTIVATION_URL}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token, machine_id }),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const err = await resp.json().catch(() => ({})) as any;
      if (resp.status === 409) {
        console.warn(
          `[mnemo] License token already activated on another device. ` +
          `Visit https://m-nemo.ai/pro/migrate to transfer.`
        );
      } else {
        console.warn(`[mnemo] Activation failed: ${err.error || resp.status}`);
      }
      return null;
    }

    const { key } = await resp.json() as { key: string };

    // Cache the activated key locally
    try {
      mkdirSync(join(homedir(), ".mnemo"), { recursive: true });
      writeFileSync(KEY_CACHE_PATH, JSON.stringify({ key, token, activated: new Date().toISOString() }));
    } catch { /* non-fatal */ }

    return key;
  } catch (err) {
    console.warn(`[mnemo] Activation request failed (offline?): ${err}`);
    return null;
  }
}

// ── Load cached key from disk ──

function loadCachedKey(): string | null {
  try {
    const data = JSON.parse(readFileSync(KEY_CACHE_PATH, "utf8"));
    return data.key || null;
  } catch {
    return null;
  }
}

// ── Main entry point ──

export function isProLicensed(): boolean {
  if (_cachedResult !== null) return _cachedResult;

  // Priority 1: explicit MNEMO_PRO_KEY env var
  const explicitKey = process.env.MNEMO_PRO_KEY?.trim();
  if (explicitKey) {
    const payload = verifyKey(explicitKey);
    if (payload) {
      _cachedPayload = payload;
      _cachedResult = true;
      return true;
    }
  }

  // Priority 2: cached key from previous activation
  const cachedKey = loadCachedKey();
  if (cachedKey) {
    const payload = verifyKey(cachedKey);
    if (payload) {
      _cachedPayload = payload;
      _cachedResult = true;
      return true;
    }
  }

  // Priority 3: auto-activate with token (async — won't block first call)
  const token = process.env.MNEMO_LICENSE_TOKEN?.trim();
  if (token) {
    // Fire and forget — next process start will pick up cached key
    autoActivate(token).then((key) => {
      if (key) {
        const payload = verifyKey(key);
        if (payload) {
          _cachedPayload = payload;
          _cachedResult = true;
          console.log(`[mnemo] Pro license activated for ${payload.licensee} (${payload.plan})`);
        }
      }
    }).catch(() => {});
  }

  _cachedResult = false;
  return false;
}

/**
 * Async version — waits for activation to complete if token is present.
 * Use this during plugin initialization.
 */
export async function ensureProLicense(): Promise<boolean> {
  if (_cachedResult !== null) return _cachedResult;

  // Check explicit key
  const explicitKey = process.env.MNEMO_PRO_KEY?.trim();
  if (explicitKey) {
    const payload = verifyKey(explicitKey);
    if (payload) {
      _cachedPayload = payload;
      _cachedResult = true;
      return true;
    }
  }

  // Check cached key
  const cachedKey = loadCachedKey();
  if (cachedKey) {
    const payload = verifyKey(cachedKey);
    if (payload) {
      _cachedPayload = payload;
      _cachedResult = true;
      return true;
    }
  }

  // Try auto-activate with token
  const token = process.env.MNEMO_LICENSE_TOKEN?.trim();
  if (token) {
    const key = await autoActivate(token);
    if (key) {
      const payload = verifyKey(key);
      if (payload) {
        _cachedPayload = payload;
        _cachedResult = true;
        console.log(`[mnemo] Pro license activated for ${payload.licensee} (${payload.plan})`);
        return true;
      }
    }
  }

  _cachedResult = false;
  return false;
}

export function getLicenseInfo(): LicensePayload | null {
  isProLicensed();
  return _cachedPayload;
}

export function requirePro(featureName: string): boolean {
  if (isProLicensed()) return true;

  if (!_warnedOnce) {
    console.warn(
      `[mnemo] Pro features disabled — set MNEMO_PRO_KEY or MNEMO_LICENSE_TOKEN to enable. ` +
      `Core functionality is fully available. https://m-nemo.ai/pro`,
    );
    _warnedOnce = true;
  }
  if (process.env.MNEMO_DEBUG) {
    console.debug(`[mnemo] Pro feature skipped: ${featureName}`);
  }
  return false;
}

export function _resetLicenseCache(): void {
  _cachedResult = null;
  _cachedPayload = null;
  _warnedOnce = false;
}

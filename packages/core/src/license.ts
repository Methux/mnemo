// SPDX-License-Identifier: MIT
/**
 * Mnemo Pro License Validation (LemonSqueezy)
 *
 * Flow:
 *   1. User sets MNEMO_PRO_KEY to their LemonSqueezy license key
 *   2. First run: activate via LemonSqueezy API (binds to machine)
 *   3. Cache result locally (~/.mnemo/pro-license.json)
 *   4. Subsequent runs: use cache, re-validate every 7 days
 *   5. Subscription cancelled: re-validation fails, Pro disabled
 *
 * Machine fingerprint: SHA-256(hostname + arch + cpuModel + platform)
 */

import { createHash } from "node:crypto";
import { hostname, arch, cpus, platform, homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { log } from "./logger.js";

const LEMON_API = "https://api.lemonsqueezy.com/v1/licenses";
const CACHE_PATH = join(homedir(), ".mnemo", "pro-license.json");
const REVALIDATE_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

let _cachedResult: boolean | null = null;
let _cachedPayload: LicensePayload | null = null;
let _warnedOnce = false;

export interface LicensePayload {
  valid: boolean;
  licensee: string;
  email: string;
  plan: "indie" | "team" | "enterprise";
  instance_id: string | null;
  product_id: number;
  variant_id: number;
  license_key_id: number;
}

interface CachedLicense {
  license_key: string;
  instance_id: string;
  payload: LicensePayload;
  validated_at: string; // ISO timestamp of last successful validation
  activated_at: string; // ISO timestamp of first activation
}

// ── Machine Fingerprint ──

export function getMachineFingerprint(): string {
  const cpu = cpus()[0]?.model || "unknown";
  const raw = `${hostname()}:${arch()}:${cpu}:${platform()}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

// ── LemonSqueezy API: Activate ──

async function activateLicense(licenseKey: string): Promise<CachedLicense | null> {
  try {
    const instanceName = getMachineFingerprint();
    const resp = await fetch(`${LEMON_API}/activate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({
        license_key: licenseKey,
        instance_name: instanceName,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await resp.json() as any;

    if (data.activated || data.valid) {
      const payload = extractPayload(data);
      const cached: CachedLicense = {
        license_key: licenseKey,
        instance_id: data.instance?.id || "",
        payload,
        validated_at: new Date().toISOString(),
        activated_at: new Date().toISOString(),
      };
      saveCache(cached);
      return cached;
    }

    // Already activated on this instance — treat as valid
    if (data.error && data.license_key?.status === "active") {
      return validateLicense(licenseKey);
    }

    log.warn(`License activation failed: ${data.error || "unknown error"}`);
    return null;
  } catch (err) {
    log.warn(`License activation request failed (offline?): ${err}`);
    return null;
  }
}

// ── LemonSqueezy API: Validate ──

async function validateLicense(licenseKey: string): Promise<CachedLicense | null> {
  try {
    const instanceId = loadCache()?.instance_id || "";
    const resp = await fetch(`${LEMON_API}/validate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({
        license_key: licenseKey,
        ...(instanceId ? { instance_id: instanceId } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });

    const data = await resp.json() as any;

    if (data.valid) {
      const payload = extractPayload(data);
      const existing = loadCache();
      const cached: CachedLicense = {
        license_key: licenseKey,
        instance_id: existing?.instance_id || data.instance?.id || "",
        payload,
        validated_at: new Date().toISOString(),
        activated_at: existing?.activated_at || new Date().toISOString(),
      };
      saveCache(cached);
      return cached;
    }

    // License invalid or expired — clear cache
    if (data.license_key?.status === "expired" || data.license_key?.status === "disabled") {
      clearCache();
      log.warn(
        `Mnemo Pro license ${data.license_key.status}. ` +
        `Renew at https://m-nemo.ai`
      );
    }

    return null;
  } catch (err) {
    // Network error — allow cached result to persist (grace period)
    log.warn(`License validation request failed (offline?): ${err}`);
    return null;
  }
}

// ── Extract payload from LemonSqueezy response ──

function extractPayload(data: any): LicensePayload {
  const meta = data.meta || {};
  const lk = data.license_key || {};
  const customer = meta.customer_name || lk.customer_name || "";
  const email = meta.customer_email || lk.customer_email || "";

  // Determine plan from variant or product name
  let plan: "indie" | "team" | "enterprise" = "indie";
  const productName = (meta.product_name || "").toLowerCase();
  const variantName = (meta.variant_name || "").toLowerCase();
  if (productName.includes("enterprise")) plan = "enterprise";
  else if (productName.includes("team")) plan = "team";

  return {
    valid: !!data.valid || !!data.activated,
    licensee: customer,
    email,
    plan,
    instance_id: data.instance?.id || null,
    product_id: meta.product_id || lk.product_id || 0,
    variant_id: meta.variant_id || lk.variant_id || 0,
    license_key_id: lk.id || 0,
  };
}

// ── Local Cache ──

function loadCache(): CachedLicense | null {
  try {
    return JSON.parse(readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return null;
  }
}

function saveCache(data: CachedLicense): void {
  try {
    mkdirSync(join(homedir(), ".mnemo"), { recursive: true });
    writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2));
  } catch { /* non-fatal */ }
}

function clearCache(): void {
  try {
    writeFileSync(CACHE_PATH, "{}");
  } catch { /* non-fatal */ }
}

function isCacheValid(cached: CachedLicense): boolean {
  if (!cached.payload?.valid) return false;
  if (!cached.validated_at) return false;

  const age = Date.now() - new Date(cached.validated_at).getTime();
  return age < REVALIDATE_INTERVAL_MS;
}

// ── Main entry point (sync) ──

export function isProLicensed(): boolean {
  if (_cachedResult !== null) return _cachedResult;

  const licenseKey = process.env.MNEMO_PRO_KEY?.trim();
  if (!licenseKey) {
    _cachedResult = false;
    return false;
  }

  // Check local cache first (fast, offline)
  const cached = loadCache();
  if (cached && cached.license_key === licenseKey && isCacheValid(cached)) {
    _cachedPayload = cached.payload;
    _cachedResult = true;
    return true;
  }

  // Cache expired or missing — trigger background revalidation
  // For sync callers, allow grace period: if cache exists but expired, still grant access
  // while revalidation happens in background
  if (cached && cached.license_key === licenseKey && cached.payload?.valid) {
    _cachedPayload = cached.payload;
    _cachedResult = true;

    // Background revalidation (fire and forget)
    validateLicense(licenseKey).then((result) => {
      if (!result) {
        // Revalidation failed (expired subscription, etc.)
        // Will take effect on next process start
        _cachedResult = null;
        _cachedPayload = null;
      }
    }).catch(() => {});

    return true;
  }

  // No valid cache — need online activation (async)
  // For sync callers, return false; ensureProLicense() handles async path
  _cachedResult = false;
  return false;
}

/**
 * Async version — waits for activation/validation to complete.
 * Use this during plugin initialization for first-time setup.
 */
export async function ensureProLicense(): Promise<boolean> {
  if (_cachedResult !== null) return _cachedResult;

  const licenseKey = process.env.MNEMO_PRO_KEY?.trim();
  if (!licenseKey) {
    _cachedResult = false;
    return false;
  }

  // Check local cache
  const cached = loadCache();
  if (cached && cached.license_key === licenseKey && isCacheValid(cached)) {
    _cachedPayload = cached.payload;
    _cachedResult = true;
    return true;
  }

  // Cache expired — try revalidation
  if (cached && cached.license_key === licenseKey && cached.instance_id) {
    const result = await validateLicense(licenseKey);
    if (result) {
      _cachedPayload = result.payload;
      _cachedResult = true;
      log.info(`Pro license validated for ${result.payload.licensee} (${result.payload.plan})`);
      return true;
    }

    // Validation failed but we have cache — check if it's within grace period (30 days)
    const GRACE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;
    const age = Date.now() - new Date(cached.validated_at).getTime();
    if (age < GRACE_PERIOD_MS && cached.payload?.valid) {
      _cachedPayload = cached.payload;
      _cachedResult = true;
      log.warn(`Pro license offline grace period active (last validated ${Math.floor(age / 86400000)}d ago)`);
      return true;
    }
  }

  // No cache or different key — try fresh activation
  const result = await activateLicense(licenseKey);
  if (result) {
    _cachedPayload = result.payload;
    _cachedResult = true;
    log.info(`Pro license activated for ${result.payload.licensee} (${result.payload.plan})`);
    return true;
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

  if (!_warnedOnce && process.env.MNEMO_DEBUG) {
    log.info(
      `Pro feature "${featureName}" requires a license — set MNEMO_PRO_KEY to enable. ` +
      `Core functionality is fully available. https://m-nemo.ai`,
    );
    _warnedOnce = true;
  }
  return false;
}

export function _resetLicenseCache(): void {
  _cachedResult = null;
  _cachedPayload = null;
  _warnedOnce = false;
}

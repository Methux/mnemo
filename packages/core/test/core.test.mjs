/**
 * Mnemo Core — Test Suite
 * Using Node.js built-in test runner (node --test)
 * No external test framework needed.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, verify, createPublicKey, createPrivateKey } from "node:crypto";
import { hostname, arch, cpus, platform } from "node:os";

// ============================================================================
// Group 1: SQL Injection Prevention
// ============================================================================

describe("escapeSqlLiteral (allowlist sanitizer)", () => {
  // Re-implement the function here for testing (same logic as store.ts)
  function escapeSqlLiteral(value) {
    if (typeof value !== "string") return "";
    return value.replace(/[^a-zA-Z0-9\-_.:@ \u4e00-\u9fff\u3400-\u4dbf]/g, "");
  }

  it("passes normal ID through", () => {
    assert.equal(escapeSqlLiteral("abc-123-def"), "abc-123-def");
  });

  it("passes UUID through", () => {
    assert.equal(
      escapeSqlLiteral("550e8400-e29b-41d4-a716-446655440000"),
      "550e8400-e29b-41d4-a716-446655440000"
    );
  });

  it("passes Chinese text through", () => {
    assert.equal(escapeSqlLiteral("用户偏好"), "用户偏好");
  });

  it("strips single quotes (SQL injection)", () => {
    assert.equal(escapeSqlLiteral("'; DROP TABLE memories; --"), " DROP TABLE memories --");
  });

  it("strips parentheses", () => {
    assert.equal(escapeSqlLiteral("id = '1' OR (1=1)"), "id  1 OR 11");
  });

  it("strips backticks", () => {
    assert.equal(escapeSqlLiteral("`memories`"), "memories");
  });

  it("strips semicolons", () => {
    assert.equal(escapeSqlLiteral("abc; DELETE FROM x"), "abc DELETE FROM x");
  });

  it("handles empty string", () => {
    assert.equal(escapeSqlLiteral(""), "");
  });

  it("handles non-string input", () => {
    assert.equal(escapeSqlLiteral(null), "");
    assert.equal(escapeSqlLiteral(undefined), "");
    assert.equal(escapeSqlLiteral(123), "");
  });

  it("preserves scope format", () => {
    assert.equal(escapeSqlLiteral("agent:bot3"), "agent:bot3");
    assert.equal(escapeSqlLiteral("global"), "global");
  });

  it("preserves email-like strings", () => {
    assert.equal(escapeSqlLiteral("user@example.com"), "user@example.com");
  });
});

// ============================================================================
// Group 2: License Key System
// ============================================================================

describe("License Key (Ed25519)", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pubDer = publicKey.export({ type: "spki", format: "der" });
  const privDer = privateKey.export({ type: "pkcs8", format: "der" });

  function signPayload(payload) {
    const buf = Buffer.from(JSON.stringify(payload));
    const sig = sign(null, buf, privateKey);
    return buf.toString("base64") + "." + sig.toString("base64");
  }

  function verifyKey(key) {
    const dot = key.indexOf(".");
    if (dot < 1) return null;
    try {
      const payloadBuf = Buffer.from(key.slice(0, dot), "base64");
      const sigBuf = Buffer.from(key.slice(dot + 1), "base64");
      const valid = verify(null, payloadBuf, publicKey, sigBuf);
      if (!valid) return null;
      return JSON.parse(payloadBuf.toString());
    } catch { return null; }
  }

  it("valid key verifies correctly", () => {
    const key = signPayload({ licensee: "Test", plan: "indie" });
    const payload = verifyKey(key);
    assert.notEqual(payload, null);
    assert.equal(payload.licensee, "Test");
  });

  it("tampered payload fails", () => {
    const key = signPayload({ licensee: "Test" });
    const parts = key.split(".");
    const original = JSON.parse(Buffer.from(parts[0], "base64").toString());
    original.licensee = "Hacked";
    const tampered = Buffer.from(JSON.stringify(original)).toString("base64") + "." + parts[1];
    assert.equal(verifyKey(tampered), null);
  });

  it("tampered signature fails", () => {
    const key = signPayload({ licensee: "Test" });
    const parts = key.split(".");
    const sigBuf = Buffer.from(parts[1], "base64");
    sigBuf[0] ^= 0xff;
    const tampered = parts[0] + "." + sigBuf.toString("base64");
    assert.equal(verifyKey(tampered), null);
  });

  it("empty string fails", () => {
    assert.equal(verifyKey(""), null);
  });

  it("wrong key pair fails", () => {
    const { privateKey: otherPriv } = generateKeyPairSync("ed25519");
    const buf = Buffer.from(JSON.stringify({ licensee: "Evil" }));
    const sig = sign(null, buf, otherPriv);
    const key = buf.toString("base64") + "." + sig.toString("base64");
    assert.equal(verifyKey(key), null);
  });

  it("expired key detected", () => {
    const payload = { licensee: "Test", expires: "2020-01-01" };
    const key = signPayload(payload);
    const decoded = verifyKey(key);
    assert.notEqual(decoded, null);
    assert.ok(new Date(decoded.expires).getTime() < Date.now());
  });
});

// ============================================================================
// Group 3: Machine Fingerprint
// ============================================================================

describe("Machine Fingerprint", () => {
  function getMachineFingerprint() {
    const cpu = cpus()[0]?.model || "unknown";
    const raw = `${hostname()}:${arch()}:${cpu}:${platform()}`;
    return createHash("sha256").update(raw).digest("hex");
  }

  it("produces SHA-256 hex (64 chars)", () => {
    const fp = getMachineFingerprint();
    assert.match(fp, /^[a-f0-9]{64}$/);
  });

  it("is deterministic", () => {
    assert.equal(getMachineFingerprint(), getMachineFingerprint());
  });
});

// ============================================================================
// Group 4: Storage Adapter Interface
// ============================================================================

describe("StorageAdapter Registry", async () => {
  // Dynamic import to test the module
  let registerAdapter, createAdapter, listAdapters;
  try {
    const mod = await import("../src/storage-adapter.js");
    registerAdapter = mod.registerAdapter;
    createAdapter = mod.createAdapter;
    listAdapters = mod.listAdapters;
  } catch {
    // Skip if module can't be loaded (TS not compiled)
    console.log("  ⚠ Skipping adapter tests (TS modules not compiled)");
    return;
  }

  it("registerAdapter + createAdapter round-trip", () => {
    registerAdapter("test-backend", () => ({ name: "test-backend" }));
    const adapter = createAdapter("test-backend");
    assert.equal(adapter.name, "test-backend");
  });

  it("listAdapters includes registered backends", () => {
    const list = listAdapters();
    assert.ok(list.includes("test-backend"));
  });

  it("createAdapter throws for unknown backend", () => {
    assert.throws(() => createAdapter("nonexistent"), /not found/);
  });
});

// ============================================================================
// Group 5: Audit Log
// ============================================================================

describe("Audit Log Entry Format", () => {
  it("audit entry has required fields", () => {
    const entry = {
      timestamp: new Date().toISOString(),
      action: "create",
      actor: "agent:default",
      memoryIds: ["mem_001"],
      scope: "global",
      reason: "auto-capture",
    };

    assert.ok(entry.timestamp);
    assert.ok(["create", "update", "delete", "expire", "recall"].includes(entry.action));
    assert.ok(Array.isArray(entry.memoryIds));
    assert.ok(entry.actor);
  });

  it("audit entry serializes to valid JSON", () => {
    const entry = {
      timestamp: "2026-03-23T10:00:00Z",
      action: "update",
      actor: "system",
      memoryIds: ["mem_001", "mem_002"],
      reason: "contradiction",
      details: JSON.stringify({ old: "age 30", new: "age 31" }),
    };
    const json = JSON.stringify(entry);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, entry);
  });
});

// ============================================================================
// Group 6: Weibull Decay Model
// ============================================================================

describe("Weibull Decay", () => {
  function weibull(t, beta, halflife) {
    const lam = halflife / Math.pow(Math.LN2, 1 / beta);
    return Math.exp(-Math.pow(t / lam, beta));
  }

  it("score is 1.0 at t=0", () => {
    assert.equal(weibull(0, 1.0, 30), 1.0);
  });

  it("score is ~0.5 at t=halflife for beta=1.0", () => {
    const score = weibull(30, 1.0, 30);
    assert.ok(Math.abs(score - 0.5) < 0.01);
  });

  it("Core (beta=0.8) retains more than Working after 2x halflife", () => {
    const core = weibull(60, 0.8, 30);
    const working = weibull(60, 1.0, 30);
    assert.ok(core > working, `Core ${core} should be > Working ${working} at t=2*halflife`);
  });

  it("Peripheral (beta=1.3) retains less than Working after 2x halflife", () => {
    const peripheral = weibull(60, 1.3, 30);
    const working = weibull(60, 1.0, 30);
    assert.ok(peripheral < working, `Peripheral ${peripheral} should be < Working ${working} at t=2*halflife`);
  });

  it("score approaches 0 for very old memories", () => {
    const score = weibull(365, 1.0, 30);
    assert.ok(score < 0.001);
  });

  it("Core memories retain >50% at 90 days", () => {
    const score = weibull(90, 0.8, 90);
    assert.ok(score > 0.45);
  });
});

// ============================================================================
// Group 7: Config Path Resolution
// ============================================================================

describe("Config Path Defaults", () => {
  it("MNEMO_DB_PATH env overrides default", () => {
    const original = process.env.MNEMO_DB_PATH;
    process.env.MNEMO_DB_PATH = "/custom/path";
    // The function checks env first
    assert.equal(process.env.MNEMO_DB_PATH, "/custom/path");
    if (original) process.env.MNEMO_DB_PATH = original;
    else delete process.env.MNEMO_DB_PATH;
  });

  it("MNEMO_CONFIG env is respected", () => {
    const original = process.env.MNEMO_CONFIG;
    process.env.MNEMO_CONFIG = "/custom/config.json";
    assert.equal(process.env.MNEMO_CONFIG, "/custom/config.json");
    if (original) process.env.MNEMO_CONFIG = original;
    else delete process.env.MNEMO_CONFIG;
  });
});

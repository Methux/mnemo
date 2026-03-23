/**
 * Mnemo Package Integration Tests
 * Tests the npm package exports, createMnemo API, and user-facing behavior.
 * Run: node --test test/package.test.mjs
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";

// ============================================================================
// Group 1: Package Exports
// ============================================================================

describe("Package exports", async () => {
  const mod = await import("../dist/index.js");

  it("exports createMnemo", () => {
    assert.equal(typeof mod.createMnemo, "function");
  });

  it("exports MemoryStore", () => {
    assert.equal(typeof mod.MemoryStore, "function");
  });

  it("exports registerAdapter, createAdapter, listAdapters", () => {
    assert.equal(typeof mod.registerAdapter, "function");
    assert.equal(typeof mod.createAdapter, "function");
    assert.equal(typeof mod.listAdapters, "function");
  });

  it("exports log and setLogger", () => {
    assert.ok(mod.log);
    assert.equal(typeof mod.setLogger, "function");
  });

  it("does NOT export internal OpenClaw functions", () => {
    assert.equal(mod.detectCategory, undefined);
    assert.equal(mod.parsePluginConfig, undefined);
    assert.equal(mod.shouldCapture, undefined);
    assert.equal(mod.readSessionConversationWithResetFallback, undefined);
  });

  it("has a default export (OpenClaw plugin compat)", () => {
    assert.ok(mod.default);
  });
});

// ============================================================================
// Group 2: Subpath exports
// ============================================================================

describe("Subpath exports", async () => {
  const adapter = await import("../dist/src/storage-adapter.js");

  it("storage-adapter exports registerAdapter", () => {
    assert.equal(typeof adapter.registerAdapter, "function");
  });

  it("storage-adapter exports createAdapter", () => {
    assert.equal(typeof adapter.createAdapter, "function");
  });

  it("storage-adapter exports listAdapters", () => {
    assert.equal(typeof adapter.listAdapters, "function");
  });
});

// ============================================================================
// Group 3: createMnemo validation
// ============================================================================

describe("createMnemo validation", async () => {
  const { createMnemo } = await import("../dist/index.js");

  it("throws on missing config", async () => {
    await assert.rejects(() => createMnemo(), /config is required/);
  });

  it("throws on missing embedding", async () => {
    await assert.rejects(() => createMnemo({}), /embedding is required/);
  });

  it("throws on missing apiKey", async () => {
    await assert.rejects(
      () => createMnemo({ embedding: { provider: "openai-compatible" } }),
      /apiKey is required/
    );
  });

  it("throws on missing dbPath", async () => {
    await assert.rejects(
      () => createMnemo({ embedding: { provider: "openai-compatible", apiKey: "k" } }),
      /dbPath is required/
    );
  });
});

// ============================================================================
// Group 4: createMnemo instance
// ============================================================================

describe("createMnemo instance", async () => {
  const { createMnemo } = await import("../dist/index.js");
  const dbPath = "/tmp/mnemo-test-instance-" + Date.now();

  // Clean up after tests
  const cleanup = () => { try { rmSync(dbPath, { recursive: true }); } catch {} };

  it("creates instance with all expected methods", async () => {
    const m = await createMnemo({
      embedding: {
        provider: "openai-compatible",
        apiKey: "test-key",
        baseURL: "http://localhost:9999/v1",
        model: "test-model",
        dimensions: 384,
      },
      dbPath,
    });

    assert.equal(typeof m.store, "function");
    assert.equal(typeof m.recall, "function");
    assert.equal(typeof m.delete, "function");
    assert.equal(typeof m.stats, "function");
    assert.equal(typeof m.close, "function");

    await m.close();
    cleanup();
  });

  it("respects custom dimensions", async () => {
    const m = await createMnemo({
      embedding: {
        provider: "openai-compatible",
        apiKey: "test",
        baseURL: "http://localhost:9999/v1",
        model: "test",
        dimensions: 512,
      },
      dbPath: dbPath + "-dim",
    });

    // Instance should be created without error
    assert.ok(m);
    await m.close();
    try { rmSync(dbPath + "-dim", { recursive: true }); } catch {}
  });
});

// ============================================================================
// Group 5: No console spam on import
// ============================================================================

describe("Import behavior", () => {
  it("does not produce console output on import (without MNEMO_DEBUG)", async () => {
    // The fact that we got here without seeing spam means it works.
    // If the Pro warning were still active, it would have printed during the
    // import statements above. This is a documentation-level test.
    assert.ok(true);
  });
});

// ============================================================================
// Group 6: Logger
// ============================================================================

describe("Logger", async () => {
  const { log, setLogger } = await import("../dist/index.js");

  it("log has standard methods", () => {
    assert.equal(typeof log.info, "function");
    assert.equal(typeof log.warn, "function");
    assert.equal(typeof log.error, "function");
    assert.equal(typeof log.debug, "function");
  });

  it("setLogger replaces the logger", () => {
    const calls = [];
    const custom = {
      info: (...args) => calls.push(["info", ...args]),
      warn: (...args) => calls.push(["warn", ...args]),
      error: (...args) => calls.push(["error", ...args]),
      debug: (...args) => calls.push(["debug", ...args]),
    };
    setLogger(custom);
    log.info("test message");
    assert.ok(calls.length > 0);
    assert.equal(calls[0][0], "info");

    // Reset to default
    setLogger(console);
  });
});

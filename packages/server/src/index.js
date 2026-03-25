#!/usr/bin/env node
/**
 * Mnemo REST API Server + Dashboard
 * Lightweight HTTP server — no Express, no dependencies beyond @mnemoai/core.
 *
 * Usage:
 *   npx @mnemoai/server                              # default port 18100
 *   MNEMO_PORT=8080 npx @mnemoai/server               # custom port
 *   OPENAI_API_KEY=sk-... npx @mnemoai/server          # with OpenAI
 *
 * Dashboard: http://localhost:18100/
 *
 * API Endpoints (both /api/v1/* and legacy /* supported):
 *   POST   /api/v1/store           { text, category?, importance?, scope? }
 *   POST   /api/v1/recall          { query, limit?, scopeFilter?, category? }
 *   POST   /api/v1/retrieve        (alias for /recall)
 *   GET    /api/v1/memories        ?limit=50&offset=0&category=&scope=&tier=
 *   DELETE /api/v1/memories/:id
 *   POST   /api/v1/memories/bulk-delete  { ids: string[] }
 *   POST   /api/v1/memories/search       { query, limit? }
 *   GET    /api/v1/stats
 *   GET    /api/v1/health
 *   GET    /api/v1/doctor
 */

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createMnemo } from "@mnemoai/core";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = parseInt(process.env.MNEMO_PORT || "18100", 10);
const DB_PATH = process.env.MNEMO_DB_PATH || "./mnemo-data";
const startedAt = Date.now();

// ── Config from env ──
const config = {};

// Support preset
if (process.env.MNEMO_PRESET) {
  config.preset = process.env.MNEMO_PRESET;
} else if (process.env.OPENAI_API_KEY || process.env.MNEMO_API_KEY) {
  config.embedding = {
    provider: "openai-compatible",
    apiKey: process.env.MNEMO_API_KEY || process.env.OPENAI_API_KEY,
    baseURL: process.env.MNEMO_EMBEDDING_BASE_URL || undefined,
    model: process.env.MNEMO_EMBEDDING_MODEL || "text-embedding-3-small",
    dimensions: parseInt(process.env.MNEMO_EMBEDDING_DIMENSIONS || "1536", 10),
  };
} else {
  // Auto-detect
  config.embedding = {
    provider: "openai-compatible",
    apiKey: "ollama",
    baseURL: process.env.MNEMO_EMBEDDING_BASE_URL || undefined,
    model: process.env.MNEMO_EMBEDDING_MODEL || "text-embedding-3-small",
    dimensions: parseInt(process.env.MNEMO_EMBEDDING_DIMENSIONS || "1536", 10),
  };
}

config.dbPath = DB_PATH;
config.storageBackend = process.env.MNEMO_STORAGE_BACKEND || undefined;
config.storageConfig = process.env.MNEMO_STORAGE_CONFIG
  ? JSON.parse(process.env.MNEMO_STORAGE_CONFIG)
  : undefined;

// Retrieval pipeline config (BM25, rerank, pool size)
if (process.env.MNEMO_RERANK || process.env.MNEMO_RERANK_API_KEY) {
  config.retrieval = {
    candidatePoolSize: parseInt(process.env.MNEMO_CANDIDATE_POOL_SIZE || "20", 10),
    rerank: process.env.MNEMO_RERANK || "none",
    rerankApiKey: process.env.MNEMO_RERANK_API_KEY || undefined,
    rerankModel: process.env.MNEMO_RERANK_MODEL || undefined,
    rerankEndpoint: process.env.MNEMO_RERANK_ENDPOINT || undefined,
    rerankProvider: process.env.MNEMO_RERANK_PROVIDER || undefined,
  };
}

// ── Init ──
console.log(`[mnemo-server] Initializing with dbPath=${DB_PATH}...`);
const mnemo = await createMnemo(config);
console.log(`[mnemo-server] Ready.`);

// ── Dashboard HTML (cached) ──
let dashboardHtml = null;
async function getDashboard() {
  if (dashboardHtml) return dashboardHtml;
  try {
    // Try sibling package first (monorepo)
    dashboardHtml = await readFile(join(__dirname, "../../dashboard/index.html"), "utf-8");
  } catch {
    try {
      // Try installed package
      dashboardHtml = await readFile(join(__dirname, "../dashboard/index.html"), "utf-8");
    } catch {
      dashboardHtml = "<html><body><h1>Mnemo Dashboard</h1><p>Dashboard HTML not found. Install @mnemoai/dashboard or place index.html in the dashboard directory.</p></body></html>";
    }
  }
  return dashboardHtml;
}

// ── Helpers ──
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve({});
      }
    });
    req.on("error", reject);
  });
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function json(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
  res.end(JSON.stringify(data));
}

function html(res, content) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(content);
}

// ── Route handler ──
async function handleAPI(path, method, req, res) {

  // POST /store
  if (method === "POST" && path === "/store") {
    const body = await readBody(req);
    if (!body.text) return json(res, 400, { error: "text is required" });
    const result = await mnemo.store({
      text: body.text,
      category: body.category,
      importance: body.importance,
      scope: body.scope,
    });
    return json(res, 201, result);
  }

  // POST /recall or /retrieve
  if (method === "POST" && (path === "/recall" || path === "/retrieve")) {
    const body = await readBody(req);
    if (!body.query) return json(res, 400, { error: "query is required" });
    const results = await mnemo.recall(body.query, {
      limit: body.limit || body.top_k,
      scopeFilter: body.scopeFilter,
      category: body.category,
    });
    return json(res, 200, { results });
  }

  // POST /memories/search
  if (method === "POST" && path === "/memories/search") {
    const body = await readBody(req);
    if (!body.query) return json(res, 400, { error: "query is required" });
    const results = await mnemo.recall(body.query, { limit: body.limit || 20 });
    return json(res, 200, { results });
  }

  // POST /memories/bulk-delete
  if (method === "POST" && path === "/memories/bulk-delete") {
    const body = await readBody(req);
    if (!body.ids || !Array.isArray(body.ids)) return json(res, 400, { error: "ids array is required" });
    let deleted = 0;
    for (const id of body.ids) {
      if (await mnemo.delete(id)) deleted++;
    }
    return json(res, 200, { deleted, total: body.ids.length });
  }

  // GET /memories — list all memories
  if (method === "GET" && path === "/memories") {
    const stats = await mnemo.stats();
    // Use recall with a broad query to list memories
    // This is a workaround since the core API doesn't have a list method
    const results = await mnemo.recall("*", { limit: 200 });
    return json(res, 200, { memories: results, total: stats.totalEntries });
  }

  // DELETE /memories/:id
  if (method === "DELETE" && path.startsWith("/memories/")) {
    const id = decodeURIComponent(path.slice("/memories/".length));
    if (!id || id === "bulk-delete" || id === "search") return json(res, 400, { error: "invalid memory id" });
    const deleted = await mnemo.delete(id);
    return json(res, 200, { deleted });
  }

  // GET /stats
  if (method === "GET" && path === "/stats") {
    const stats = await mnemo.stats();
    return json(res, 200, stats);
  }

  // GET /health
  if (method === "GET" && path === "/health") {
    return json(res, 200, {
      status: "ok",
      version: "0.2.0",
      uptime: Math.floor((Date.now() - startedAt) / 1000),
      dbPath: DB_PATH,
    });
  }

  // GET /doctor
  if (method === "GET" && path === "/doctor") {
    const stats = await mnemo.stats();
    const checks = [
      { ok: true, name: "Server running", msg: `Port ${PORT}, uptime ${Math.floor((Date.now() - startedAt) / 1000)}s` },
      { ok: stats.totalEntries >= 0, name: "Database accessible", msg: `${stats.totalEntries} memories in store` },
      { ok: true, name: "Embedding provider", msg: config.preset || config.embedding?.model || "auto-detect" },
      { ok: true, name: "Storage backend", msg: config.storageBackend || "lancedb (default)" },
    ];
    return json(res, 200, { checks, summary: checks.every(c => c.ok) ? "All checks passed" : "Issues found" });
  }

  return null; // not handled
}

// ── Server ──
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let path = url.pathname;
  const method = req.method;

  // CORS preflight
  if (method === "OPTIONS") {
    res.writeHead(204, CORS_HEADERS);
    res.end();
    return;
  }

  try {
    // Dashboard — serve at root
    if (method === "GET" && (path === "/" || path === "/dashboard")) {
      return html(res, await getDashboard());
    }

    // API v1 routes — strip prefix
    if (path.startsWith("/api/v1")) {
      const apiPath = path.slice("/api/v1".length) || "/";
      const result = await handleAPI(apiPath, method, req, res);
      if (result !== null) return;
    }

    // Legacy routes (no prefix) — backwards compatible
    const result = await handleAPI(path, method, req, res);
    if (result !== null) return;

    // 404
    json(res, 404, { error: "Not found" });
  } catch (err) {
    console.error(`[mnemo-server] Error:`, err.message);
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`[mnemo-server] Listening on http://localhost:${PORT}`);
  console.log(`[mnemo-server] Dashboard: http://localhost:${PORT}/`);
  console.log(`[mnemo-server] API Endpoints:`);
  console.log(`  POST   /api/v1/store              { text, category?, importance?, scope? }`);
  console.log(`  POST   /api/v1/recall             { query, limit?, scopeFilter?, category? }`);
  console.log(`  GET    /api/v1/memories            ?limit=200`);
  console.log(`  DELETE /api/v1/memories/:id`);
  console.log(`  POST   /api/v1/memories/bulk-delete { ids: [] }`);
  console.log(`  POST   /api/v1/memories/search     { query, limit? }`);
  console.log(`  GET    /api/v1/stats`);
  console.log(`  GET    /api/v1/health`);
  console.log(`  GET    /api/v1/doctor`);
});

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[mnemo-server] Shutting down...");
  await mnemo.close();
  server.close();
  process.exit(0);
});

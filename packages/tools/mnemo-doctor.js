#!/usr/bin/env node
/**
 * mnemo-doctor.js — Mnemo 记忆架构一键诊断
 * Usage: node ~/.mnemo/workspace/mnemo-doctor.js
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execSync } = require("node:child_process");

const HOME = os.homedir();
const MNEMO_HOME = path.join(HOME, ".mnemo");
const GATEWAY_PORT = 18789;
const GATEWAY_TOKEN = process.env.MNEMO_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || "";
const GRAPHITI_PORT = 18799;

// ─── Styling ────────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  cyan: "\x1b[36m",
  gray: "\x1b[90m",
};

const OK = `${C.green}✅${C.reset}`;
const WARN = `${C.yellow}⚠️${C.reset}`;
const FAIL = `${C.red}❌${C.reset}`;
const INFO = `${C.blue}ℹ${C.reset}`;

let warnings = 0;
let errors = 0;

function ok(label, detail) { console.log(`  ${OK}  ${label.padEnd(22)} ${C.dim}${detail}${C.reset}`); }
function warn(label, detail) { warnings++; console.log(`  ${WARN}  ${label.padEnd(22)} ${C.yellow}${detail}${C.reset}`); }
function fail(label, detail) { errors++; console.log(`  ${FAIL}  ${label.padEnd(22)} ${C.red}${detail}${C.reset}`); }
function info(label, detail) { console.log(`  ${INFO}  ${label.padEnd(22)} ${C.dim}${detail}${C.reset}`); }
function section(title) { console.log(`\n${C.bold}${C.cyan}${title}${C.reset}`); console.log(C.dim + "─".repeat(50) + C.reset); }

// ─── Helpers ────────────────────────────────────────────────────────────────

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function dirExists(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function ago(ms) {
  if (!ms || ms <= 0) return "never";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function safeExec(cmd) {
  try { return execSync(cmd, { timeout: 5000, encoding: "utf8" }).trim(); } catch { return ""; }
}

function httpGet(port, path, timeout = 3000) {
  return new Promise((resolve) => {
    const req = http.request({ hostname: "127.0.0.1", port, path, method: "GET", timeout }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.end();
  });
}

function gatewayInvoke(tool, args) {
  return new Promise((resolve) => {
    const body = JSON.stringify({ tool, args, sessionKey: process.env.MNEMO_SESSION_KEY || "agent:default:local:doctor" });
    const req = http.request({
      hostname: "127.0.0.1", port: GATEWAY_PORT, path: "/tools/invoke", method: "POST", timeout: 10000,
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${GATEWAY_TOKEN}`, "Content-Length": Buffer.byteLength(body) },
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.write(body);
    req.end();
  });
}

// ─── Checks ─────────────────────────────────────────────────────────────────

async function checkGateway() {
  section("Gateway");

  // Process
  const pid = safeExec("lsof -i :18789 -t 2>/dev/null").split("\n")[0];
  if (pid) {
    ok("Gateway process", `PID ${pid}, port 18789`);
  } else {
    fail("Gateway process", "not running on port 18789");
    return false;
  }

  // launchd
  const launchd = safeExec("launchctl list ai.mnemo.gateway 2>/dev/null");
  if (launchd.includes("PID")) {
    ok("launchd service", "loaded, KeepAlive active");
  } else {
    warn("launchd service", "not loaded — gateway won't auto-restart");
  }

  return true;
}

async function checkConfig() {
  section("Config Validation");

  const cfg = readJson(path.join(MNEMO_HOME, "mnemo.json"));
  if (!cfg) { fail("mnemo.json", "cannot parse"); return; }

  const pluginCfg = cfg?.plugins?.entries?.["mnemo"]?.config ?? cfg?.plugins?.entries?.["memory-lancedb-pro"]?.config;
  if (!pluginCfg) { fail("plugin config", "mnemo plugin config not found"); return; }

  // Check known pitfalls
  if ("scoping" in pluginCfg) {
    fail("config key", '"scoping" should be "scopes" — will cause validation failure');
  } else if (pluginCfg.scopes) {
    ok("scopes", `${Object.keys(pluginCfg.scopes.agentAccess || {}).length} agents configured`);
  }

  if ("_syncTest" in cfg) {
    warn("_syncTest", "temp key present — should be cleaned");
  }

  // Check required features
  const checks = [
    ["autoCapture", pluginCfg.autoCapture === true],
    ["smartExtraction", pluginCfg.smartExtraction !== false],
    ["captureAssistant", pluginCfg.captureAssistant === true],
    ["autoRecall", pluginCfg.autoRecall === true],
    ["enableMgmtTools", pluginCfg.enableManagementTools === true],
    ["sessionStrategy", pluginCfg.sessionStrategy === "memoryReflection"],
  ];

  for (const [name, ok_] of checks) {
    if (ok_) ok(name, "enabled");
    else warn(name, "not enabled");
  }

  // LLM config
  if (pluginCfg.llm?.model) {
    ok("LLM model", pluginCfg.llm.model);
  } else {
    warn("LLM model", "not configured — smartExtraction will use default");
  }

  // Retrieval config
  const ret = pluginCfg.retrieval || {};
  if (ret.rerank === "cross-encoder" && ret.rerankApiKey) {
    ok("Rerank", `${ret.rerankProvider}/${ret.rerankModel}, key present`);
  } else {
    warn("Rerank", "not configured or missing API key");
  }

  // Decay
  if (pluginCfg.decay) {
    ok("Decay engine", `halfLife=${pluginCfg.decay.recencyHalfLifeDays}d`);
  } else {
    warn("Decay", "not configured");
  }

  // Tier
  if (pluginCfg.tier) {
    ok("Tier config", `core imp≥${pluginCfg.tier.coreImportanceThreshold}`);
  } else {
    warn("Tier", "not configured");
  }

  // mdMirror
  if (pluginCfg.mdMirror?.enabled) {
    ok("mdMirror", `dir: ${pluginCfg.mdMirror.dir || "(default)"}`);
  } else {
    warn("mdMirror", "not enabled");
  }
}

async function checkLanceDB() {
  section("LanceDB");

  const dbPath = path.join(MNEMO_HOME, "data", "lancedb");
  if (dirExists(dbPath)) {
    ok("Database", dbPath);
  } else {
    fail("Database", `not found at ${dbPath}`);
    return;
  }

  // Check via memory_stats tool
  const stats = await gatewayInvoke("memory_stats", {});
  if (stats?.result?.details) {
    const d = stats.result.details;
    ok("Total entries", `${d.totalEntries ?? d.total ?? "?"}`);
    if (d.scopeBreakdown) {
      info("Scopes", Object.entries(d.scopeBreakdown).map(([k, v]) => `${k}:${v}`).join(" · "));
    }
  } else if (stats?.result?.content?.[0]?.text) {
    const text = stats.result.content[0].text;
    const match = text.match(/(\d[\d,]*)\s*(?:total|entries|memories)/i);
    if (match) ok("Total entries", match[1]);
    else info("Stats", text.slice(0, 120));
  } else {
    warn("memory_stats", "could not retrieve — gateway may not support this tool");
  }

  // Backup check
  const backupDir = path.join(MNEMO_HOME, "data", "backups");
  if (dirExists(backupDir)) {
    const files = fs.readdirSync(backupDir).filter(f => f.endsWith(".jsonl")).sort().reverse();
    if (files.length > 0) {
      const latest = files[0];
      const stat = fs.statSync(path.join(backupDir, latest));
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 48 * 3600 * 1000) {
        ok("Backup", `${latest} (${ago(ageMs)})`);
      } else {
        warn("Backup", `${latest} is ${ago(ageMs)} — stale`);
      }
    }
  }

  // MD Mirror check
  const mirrorDir = path.join(MNEMO_HOME, "data", "lancedb-mirror");
  if (dirExists(mirrorDir)) {
    const files = fs.readdirSync(mirrorDir).filter(f => f.endsWith(".md")).sort().reverse();
    if (files.length > 0) {
      const latest = files[0];
      const stat = fs.statSync(path.join(mirrorDir, latest));
      const ageMs = Date.now() - stat.mtimeMs;
      if (ageMs < 48 * 3600 * 1000) {
        ok("MD Mirror", `${latest} (${ago(ageMs)})`);
      } else {
        warn("MD Mirror", `latest: ${latest} (${ago(ageMs)}) — stale`);
      }
    } else {
      warn("MD Mirror", "no files yet");
    }
  }
}

async function checkGraphiti() {
  section("Graphiti / Neo4j");

  const resp = await httpGet(GRAPHITI_PORT, "/health");
  if (resp && resp.status === 200) {
    try {
      const data = JSON.parse(resp.body);
      ok("Graphiti service", `${data.neo4j_uri || "connected"} — ${data.message || "ok"}`);
    } catch {
      ok("Graphiti service", "reachable");
    }
  } else {
    fail("Graphiti service", `not reachable on port ${GRAPHITI_PORT}`);
  }

  // WAL check (dedup by ts — later entries override earlier ones)
  const walPath = path.join(MNEMO_HOME, "data", "graphiti-wal.jsonl");
  if (fileExists(walPath)) {
    try {
      const lines = fs.readFileSync(walPath, "utf8").trim().split("\n");
      const total = lines.length;
      const statusMap = new Map();
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          const ts = entry.ts;
          const existing = statusMap.get(ts);
          if (!existing || entry.status !== "pending") {
            statusMap.set(ts, entry);
          }
        } catch {}
      }
      let pending = 0, committed = 0, failed = 0;
      for (const e of statusMap.values()) {
        if (e.status === "pending") pending++;
        else if (e.status === "committed") committed++;
        else if (e.status === "failed") failed++;
      }
      if (pending > 10) {
        warn("WAL", `${statusMap.size} unique, ${pending} pending (backlog)`);
      } else if (pending > 0) {
        info("WAL", `${statusMap.size} unique, ${pending} pending, ${committed} committed, ${failed} failed`);
      } else {
        ok("WAL", `${statusMap.size} unique, ${committed} committed, ${failed} failed, 0 pending`);
      }
    } catch {
      info("WAL", "exists but could not parse");
    }
  } else {
    info("WAL", "no WAL file — Graphiti writes may not have WAL enabled");
  }

  // GRAPHITI_ENABLED check
  const plist = safeExec("grep -A1 GRAPHITI_ENABLED ~/Library/LaunchAgents/ai.mnemo.gateway.plist 2>/dev/null");
  if (plist.includes("true")) {
    ok("GRAPHITI_ENABLED", "true (in launchd)");
  } else {
    warn("GRAPHITI_ENABLED", "not set to true in gateway env");
  }
}

async function checkWriteChannels() {
  section("Write Channels");

  // Hook memory-extractor
  const hookPath = path.join(MNEMO_HOME, "workspace", "hooks", "memory-extractor", "handler.ts");
  if (fileExists(hookPath)) {
    ok("Hook extractor", "handler.ts present");
  } else {
    fail("Hook extractor", "handler.ts missing");
  }

  // SmartExtractor — check recent log
  const logLines = safeExec('grep -o \'"1":"[^"]*"\' /tmp/mnemo/mnemo-$(date -u +%Y-%m-%d).log 2>/dev/null | grep "smart extraction enabled" | tail -1');
  if (logLines.includes("smart extraction enabled")) {
    const model = logLines.match(/LLM model: ([^,]+)/)?.[1] || "?";
    ok("SmartExtractor", `enabled, model: ${model}`);
  } else {
    warn("SmartExtractor", "no recent init log found");
  }

  // memory-watcher
  const watcherPid = safeExec("cat ~/.mnemo/memory-watcher/watcher.pid 2>/dev/null");
  if (watcherPid) {
    const alive = safeExec(`ps -p ${watcherPid} -o pid= 2>/dev/null`);
    if (alive) {
      ok("memory-watcher", `PID ${watcherPid}, running`);
    } else {
      warn("memory-watcher", `PID ${watcherPid} in pidfile but process dead`);
    }
  } else {
    warn("memory-watcher", "no pidfile found");
  }

  // L1 cron jobs
  const cronOutput = safeExec("mnemo cron list 2>/dev/null | grep -i '记忆提炼\\|L1' || true");
  const cronLines = cronOutput.split("\n").filter(Boolean);
  for (const line of cronLines) {
    const name = line.match(/[^\s]+\s+(\S.*?)\s{2,}/)?.[1] || line.slice(0, 40);
    if (line.includes("error")) {
      warn("Cron: " + name.slice(0, 18), "status: error");
    } else if (line.includes("ok")) {
      ok("Cron: " + name.slice(0, 18), "status: ok");
    } else {
      info("Cron: " + name.slice(0, 18), line.trim().slice(0, 60));
    }
  }

  // Check recent extraction activity
  const recentExtract = safeExec(
    'grep -o \'"1":"[^"]*"\' /tmp/mnemo/mnemo-$(date -u +%Y-%m-%d).log 2>/dev/null | grep -c "auto-captured\\|smart-extracted\\|smart-extractor.*created" 2>/dev/null || echo 0'
  );
  info("Extractions today", `${recentExtract} successful captures`);
}

async function checkRetrieval() {
  section("Retrieval Pipeline");

  // Rerank
  const rerankLog = safeExec('grep "rerank-debug" ~/.mnemo/logs/gateway.err.log 2>/dev/null | tail -1');
  if (rerankLog.includes("hasKey=true")) {
    const provider = rerankLog.match(/provider=(\w+)/)?.[1] || "?";
    const model = rerankLog.match(/model=([\w-]+)/)?.[1] || "?";
    ok("Rerank", `${provider}/${model}, active`);
  } else if (rerankLog.includes("hasKey=false")) {
    fail("Rerank", "hasKey=false — API key not loaded");
  } else {
    warn("Rerank", "no recent rerank activity");
  }

  // Rerank failures — check since last gateway start (current session only)
  const lastStart = safeExec('grep "listening on ws://" ~/.mnemo/logs/gateway.err.log 2>/dev/null | tail -1 | grep -o "2026[^Z]*"');
  const rerankFailCmd = lastStart
    ? `grep "Reranking failed" ~/.mnemo/logs/gateway.err.log 2>/dev/null | grep -c "$(echo '${lastStart}' | cut -c1-13)" 2>/dev/null || echo 0`
    : 'grep -c "Reranking failed" ~/.mnemo/logs/gateway.err.log 2>/dev/null || echo 0';
  const rerankTotalCmd = lastStart
    ? `grep "rerank-debug" ~/.mnemo/logs/gateway.err.log 2>/dev/null | grep -c "$(echo '${lastStart}' | cut -c1-13)" 2>/dev/null || echo 0`
    : 'grep -c "rerank-debug" ~/.mnemo/logs/gateway.err.log 2>/dev/null || echo 0';
  // Simpler: just count failures since last gateway boot via PID
  const gwPid = safeExec("lsof -i :18789 -t 2>/dev/null").split("\n")[0];
  const gwStartTime = gwPid ? safeExec(`ps -p ${gwPid} -o lstart= 2>/dev/null`).trim() : "";
  const nFails = parseInt(safeExec('grep -c "Reranking failed" ~/.mnemo/logs/gateway.err.log 2>/dev/null || echo 0')) || 0;
  const nTotal = parseInt(safeExec('grep -c "rerank-debug" ~/.mnemo/logs/gateway.err.log 2>/dev/null || echo 0')) || 0;
  // Use a simpler heuristic: if last 20 rerank calls have 0 failures, it's healthy
  const recent20 = safeExec('tail -100 ~/.mnemo/logs/gateway.err.log 2>/dev/null | grep -c "Reranking failed" || echo 0');
  const recent20Total = safeExec('tail -100 ~/.mnemo/logs/gateway.err.log 2>/dev/null | grep -c "rerank-debug" || echo 0');
  const rFails = parseInt(recent20) || 0;
  const rTotal = parseInt(recent20Total) || 0;
  if (rTotal > 0) {
    if (rFails === 0) {
      ok("Rerank (recent)", `0/${rTotal} failures in recent calls`);
    } else {
      const rate = (rFails / rTotal * 100).toFixed(1);
      if (parseFloat(rate) > 10) {
        warn("Rerank (recent)", `${rFails}/${rTotal} failures (${rate}%)`);
      } else {
        ok("Rerank (recent)", `${rFails}/${rTotal} failures (${rate}%)`);
      }
    }
  } else {
    info("Rerank", "no recent rerank activity");
  }

  // Resonance gate
  const gatedOut = safeExec(
    'grep -o \'"1":"[^"]*"\' /tmp/mnemo/mnemo-$(date -u +%Y-%m-%d).log 2>/dev/null | grep -c "gated-out" 2>/dev/null || echo 0'
  );
  const injected = safeExec(
    'grep -o \'"1":"[^"]*"\' /tmp/mnemo/mnemo-$(date -u +%Y-%m-%d).log 2>/dev/null | grep -c "injecting" 2>/dev/null || echo 0'
  );
  info("Resonance gate", `${injected} injections, ${gatedOut} gated-out`);

  // Quick recall test
  const testResult = await gatewayInvoke("memory_recall", { query: "health check test", limit: 1 });
  if (testResult?.result) {
    ok("Recall pipeline", "end-to-end OK");
  } else {
    warn("Recall pipeline", "test recall returned no result");
  }
}

async function checkAutoSync() {
  section("Auto-Sync");

  const syncScript = path.join(HOME, "mnemo-config", "scripts", "auto-sync.sh");
  const mergeScript = path.join(HOME, "mnemo-config", "scripts", "json-deep-merge.js");

  if (fileExists(syncScript)) {
    const content = fs.readFileSync(syncScript, "utf8");
    if (content.includes("json-deep-merge")) {
      ok("auto-sync.sh", "using JSON deep-merge (safe)");
    } else if (content.includes("cp ")) {
      fail("auto-sync.sh", 'still using "cp" overwrite — config will be lost!');
    }
  } else {
    warn("auto-sync.sh", "not found");
  }

  if (fileExists(mergeScript)) {
    ok("json-deep-merge.js", "present");
  } else {
    warn("json-deep-merge.js", "missing — auto-sync may overwrite config");
  }

  // Check crontab
  const crontab = safeExec("crontab -l 2>/dev/null | grep auto-sync || true");
  if (crontab) {
    ok("crontab", "auto-sync registered");
  } else {
    warn("crontab", "auto-sync not in crontab");
  }

  // Last sync
  const logPath = path.join(HOME, "mnemo-config", "auto-apply.log");
  if (fileExists(logPath)) {
    const last = safeExec(`tail -1 "${logPath}"`);
    if (last.includes("auto-sync complete")) {
      const ts = last.match(/\[([\d-]+ [\d:]+)\]/)?.[1];
      ok("Last sync", ts || last.slice(0, 60));
    } else {
      info("Last log", last.slice(0, 80));
    }
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n${C.bold}🧠 Mnemo Health Check${C.reset}`);
  console.log(`${C.dim}mnemo v1.1.0-beta.8 · ${new Date().toISOString().slice(0, 19)}${C.reset}`);

  const gwOk = await checkGateway();
  await checkConfig();
  if (gwOk) {
    await checkLanceDB();
  }
  await checkGraphiti();
  await checkWriteChannels();
  if (gwOk) {
    await checkRetrieval();
  }
  await checkAutoSync();

  // Summary
  section("Summary");
  if (errors === 0 && warnings === 0) {
    console.log(`  ${C.green}${C.bold}All systems healthy.${C.reset}`);
  } else {
    if (errors > 0) console.log(`  ${C.red}${C.bold}${errors} error(s)${C.reset}`);
    if (warnings > 0) console.log(`  ${C.yellow}${C.bold}${warnings} warning(s)${C.reset}`);
  }
  console.log();

  process.exit(errors > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Doctor failed:", err);
  process.exit(2);
});

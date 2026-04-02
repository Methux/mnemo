/**
 * memory-watcher - 常驻后台进程
 * 监听 workspace 关键文件变动，自动提取 facts → upsert LanceDB
 *
 * 启动：node ~/.mnemo/memory-watcher/watcher.mjs
 * 日志：~/.mnemo/logs/memory-watcher.log
 */

import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";

// ─── Config ──────────────────────────────────────────────────────────────────

const HOME = os.homedir();
const WORKSPACE = path.join(HOME, ".mnemo", "workspace");
const LOG_PATH = path.join(HOME, ".mnemo", "logs", "memory-watcher.log");
const PID_PATH = path.join(HOME, ".mnemo", "memory-watcher", "watcher.pid");
const HASH_PATH = path.join(HOME, ".mnemo", "memory-watcher", "file-hashes.json");

const GATEWAY_PORT = 18789;
const GATEWAY_TOKEN = process.env.MNEMO_GATEWAY_TOKEN || process.env.OPENCLAW_GATEWAY_TOKEN || "";
const SESSION_KEY = process.env.MNEMO_SESSION_KEY || "agent:default:local:watcher";
const ANTHROPIC_KEY_PATH = path.join(HOME, ".mnemo", "agents", "default", "agent", "auth-profiles.json");

const WATCH_FILES = ["USER.md", "AGENTS.md", "IDENTITY.md", "TOOLS.md", "MEMORY.md"];
const DEBOUNCE_MS = 3000;

// ─── Logging ─────────────────────────────────────────────────────────────────

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const line = `[${ts}] [memory-watcher] ${msg}\n`;
  process.stdout.write(line);
  try {
    fs.appendFileSync(LOG_PATH, line);
  } catch {}
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function md5(content) {
  return crypto.createHash("md5").update(content).digest("hex");
}

function loadHashes() {
  try {
    return JSON.parse(fs.readFileSync(HASH_PATH, "utf8"));
  } catch {
    return {};
  }
}

function saveHashes(hashes) {
  fs.writeFileSync(HASH_PATH, JSON.stringify(hashes, null, 2));
}

function getAnthropicKey() {
  try {
    const profiles = JSON.parse(fs.readFileSync(ANTHROPIC_KEY_PATH, "utf8"));
    return profiles.profiles?.["anthropic:default"]?.key;
  } catch {
    return null;
  }
}

// ─── Anthropic Haiku 提取 ─────────────────────────────────────────────────────

async function extractFacts(filename, content) {
  const apiKey = getAnthropicKey();
  if (!apiKey) {
    log(`No Anthropic API key, skipping extraction for ${filename}`);
    return [];
  }

  const prompt = `你是记忆提取器。从以下 workspace 文件内容中，提取值得长期记忆的关键事实。

文件：${filename}
内容：
${content.slice(0, 8000)}

输出 JSON 数组，每条记忆格式：
{"text": "...", "category": "fact|entity|preference|decision", "importance": 0.7-0.95}

规则：
- 只提取具体、有价值的信息（人名/品牌/数字/决策/配置/规则）
- 跳过泛泛的说明性描述
- 每条记忆加情节前缀格式：[场景: 来自${filename}] 事实内容
- 每条 < 200 字
- 最多 10 条
返回纯 JSON 数组，不要任何 markdown 包裹。`;

  try {
    const body = JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });

    const url = new URL("https://api.anthropic.com/v1/messages");
    const options = {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
    };

    // 用 node 内置 https
    const https = await import("node:https");
    const result = await new Promise((resolve, reject) => {
      const req = https.default.request(
        { hostname: "api.anthropic.com", path: "/v1/messages", method: "POST", headers: options.headers },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => {
            try {
              resolve(JSON.parse(data));
            } catch {
              reject(new Error("JSON parse failed: " + data.slice(0, 200)));
            }
          });
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });

    const text = result?.content?.[0]?.text || "[]";
    // 清理可能的 markdown 包裹
    const cleaned = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
    return JSON.parse(cleaned);
  } catch (err) {
    log(`Extraction error for ${filename}: ${err.message}`);
    return [];
  }
}

// ─── Gateway memory_store ─────────────────────────────────────────────────────

async function storeMemory(text, category, importance) {
  try {
    const http = await import("node:http");
    const body = JSON.stringify({
      tool: "memory_store",
      args: { text, category, importance },
      sessionKey: SESSION_KEY,
    });

    return await new Promise((resolve, reject) => {
      const req = http.default.request(
        {
          hostname: "127.0.0.1",
          port: GATEWAY_PORT,
          path: "/tools/invoke",
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${GATEWAY_TOKEN}`,
            "Content-Length": Buffer.byteLength(body),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk) => (data += chunk));
          res.on("end", () => resolve({ status: res.statusCode, body: data }));
        }
      );
      req.on("error", reject);
      req.write(body);
      req.end();
    });
  } catch (err) {
    log(`Gateway store error: ${err.message}`);
    return null;
  }
}

// ─── 处理文件变动 ──────────────────────────────────────────────────────────────

async function handleFileChange(filename, hashes) {
  const filePath = path.join(WORKSPACE, filename);
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    return; // 文件被删了
  }

  const newHash = md5(content);
  if (newHash === hashes[filename]) return; // 内容没变

  log(`${filename} changed, extracting facts...`);
  hashes[filename] = newHash;
  saveHashes(hashes);

  const facts = await extractFacts(filename, content);
  if (!facts.length) {
    log(`${filename}: no facts extracted`);
    return;
  }

  let stored = 0;
  for (const fact of facts) {
    if (!fact.text) continue;
    const res = await storeMemory(fact.text, fact.category || "fact", fact.importance || 0.8);
    if (res?.status === 200) stored++;
  }

  log(`${filename}: extracted ${facts.length} facts → stored ${stored}`);
}

// ─── 主逻辑 ───────────────────────────────────────────────────────────────────

const hashes = loadHashes();
const timers = {};

// 写 PID 文件
fs.writeFileSync(PID_PATH, String(process.pid));
log(`Started (PID ${process.pid}), watching: ${WATCH_FILES.join(", ")}`);

// 初始化 hashes（首次运行，不触发提取）
for (const file of WATCH_FILES) {
  const filePath = path.join(WORKSPACE, file);
  if (!hashes[file]) {
    try {
      const content = fs.readFileSync(filePath, "utf8");
      hashes[file] = md5(content);
    } catch {}
  }
}
saveHashes(hashes);
log("Initial hashes captured, watching for changes...");

// 开始监听
try {
  fs.watch(WORKSPACE, { recursive: false }, (eventType, filename) => {
    if (!WATCH_FILES.includes(filename)) return;

    // 防抖
    clearTimeout(timers[filename]);
    timers[filename] = setTimeout(() => {
      handleFileChange(filename, hashes).catch((err) => {
        log(`Error handling ${filename}: ${err.message}`);
      });
    }, DEBOUNCE_MS);
  });
} catch (err) {
  log(`fs.watch failed: ${err.message}, falling back to polling`);

  // Fallback: 每 60 秒轮询一次
  setInterval(async () => {
    for (const file of WATCH_FILES) {
      await handleFileChange(file, hashes).catch(() => {});
    }
  }, 60000);
}

// 优雅退出
process.on("SIGTERM", () => {
  log("Received SIGTERM, shutting down");
  try { fs.unlinkSync(PID_PATH); } catch {}
  process.exit(0);
});
process.on("SIGINT", () => {
  log("Received SIGINT, shutting down");
  try { fs.unlinkSync(PID_PATH); } catch {}
  process.exit(0);
});

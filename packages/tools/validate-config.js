#!/usr/bin/env node
/**
 * validate-config.js — Mnemo config 防呆校验
 * Usage: echo '{}' | node validate-config.js  (stdin)
 *    or: node validate-config.js <config.json>  (file)
 *
 * Exit 0 = valid, Exit 1 = errors found
 * Outputs JSON: { valid: bool, errors: string[], warnings: string[], fixes: string[] }
 */

const fs = require("node:fs");
const path = require("node:path");

// ─── Read input ─────────────────────────────────────────────────────────────

let configText;
const inputFile = process.argv[2];

if (inputFile && inputFile !== "--stdin") {
  configText = fs.readFileSync(inputFile, "utf8");
} else {
  // Read from stdin
  configText = fs.readFileSync(0, "utf8");
}

let config;
try {
  config = JSON.parse(configText);
} catch (e) {
  console.log(JSON.stringify({ valid: false, errors: [`JSON parse failed: ${e.message}`], warnings: [], fixes: [] }));
  process.exit(1);
}

const errors = [];
const warnings = [];
const fixes = [];

// ─── Known field renames ────────────────────────────────────────────────────

const pluginConfig = config?.plugins?.entries?.["memory-lancedb-pro"]?.config;

if (!pluginConfig) {
  // No memory plugin config — might be valid for other reasons
  console.log(JSON.stringify({ valid: true, errors, warnings: ["memory-lancedb-pro plugin config not found"], fixes }));
  process.exit(0);
}

// Check "scoping" → "scopes" (most common mistake)
if ("scoping" in pluginConfig) {
  errors.push('config key "scoping" should be "scopes" — gateway will reject this');
  fixes.push('rename: plugins.entries.memory-lancedb-pro.config.scoping → scopes');
}

// Check root-level temp keys
for (const key of Object.keys(config)) {
  if (key.startsWith("_")) {
    warnings.push(`root key "${key}" looks like a temp field — will cause config validation failure`);
    fixes.push(`remove: ${key}`);
  }
}

// ─── Required features check ────────────────────────────────────────────────

const requiredBooleans = {
  autoCapture: { expected: true, msg: "autoCapture should be true for memory extraction" },
  smartExtraction: { expected: true, msg: "smartExtraction should be true for LLM-powered extraction" },
  captureAssistant: { expected: true, msg: "captureAssistant should be true — without it SmartExtractor gets no input from agent_end" },
  autoRecall: { expected: true, msg: "autoRecall should be true for automatic memory injection" },
  enableManagementTools: { expected: true, msg: "enableManagementTools should be true for memory_list/memory_stats" },
};

for (const [key, { expected, msg }] of Object.entries(requiredBooleans)) {
  if (pluginConfig[key] !== expected) {
    warnings.push(msg);
  }
}

if (pluginConfig.sessionStrategy !== "memoryReflection") {
  warnings.push(`sessionStrategy is "${pluginConfig.sessionStrategy || 'none'}" — recommend "memoryReflection"`);
}

// ─── LLM config ─────────────────────────────────────────────────────────────

if (pluginConfig.llm) {
  if (!pluginConfig.llm.model) {
    warnings.push("llm.model not set — will use default openai/gpt-oss-120b which may not work with your API");
  }
  if (pluginConfig.llm.apiKey) {
    const key = pluginConfig.llm.apiKey;
    if (key.startsWith("${") && key.endsWith("}")) {
      const envVar = key.slice(2, -1);
      // Can't check process.env here since this runs in sync script context
      // Just note it for awareness
    } else if (key === "ollama" || key.length < 10) {
      warnings.push(`llm.apiKey looks like a local/dummy key ("${key.slice(0, 10)}...") — verify it works with llm.baseURL`);
    }
  }

  // Check baseURL matches model
  const model = pluginConfig.llm.model || "";
  const baseURL = pluginConfig.llm.baseURL || "";
  if (model.startsWith("gpt-") && !baseURL.includes("openai.com") && baseURL) {
    warnings.push(`llm.model is "${model}" but baseURL is "${baseURL}" — GPT models need api.openai.com`);
  }
  if (model.includes("qwen") && !baseURL.includes("localhost") && !baseURL.includes("127.0.0.1")) {
    warnings.push(`llm.model is "${model}" but baseURL doesn't point to localhost — qwen usually runs on ollama`);
  }
} else {
  warnings.push("llm config not set — smartExtraction will fall back to embedding provider as LLM (likely wrong)");
}

// ─── Retrieval config ───────────────────────────────────────────────────────

const ret = pluginConfig.retrieval || {};

if (ret.rerank === "cross-encoder") {
  if (!ret.rerankApiKey) {
    errors.push("retrieval.rerank is cross-encoder but rerankApiKey is missing — rerank will fail");
  }
  if (!ret.rerankProvider) {
    warnings.push("retrieval.rerankProvider not set — defaults to jina, make sure that's correct");
  }
  if (!ret.rerankEndpoint) {
    warnings.push("retrieval.rerankEndpoint not set — defaults to jina endpoint");
  }
}

if (ret.candidatePoolSize && ret.candidatePoolSize < 20) {
  warnings.push(`retrieval.candidatePoolSize is ${ret.candidatePoolSize} — recommend ≥20 for quality`);
}

// ─── Embedding config ───────────────────────────────────────────────────────

const emb = pluginConfig.embedding;
if (!emb) {
  errors.push("embedding config is required");
} else {
  if (!emb.apiKey) {
    errors.push("embedding.apiKey is required");
  }
  if (!emb.model) {
    warnings.push("embedding.model not set — will use default");
  }
}

// ─── Decay / Tier ───────────────────────────────────────────────────────────

if (!pluginConfig.decay) {
  warnings.push("decay config not set — memories will not age/decay");
}

if (!pluginConfig.tier) {
  warnings.push("tier config not set — no core/working/peripheral classification");
}

// ─── Scopes ─────────────────────────────────────────────────────────────────

if (pluginConfig.scopes?.agentAccess) {
  const agents = Object.keys(pluginConfig.scopes.agentAccess);
  for (const agent of agents) {
    const access = pluginConfig.scopes.agentAccess[agent];
    if (!Array.isArray(access) || access.length === 0) {
      warnings.push(`scopes.agentAccess.${agent} is empty — agent has no accessible scopes`);
    }
    if (!access.includes("global")) {
      warnings.push(`scopes.agentAccess.${agent} doesn't include "global" — agent can't see global memories`);
    }
  }
}

// ─── mdMirror ───────────────────────────────────────────────────────────────

if (pluginConfig.mdMirror?.enabled && !pluginConfig.mdMirror?.dir) {
  warnings.push("mdMirror.enabled but dir not set — will use default fallback dir");
}

// ─── Plugin schema additionalProperties check ───────────────────────────────

const KNOWN_KEYS = new Set([
  "embedding", "dbPath", "enableManagementTools", "sessionStrategy",
  "autoCapture", "autoRecall", "autoRecallMinLength", "autoRecallMinRepeated",
  "captureAssistant", "smartExtraction", "extractMinMessages", "extractMaxChars",
  "retrieval", "decay", "tier", "sessionMemory", "selfImprovement",
  "memoryReflection", "scopes", "llm", "mdMirror",
]);

for (const key of Object.keys(pluginConfig)) {
  if (!KNOWN_KEYS.has(key)) {
    errors.push(`unknown config key "${key}" — plugin schema has additionalProperties:false, gateway will reject`);
    fixes.push(`remove or rename: plugins.entries.memory-lancedb-pro.config.${key}`);
  }
}

// ─── Auto-fix output ────────────────────────────────────────────────────────

const valid = errors.length === 0;
const result = { valid, errors, warnings, fixes };

console.log(JSON.stringify(result, null, 2));
process.exit(valid ? 0 : 1);

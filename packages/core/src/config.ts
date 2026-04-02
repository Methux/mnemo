// SPDX-License-Identifier: MIT
/**
 * Shared Configuration Helpers
 * Extracted from index.ts for reuse by MCP server and gateway plugin.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

// ============================================================================
// Configuration Types
// ============================================================================

export interface PluginConfig {
  embedding: {
    provider: "openai-compatible";
    apiKey: string | string[];
    model?: string;
    baseURL?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
    normalized?: boolean;
  };
  dbPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
  autoRecallMinLength?: number;
  autoRecallMinRepeated?: number;
  captureAssistant?: boolean;
  retrieval?: {
    mode?: "hybrid" | "vector";
    vectorWeight?: number;
    bm25Weight?: number;
    minScore?: number;
    rerank?: "cross-encoder" | "lightweight" | "none";
    candidatePoolSize?: number;
    rerankApiKey?: string;
    rerankModel?: string;
    rerankEndpoint?: string;
    rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone";
    recencyHalfLifeDays?: number;
    recencyWeight?: number;
    filterNoise?: boolean;
    lengthNormAnchor?: number;
    hardMinScore?: number;
    timeDecayHalfLifeDays?: number;
    reinforcementFactor?: number;
    maxHalfLifeMultiplier?: number;
  };
  scopes?: {
    default?: string;
    definitions?: Record<string, { description: string }>;
    agentAccess?: Record<string, string[]>;
  };
  enableManagementTools?: boolean;
  sessionMemory?: { enabled?: boolean; messageCount?: number };
  mdMirror?: { enabled?: boolean; dir?: string };
  autoCaptureLLM?: {
    enabled?: boolean;
    endpoint?: string;
    model?: string;
    timeoutMs?: number;
  };
}

// ============================================================================
// Helpers
// ============================================================================

export function getDefaultDbPath(): string {
  // Prefer MNEMO_DB_PATH env, then ~/.mnemo/data/lancedb (default),
  // then ~/.openclaw/memory/lancedb-pro (legacy fallback)
  if (process.env.MNEMO_DB_PATH) return process.env.MNEMO_DB_PATH;
  const mnemoPath = join(homedir(), ".mnemo", "data", "lancedb");
  const openclawPath = join(homedir(), ".openclaw", "memory", "lancedb-pro");
  try {
    const { existsSync } = require("fs");
    if (existsSync(openclawPath) && !existsSync(mnemoPath)) return openclawPath;
  } catch {}
  return mnemoPath;
}

export function resolveEnvVars(value: string): string {
  return value.replace(/\$\{([^}]+)\}/g, (_, envVar) => {
    const envValue = process.env[envVar];
    if (!envValue) {
      throw new Error(`Environment variable ${envVar} is not set`);
    }
    return envValue;
  });
}

export function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return undefined;
    const resolved = resolveEnvVars(s);
    const n = Number(resolved);
    if (Number.isFinite(n) && n > 0) return Math.floor(n);
  }
  return undefined;
}

// ============================================================================
// Config Parser
// ============================================================================

export function parsePluginConfig(value: unknown): PluginConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("mnemo config required");
  }
  const cfg = value as Record<string, unknown>;

  const embedding = cfg.embedding as Record<string, unknown> | undefined;
  if (!embedding) {
    throw new Error("embedding config is required");
  }

  // Accept single key (string) or array of keys for round-robin rotation
  let apiKey: string | string[];
  if (typeof embedding.apiKey === "string") {
    apiKey = embedding.apiKey;
  } else if (Array.isArray(embedding.apiKey) && embedding.apiKey.length > 0) {
    const invalid = embedding.apiKey.findIndex(
      (k: unknown) => typeof k !== "string" || (k as string).trim().length === 0,
    );
    if (invalid !== -1) {
      throw new Error(
        `embedding.apiKey[${invalid}] is invalid: expected non-empty string`,
      );
    }
    apiKey = embedding.apiKey as string[];
  } else if (embedding.apiKey !== undefined) {
    throw new Error("embedding.apiKey must be a string or non-empty array of strings");
  } else {
    apiKey = process.env.OPENAI_API_KEY || "";
  }

  if (!apiKey || (Array.isArray(apiKey) && apiKey.length === 0)) {
    throw new Error("embedding.apiKey is required (set directly or via OPENAI_API_KEY env var)");
  }

  return {
    embedding: {
      provider: "openai-compatible",
      apiKey,
      model:
        typeof embedding.model === "string"
          ? embedding.model
          : "text-embedding-3-small",
      baseURL:
        typeof embedding.baseURL === "string"
          ? resolveEnvVars(embedding.baseURL)
          : undefined,
      dimensions: parsePositiveInt(embedding.dimensions ?? cfg.dimensions),
      taskQuery:
        typeof embedding.taskQuery === "string"
          ? embedding.taskQuery
          : undefined,
      taskPassage:
        typeof embedding.taskPassage === "string"
          ? embedding.taskPassage
          : undefined,
      normalized:
        typeof embedding.normalized === "boolean"
          ? embedding.normalized
          : undefined,
    },
    dbPath: typeof cfg.dbPath === "string" ? cfg.dbPath : undefined,
    autoCapture: cfg.autoCapture !== false,
    autoRecall: cfg.autoRecall === true,
    autoRecallMinLength: parsePositiveInt(cfg.autoRecallMinLength),
    autoRecallMinRepeated: parsePositiveInt(cfg.autoRecallMinRepeated),
    captureAssistant: cfg.captureAssistant === true,
    retrieval:
      typeof cfg.retrieval === "object" && cfg.retrieval !== null
        ? (cfg.retrieval as any)
        : undefined,
    scopes:
      typeof cfg.scopes === "object" && cfg.scopes !== null
        ? (cfg.scopes as any)
        : undefined,
    enableManagementTools: cfg.enableManagementTools === true,
    sessionMemory:
      typeof cfg.sessionMemory === "object" && cfg.sessionMemory !== null
        ? {
            enabled:
              (cfg.sessionMemory as Record<string, unknown>).enabled !== false,
            messageCount:
              typeof (cfg.sessionMemory as Record<string, unknown>)
                .messageCount === "number"
                ? ((cfg.sessionMemory as Record<string, unknown>)
                    .messageCount as number)
                : undefined,
          }
        : undefined,
    mdMirror:
      typeof cfg.mdMirror === "object" && cfg.mdMirror !== null
        ? {
            enabled:
              (cfg.mdMirror as Record<string, unknown>).enabled === true,
            dir:
              typeof (cfg.mdMirror as Record<string, unknown>).dir === "string"
                ? ((cfg.mdMirror as Record<string, unknown>).dir as string)
                : undefined,
          }
        : undefined,
    autoCaptureLLM:
      typeof cfg.autoCaptureLLM === "object" && cfg.autoCaptureLLM !== null
        ? {
            enabled:
              (cfg.autoCaptureLLM as Record<string, unknown>).enabled === true,
            endpoint:
              typeof (cfg.autoCaptureLLM as Record<string, unknown>).endpoint === "string"
                ? ((cfg.autoCaptureLLM as Record<string, unknown>).endpoint as string)
                : undefined,
            model:
              typeof (cfg.autoCaptureLLM as Record<string, unknown>).model === "string"
                ? ((cfg.autoCaptureLLM as Record<string, unknown>).model as string)
                : undefined,
            timeoutMs: parsePositiveInt(
              (cfg.autoCaptureLLM as Record<string, unknown>).timeoutMs,
            ),
          }
        : undefined,
  };
}

// ============================================================================
// Load config from config file
// Checks: MNEMO_CONFIG env → ~/.mnemo/mnemo.json → ~/.openclaw/openclaw.json
// ============================================================================

export function loadConfigFromOpenClaw(): PluginConfig {
  const envPath = process.env.MNEMO_CONFIG;
  const mnemoPath = join(homedir(), ".mnemo", "mnemo.json");
  const openclawPath = join(homedir(), ".openclaw", "openclaw.json");
  const configPath = envPath || (existsSync(mnemoPath) ? mnemoPath : openclawPath);
  let raw: string;
  try {
    raw = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(
      `Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  let json: any;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Try "mnemo" entry first, fall back to legacy "memory-lancedb-pro" key (backwards compat)
  const pluginConfig =
    json?.plugins?.entries?.["mnemo"]?.config ??
    json?.plugins?.entries?.["memory-lancedb-pro"]?.config;
  if (!pluginConfig) {
    throw new Error(
      `No config found at plugins.entries["mnemo"].config in ${configPath}`,
    );
  }

  return parsePluginConfig(pluginConfig);
}

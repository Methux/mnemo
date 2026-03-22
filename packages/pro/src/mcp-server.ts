/**
 * MCP Server for memory-lancedb-pro
 *
 * Exposes memory tools (search, store, delete, update, list, stats) over
 * stdio JSON-RPC so Claude Code can call them directly without going through
 * the OpenClaw gateway.
 *
 * Usage:
 *   node --import jiti/register src/mcp-server.ts
 *
 * Register with Claude Code:
 *   claude mcp add memory -s user -- node --import jiti/register \
 *     /path/to/memory-lancedb-pro/src/mcp-server.ts
 */

// Redirect console.log to stderr — stdout is reserved for JSON-RPC
const _origLog = console.log;
console.log = (...args: any[]) => console.error(...args);

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { join } from "node:path";
import { mkdir, appendFile } from "node:fs/promises";

import { loadConfigFromOpenClaw, getDefaultDbPath } from "./config.js";
import { MemoryStore, validateStoragePath } from "./store.js";
import { createEmbedder, getVectorDimensions } from "./embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
import { createScopeManager } from "./scopes.js";
import { isNoise } from "./noise-filter.js";
import { SemanticGate } from "./semantic-gate.js";
import { recoverPendingWrites } from "./wal-recovery.js";

// ============================================================================
// Initialization
// ============================================================================

const config = loadConfigFromOpenClaw();

const dbPath = config.dbPath || getDefaultDbPath();
try {
  validateStoragePath(dbPath);
} catch (err) {
  console.error(`memory-lancedb-pro mcp: storage path issue — ${String(err)}`);
}

const vectorDim = getVectorDimensions(
  config.embedding.model || "text-embedding-3-small",
  config.embedding.dimensions,
);

const store = new MemoryStore({ dbPath, vectorDim });
const embedder = createEmbedder({
  provider: "openai-compatible",
  apiKey: config.embedding.apiKey,
  model: config.embedding.model || "text-embedding-3-small",
  baseURL: config.embedding.baseURL,
  dimensions: config.embedding.dimensions,
  taskQuery: config.embedding.taskQuery,
  taskPassage: config.embedding.taskPassage,
  normalized: config.embedding.normalized,
});
console.warn(`[config-debug] config.retrieval keys: ${JSON.stringify(Object.keys(config.retrieval || {}))}`);
console.warn(`[config-debug] config.retrieval.rerankApiKey: ${config.retrieval?.rerankApiKey ? 'SET(' + String(config.retrieval.rerankApiKey).substring(0, 8) + ')' : 'EMPTY'}`);
const retriever = createRetriever(store, embedder, {
  ...DEFAULT_RETRIEVAL_CONFIG,
  ...config.retrieval,
});
const scopeManager = createScopeManager(config.scopes);

// Inject semantic gate into store
const semanticGate = new SemanticGate(embedder);
store.setSemanticGate(semanticGate);

// WAL recovery: fire-and-forget on startup
recoverPendingWrites().catch((err) => {
  console.error(`memory-lancedb-pro mcp: WAL recovery failed — ${String(err)}`);
});

// ============================================================================
// Markdown Mirror (simplified — no OpenClaw API dependency)
// ============================================================================

const mirrorDir = config.mdMirror?.enabled
  ? (config.mdMirror.dir || join(getDefaultDbPath(), "..", "lancedb-pro-mirror"))
  : null;

async function mirrorWrite(
  text: string,
  category: string,
  scope: string,
  timestamp?: number,
): Promise<void> {
  if (!mirrorDir) return;
  try {
    const ts = new Date(timestamp || Date.now());
    const dateStr = ts.toISOString().split("T")[0];
    const filePath = join(mirrorDir, `${dateStr}.md`);
    const safeText = text.replace(/\n/g, " ").slice(0, 500);
    const line = `- ${ts.toISOString()} [${category}:${scope}] source=mcp ${safeText}\n`;
    await mkdir(mirrorDir, { recursive: true });
    await appendFile(filePath, line, "utf8");
  } catch {
    // Fail-open: mirror errors never block tool responses
  }
}

// ============================================================================
// Helpers
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback = 0.7): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1, Math.max(0, value));
}

// ============================================================================
// MCP Server
// ============================================================================

const server = new McpServer({
  name: "memory-lancedb-pro",
  version: "1.0.0",
});

// --- memory_search ---
server.tool(
  "memory_search",
  "Search through long-term memories using hybrid retrieval (vector + keyword search). Use when you need context about user preferences, past decisions, or previously discussed topics.",
  {
    query: z.string().describe("Search query for finding relevant memories"),
    limit: z.number().optional().describe("Max results to return (default: 5, max: 20)"),
    scope: z.string().optional().describe("Specific memory scope to search in"),
    category: z.enum(["preference", "fact", "decision", "entity", "other"]).optional(),
  },
  async ({ query, limit = 5, scope, category }) => {
    try {
      const safeLimit = clampInt(limit, 1, 20);

      let scopeFilter = scopeManager.getAccessibleScopes();
      if (scope) {
        if (scopeManager.isAccessible(scope)) {
          scopeFilter = [scope];
        } else {
          return { content: [{ type: "text" as const, text: `Access denied to scope: ${scope}` }] };
        }
      }

      const results = await retriever.retrieve({
        query,
        limit: safeLimit,
        scopeFilter,
        category,
        source: "manual",
      });

      if (results.length === 0) {
        return { content: [{ type: "text" as const, text: "No relevant memories found." }] };
      }

      const text = results
        .map((r, i) => {
          const sources: string[] = [];
          if (r.sources.vector) sources.push("vector");
          if (r.sources.bm25) sources.push("BM25");
          if (r.sources.reranked) sources.push("reranked");
          return `${i + 1}. [${r.entry.id}] [${r.entry.category}:${r.entry.scope}] ${r.entry.text} (${(r.score * 100).toFixed(0)}%${sources.length > 0 ? `, ${sources.join("+")}` : ""})`;
        })
        .join("\n");

      return { content: [{ type: "text" as const, text: `Found ${results.length} memories:\n\n${text}` }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Memory search failed: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  },
);

// --- memory_store ---
server.tool(
  "memory_store",
  "Save important information in long-term memory. Use for preferences, facts, decisions, and other notable information.",
  {
    text: z.string().describe("Information to remember"),
    importance: z.number().optional().describe("Importance score 0-1 (default: 0.7)"),
    category: z.enum(["preference", "fact", "decision", "entity", "other"]).optional(),
    scope: z.string().optional().describe("Memory scope (optional, defaults to global)"),
  },
  async ({ text, importance = 0.7, category = "other", scope }) => {
    try {
      let targetScope = scope || scopeManager.getDefaultScope();

      if (!scopeManager.isAccessible(targetScope)) {
        return { content: [{ type: "text" as const, text: `Access denied to scope: ${targetScope}` }] };
      }

      if (isNoise(text)) {
        return { content: [{ type: "text" as const, text: "Skipped: text detected as noise (greeting, boilerplate, or meta-question)" }] };
      }

      const safeImportance = clamp01(importance, 0.7);
      const vector = await embedder.embedPassage(text);

      // Dedup check (fail-open)
      let existing: Awaited<ReturnType<typeof store.vectorSearch>> = [];
      try {
        existing = await store.vectorSearch(vector, 1, 0.1, [targetScope]);
      } catch {
        // Dedup check failed — continue store
      }

      if (existing.length > 0 && existing[0].score > 0.98) {
        return {
          content: [{ type: "text" as const, text: `Similar memory already exists: "${existing[0].entry.text}"` }],
        };
      }

      const entry = await store.store({
        text,
        vector,
        importance: safeImportance,
        category: category as any,
        scope: targetScope,
      });

      await mirrorWrite(text, category, targetScope, entry.timestamp);

      return {
        content: [{ type: "text" as const, text: `Stored: "${text.slice(0, 100)}${text.length > 100 ? "..." : ""}" [id=${entry.id}] in scope '${targetScope}'` }],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Memory storage failed: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  },
);

// --- memory_delete ---
server.tool(
  "memory_delete",
  "Delete a specific memory by ID.",
  {
    memoryId: z.string().describe("Memory ID to delete (full UUID or 8+ char prefix)"),
  },
  async ({ memoryId }) => {
    try {
      const scopeFilter = scopeManager.getAccessibleScopes();
      const deleted = await store.delete(memoryId, scopeFilter);
      if (deleted) {
        return { content: [{ type: "text" as const, text: `Memory ${memoryId} deleted.` }] };
      }
      return { content: [{ type: "text" as const, text: `Memory ${memoryId} not found or access denied.` }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Memory deletion failed: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  },
);

// --- memory_update ---
server.tool(
  "memory_update",
  "Update an existing memory in-place. Preserves original timestamp.",
  {
    memoryId: z.string().describe("ID of the memory to update (full UUID or 8+ char prefix)"),
    text: z.string().optional().describe("New text content (triggers re-embedding)"),
    importance: z.number().optional().describe("New importance score 0-1"),
    category: z.enum(["preference", "fact", "decision", "entity", "other"]).optional(),
  },
  async ({ memoryId, text, importance, category }) => {
    try {
      if (!text && importance === undefined && !category) {
        return { content: [{ type: "text" as const, text: "Nothing to update. Provide at least one of: text, importance, category." }] };
      }

      const scopeFilter = scopeManager.getAccessibleScopes();

      let newVector: number[] | undefined;
      if (text) {
        if (isNoise(text)) {
          return { content: [{ type: "text" as const, text: "Skipped: updated text detected as noise" }] };
        }
        newVector = await embedder.embedPassage(text);
      }

      const updates: Record<string, any> = {};
      if (text) updates.text = text;
      if (newVector) updates.vector = newVector;
      if (importance !== undefined) updates.importance = clamp01(importance, 0.7);
      if (category) updates.category = category;

      const updated = await store.update(memoryId, updates, scopeFilter);

      if (!updated) {
        return { content: [{ type: "text" as const, text: `Memory ${memoryId} not found or access denied.` }] };
      }

      return {
        content: [{ type: "text" as const, text: `Updated memory ${updated.id.slice(0, 8)}...: "${updated.text.slice(0, 80)}${updated.text.length > 80 ? "..." : ""}"` }],
      };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Memory update failed: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  },
);

// --- memory_list ---
server.tool(
  "memory_list",
  "List recent memories with optional filtering by scope and category.",
  {
    limit: z.number().optional().describe("Max memories to list (default: 10, max: 50)"),
    offset: z.number().optional().describe("Number of memories to skip (default: 0)"),
    scope: z.string().optional().describe("Filter by specific scope"),
    category: z.enum(["preference", "fact", "decision", "entity", "other"]).optional(),
  },
  async ({ limit = 10, offset = 0, scope, category }) => {
    try {
      const safeLimit = clampInt(limit, 1, 50);
      const safeOffset = clampInt(offset, 0, 1000);

      let scopeFilter = scopeManager.getAccessibleScopes();
      if (scope) {
        if (scopeManager.isAccessible(scope)) {
          scopeFilter = [scope];
        } else {
          return { content: [{ type: "text" as const, text: `Access denied to scope: ${scope}` }] };
        }
      }

      const entries = await store.list(scopeFilter, category, safeLimit, safeOffset);

      if (entries.length === 0) {
        return { content: [{ type: "text" as const, text: "No memories found." }] };
      }

      const text = entries
        .map((entry, i) => {
          const date = new Date(entry.timestamp).toISOString().split("T")[0];
          return `${safeOffset + i + 1}. [${entry.id}] [${entry.category}:${entry.scope}] ${entry.text.slice(0, 100)}${entry.text.length > 100 ? "..." : ""} (${date})`;
        })
        .join("\n");

      return { content: [{ type: "text" as const, text: `Recent memories (showing ${entries.length}):\n\n${text}` }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Failed to list memories: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  },
);

// --- memory_stats ---
server.tool(
  "memory_stats",
  "Get statistics about memory usage, scopes, and categories.",
  {
    scope: z.string().optional().describe("Specific scope to get stats for"),
  },
  async ({ scope }) => {
    try {
      let scopeFilter = scopeManager.getAccessibleScopes();
      if (scope) {
        if (scopeManager.isAccessible(scope)) {
          scopeFilter = [scope];
        } else {
          return { content: [{ type: "text" as const, text: `Access denied to scope: ${scope}` }] };
        }
      }

      const stats = await store.stats(scopeFilter);
      const scopeManagerStats = scopeManager.getStats();
      const retrievalConfig = retriever.getConfig();

      const text = [
        `Memory Statistics:`,
        `  Total memories: ${stats.totalCount}`,
        `  Available scopes: ${scopeManagerStats.totalScopes}`,
        `  Retrieval mode: ${retrievalConfig.mode}`,
        `  FTS support: ${store.hasFtsSupport ? "Yes" : "No"}`,
        ``,
        `Memories by scope:`,
        ...Object.entries(stats.scopeCounts).map(
          ([s, count]) => `  ${s}: ${count}`,
        ),
        ``,
        `Memories by category:`,
        ...Object.entries(stats.categoryCounts).map(
          ([c, count]) => `  ${c}: ${count}`,
        ),
      ].join("\n");

      return { content: [{ type: "text" as const, text }] };
    } catch (error) {
      return { content: [{ type: "text" as const, text: `Failed to get memory stats: ${error instanceof Error ? error.message : String(error)}` }] };
    }
  },
);

// ============================================================================
// Start
// ============================================================================

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("memory-lancedb-pro MCP server started (stdio)");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});

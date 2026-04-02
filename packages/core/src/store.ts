// SPDX-License-Identifier: MIT
/**
 * LanceDB Storage Layer with Multi-Scope Support
 */

import type * as LanceDB from "@lancedb/lancedb";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  accessSync,
  constants,
  mkdirSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { dirname } from "node:path";
import { buildSmartMetadata, parseSmartMetadata, stringifySmartMetadata } from "./smart-metadata.js";
import type { SemanticGate } from "./semantic-gate.js";
import type { LlmClient } from "./llm-client.js";
import { requirePro } from "./license.js";
import { log } from "./logger.js";

// Pro: Audit log — record all CRUD operations for GDPR/compliance
// TODO: type these with actual audit function signatures from audit-log.ts
let _auditCreate: ((...args: unknown[]) => void) | null = null;
let _auditUpdate: ((...args: unknown[]) => void) | null = null;
let _auditDelete: ((...args: unknown[]) => void) | null = null;
let _auditExpire: ((...args: unknown[]) => void) | null = null;

// Pro: audit log + WAL — loaded from @mnemoai/pro if available
let walAppend: ((...args: unknown[]) => Promise<void>) | null = null;
let walMarkCommitted: ((...args: unknown[]) => Promise<void>) | null = null;
let walMarkFailed: ((...args: unknown[]) => Promise<void>) | null = null;

if (requirePro("audit-log") || requirePro("wal")) {
  import("@mnemoai/" + "pro").then((mod) => {
    if (mod.auditCreate) {
      _auditCreate = mod.auditCreate;
      _auditUpdate = mod.auditUpdate;
      _auditDelete = mod.auditDelete;
      _auditExpire = mod.auditExpire;
    }
    if (mod.walAppend) {
      walAppend = mod.walAppend;
      walMarkCommitted = mod.walMarkCommitted;
      walMarkFailed = mod.walMarkFailed;
    }
  }).catch(() => {});
}

// ============================================================================
// Types
// ============================================================================

export interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: "preference" | "fact" | "decision" | "entity" | "other" | "reflection";
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string; // JSON string for extensible metadata
}

export interface MemorySearchResult {
  entry: MemoryEntry;
  score: number;
}

export interface StoreConfig {
  dbPath: string;
  vectorDim: number;
  /** Enable near-duplicate detection before writing (default: true) */
  deduplication?: boolean;
  /** Enable semantic noise gate to filter fragments (default: true) */
  semanticGate?: boolean;
  /** Storage backend: "lancedb" (default), "qdrant", "chroma", "pgvector" */
  storageBackend?: string;
  /** Backend-specific config (url, connectionString, etc.) */
  storageConfig?: Record<string, unknown>;
}

const DEDUP_SIMILARITY_THRESHOLD = 0.92;
const CONFLICT_SIMILARITY_THRESHOLD = 0.55;

export interface MetadataPatch {
  [key: string]: unknown;
}

// ============================================================================
// Storage Adapter Support (multi-backend)
// ============================================================================

import type { StorageAdapter } from "./storage-adapter.js";
import { createAdapter, listAdapters } from "./storage-adapter.js";

// Auto-register adapters on first import
let _adaptersLoaded = false;
async function ensureAdaptersLoaded(): Promise<void> {
  if (_adaptersLoaded) return;
  _adaptersLoaded = true;
  // Dynamic imports — only loads the adapter that's actually needed
  const dbg = !!process.env.MNEMO_DEBUG;
  try { await import("./adapters/lancedb.js"); } catch (e) { if (dbg) log.debug("adapter lancedb not available:", e); }
  try { await import("./adapters/qdrant.js"); } catch (e) { if (dbg) log.debug("adapter qdrant not available:", e); }
  try { await import("./adapters/chroma.js"); } catch (e) { if (dbg) log.debug("adapter chroma not available:", e); }
  try { await import("./adapters/pgvector.js"); } catch (e) { if (dbg) log.debug("adapter pgvector not available:", e); }
}

// ============================================================================
// LanceDB Dynamic Import (legacy path — used when storageBackend is unset or "lancedb")
// ============================================================================

let lancedbImportPromise: Promise<typeof import("@lancedb/lancedb")> | null =
  null;

export const loadLanceDB = async (): Promise<
  typeof import("@lancedb/lancedb")
> => {
  if (!lancedbImportPromise) {
    lancedbImportPromise = import("@lancedb/lancedb");
  }
  try {
    return await lancedbImportPromise;
  } catch (err) {
    throw new Error(
      `mnemo: failed to load LanceDB. ${String(err)}`,
      { cause: err },
    );
  }
};

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

/**
 * Sanitize a string for use in SQL WHERE clauses.
 * Strips everything except alphanumeric, dash, underscore, dot, colon, and space.
 * This is stricter than SQL escaping — it prevents injection by allowlist.
 */
function escapeSqlLiteral(value: string): string {
  if (typeof value !== "string") return "";
  // Allowlist: only safe chars for IDs, scopes, categories
  return value.replace(/[^a-zA-Z0-9\-_.:@ \u4e00-\u9fff\u3400-\u4dbf]/g, "");
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().trim();
}

function scoreLexicalHit(query: string, candidates: Array<{ text: string; weight: number }>): number {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) return 0;

  let score = 0;
  for (const candidate of candidates) {
    const normalized = normalizeSearchText(candidate.text);
    if (!normalized) continue;
    if (normalized.includes(normalizedQuery)) {
      score = Math.max(score, Math.min(0.95, 0.72 + normalizedQuery.length * 0.02) * candidate.weight);
    }
  }

  return score;
}

// ============================================================================
// Storage Path Validation
// ============================================================================

/**
 * Validate and prepare the storage directory before LanceDB connection.
 * Resolves symlinks, creates missing directories, and checks write permissions.
 * Returns the resolved absolute path on success, or throws a descriptive error.
 */
export function validateStoragePath(dbPath: string): string {
  let resolvedPath = dbPath;

  // Resolve symlinks (including dangling symlinks)
  try {
    const stats = lstatSync(dbPath);
    if (stats.isSymbolicLink()) {
      try {
        resolvedPath = realpathSync(dbPath);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        throw new Error(
          `dbPath "${dbPath}" is a symlink whose target does not exist.\n` +
          `  Fix: Create the target directory, or update the symlink to point to a valid path.\n` +
          `  Details: ${e.code || ""} ${e.message}`,
        );
      }
    }
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    // Missing path is OK (it will be created below)
    if (e?.code === "ENOENT") {
      // no-op
    } else if (
      typeof e?.message === "string" &&
      e.message.includes("symlink whose target does not exist")
    ) {
      throw err;
    } else {
      // Other lstat failures — continue with original path
    }
  }

  // Create directory if it doesn't exist
  if (!existsSync(resolvedPath)) {
    try {
      mkdirSync(resolvedPath, { recursive: true });
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      throw new Error(
        `Failed to create dbPath directory "${resolvedPath}".\n` +
        `  Fix: Ensure the parent directory "${dirname(resolvedPath)}" exists and is writable,\n` +
        `       or create it manually: mkdir -p "${resolvedPath}"\n` +
        `  Details: ${e.code || ""} ${e.message}`,
      );
    }
  }

  // Check write permissions
  try {
    accessSync(resolvedPath, constants.W_OK);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    throw new Error(
      `dbPath directory "${resolvedPath}" is not writable.\n` +
      `  Fix: Check permissions with: ls -la "${dirname(resolvedPath)}"\n` +
      `       Or grant write access: chmod u+w "${resolvedPath}"\n` +
      `  Details: ${e.code || ""} ${e.message}`,
    );
  }

  return resolvedPath;
}

// ============================================================================
// Memory Store
// ============================================================================

const TABLE_NAME = "memories";

export class MemoryStore {
  private db: LanceDB.Connection | null = null;
  private table: LanceDB.Table | null = null;
  private initPromise: Promise<void> | null = null;
  private ftsIndexCreated = false;
  private updateQueue: Promise<void> = Promise.resolve();
  private semanticGateInstance: SemanticGate | null = null;

  /** When using a non-LanceDB adapter, this holds the active adapter instance */
  private _adapter: StorageAdapter | null = null;

  /** True when using the adapter path (non-LanceDB backends) */
  get usingAdapter(): boolean { return this._adapter !== null; }

  constructor(private readonly config: StoreConfig) { }

  /** Inject a SemanticGate instance (created externally with an Embedder). */
  setSemanticGate(gate: SemanticGate): void {
    this.semanticGateInstance = gate;
  }

  /** Inject an LLM client for intelligent contradiction detection. */
  private llmClient: LlmClient | null = null;
  setLlmClient(client: LlmClient): void {
    this.llmClient = client;
  }

  get dbPath(): string {
    return this.config.dbPath;
  }

  /** Get the active adapter (null if using legacy LanceDB path) */
  get adapter(): StorageAdapter | null {
    return this._adapter;
  }

  /** Whether BM25 full-text search is available */
  get hasFtsSupport(): boolean {
    if (this._adapter) return this._adapter.hasFullTextSearch();
    return this.ftsIndexCreated;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.table || this._adapter) {
      return;
    }
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this.doInitialize().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    // ── Adapter path: non-LanceDB backends (qdrant, chroma, pgvector) ──
    const backend = this.config.storageBackend;
    if (backend && backend !== "lancedb") {
      await ensureAdaptersLoaded();
      const available = listAdapters();
      if (!available.includes(backend)) {
        throw new Error(
          `Storage backend "${backend}" not available. Installed: ${available.join(", ")}. ` +
          `Check that the adapter is properly imported.`
        );
      }
      this._adapter = createAdapter(backend, this.config.storageConfig);
      await this._adapter.connect(this.config.dbPath);
      await this._adapter.ensureTable(this.config.vectorDim);
      this.ftsIndexCreated = this._adapter.hasFullTextSearch();
      return; // Skip LanceDB initialization
    }

    // ── Legacy LanceDB path (default) ──
    const lancedb = await loadLanceDB();

    let db: LanceDB.Connection;
    try {
      db = await lancedb.connect(this.config.dbPath);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      const code = e.code || "";
      const message = e.message || String(err);
      throw new Error(
        `Failed to open LanceDB at "${this.config.dbPath}": ${code} ${message}\n` +
        `  Fix: Verify the path exists and is writable. Check parent directory permissions.`,
      );
    }

    let table: LanceDB.Table;

    // Idempotent table init: try openTable first, create only if missing,
    // and handle the race where tableNames() misses an existing table but
    // createTable then sees it (LanceDB eventual consistency).
    try {
      table = await db.openTable(TABLE_NAME);

      // Check if we need to add scope column for backward compatibility
      try {
        const sample = await table.query().limit(1).toArray();
        if (sample.length > 0 && !("scope" in sample[0])) {
          log.warn(
            "Adding scope column for backward compatibility with existing data",
          );
        }
      } catch (err) {
        log.warn("Could not check table schema:", err);
      }
    } catch (_openErr) {
      // Table doesn't exist yet — create it
      const schemaEntry: MemoryEntry = {
        id: "__schema__",
        text: "",
        vector: Array.from({ length: this.config.vectorDim }).fill(
          0,
        ) as number[],
        category: "other",
        scope: "global",
        importance: 0,
        timestamp: 0,
        metadata: "{}",
      };

      try {
        table = await db.createTable(TABLE_NAME, [schemaEntry]);
        await table.delete('id = "__schema__"');
      } catch (createErr) {
        // Race: another caller (or eventual consistency) created the table
        // between our failed openTable and this createTable — just open it.
        if (String(createErr).includes("already exists")) {
          table = await db.openTable(TABLE_NAME);
        } else {
          throw createErr;
        }
      }
    }

    // Validate vector dimensions
    // Note: LanceDB returns Arrow Vector objects, not plain JS arrays.
    // Array.isArray() returns false for Arrow Vectors, so use .length instead.
    const sample = await table.query().limit(1).toArray();
    if (sample.length > 0 && sample[0]?.vector?.length) {
      const existingDim = sample[0].vector.length;
      if (existingDim !== this.config.vectorDim) {
        throw new Error(
          `Vector dimension mismatch: table=${existingDim}, config=${this.config.vectorDim}. Create a new table/dbPath or set matching embedding.dimensions.`,
        );
      }
    }

    // Create FTS index for BM25 search (graceful fallback if unavailable)
    try {
      await this.createFtsIndex(table);
      this.ftsIndexCreated = true;
    } catch (err) {
      log.warn(
        "Failed to create FTS index, falling back to vector-only search:",
        err,
      );
      this.ftsIndexCreated = false;
    }

    this.db = db;
    this.table = table;
  }

  private async createFtsIndex(table: LanceDB.Table): Promise<void> {
    try {
      // Check if FTS index already exists
      const indices = await table.listIndices();
      const hasFtsIndex = indices?.some(
        // TODO: type this — LanceDB index type lacks proper typings for indexType/columns
        (idx: any) => idx.indexType === "FTS" || idx.columns?.includes("text"),
      );

      if (!hasFtsIndex) {
        // LanceDB @lancedb/lancedb >=0.26: use Index.fts() config
        const lancedb = await loadLanceDB();
        await table.createIndex("text", {
          // TODO: type this — LanceDB dynamic import doesn't expose Index type
          config: (lancedb as any).Index.fts(),
        });
      }
    } catch (err) {
      throw new Error(
        `FTS index creation failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  async store(
    entry: Omit<MemoryEntry, "id" | "timestamp">,
  ): Promise<MemoryEntry> {
    await this.ensureInitialized();

    // ── Step 0: Semantic noise gate (before dedup) ──
    if (this.config.semanticGate !== false && this.semanticGateInstance) {
      try {
        const passed = await this.semanticGateInstance.shouldPass(entry.vector, entry.text);
        if (!passed) {
          // Return a synthetic entry with a marker id so callers know it was filtered
          return {
            ...entry,
            id: "__filtered__",
            timestamp: Date.now(),
            metadata: entry.metadata || "{}",
          };
        }
      } catch {
        // Gate failure → pass through
      }
    }

    // ── Step 1: Near-duplicate detection ──
    if (this.config.deduplication !== false && entry.vector && entry.vector.length > 0) {
      try {
        const scopeFilter = entry.scope ? [entry.scope] : undefined;
        const similar = await this.vectorSearch(entry.vector, 3, 0.3, scopeFilter);

        for (const match of similar) {
          // Convert LanceDB distance-based score to cosine similarity
          // vectorSearch returns score = 1 / (1 + distance), so:
          // cosine_similarity ≈ 1 - distance = (2*score - 1) / score  ... but simpler:
          // For cosine distance: similarity = 1 - distance
          // score = 1/(1+d) → d = 1/score - 1 → similarity = 1 - d = 2 - 1/score
          const cosineSim = 2 - 1 / match.score;
          if (cosineSim > DEDUP_SIMILARITY_THRESHOLD) {
            // Duplicate found — update existing entry instead of creating new
            const existingMeta = parseSmartMetadata(match.entry.metadata, match.entry);
            const accessCount = (existingMeta.access_count ?? 0) + 1;

            const updates: {
              text?: string;
              importance?: number;
              metadata?: string;
            } = {};

            // If new text is longer or importance is higher, update
            if (entry.text.length > match.entry.text.length) {
              updates.text = entry.text;
            }
            if (entry.importance > match.entry.importance) {
              updates.importance = entry.importance;
            }

            // Always update accessCount and updatedAt
            const patchedMeta = {
              ...existingMeta,
              access_count: accessCount,
              updatedAt: Date.now(),
            };
            updates.metadata = stringifySmartMetadata(patchedMeta);

            await this.update(match.entry.id, updates, scopeFilter);

            // Return existing entry id so caller knows dedup happened
            return {
              ...match.entry,
              id: match.entry.id,
              timestamp: match.entry.timestamp,
              metadata: updates.metadata,
            };
          }
        }
      } catch {
        // Dedup failure → proceed with normal write
      }
    }

    // ── Step 1b: Conflict detection (mid-similarity range) ──
    // If the new entry is similar but not identical to an existing one,
    // check if it's a contradiction/update and demote the old entry.
    // Search without scope filter to catch conflicts across scopes.
    if (this.config.deduplication !== false && entry.vector && entry.vector.length > 0) {
      try {
        const similar = await this.vectorSearch(entry.vector, 3, 0.3);

        for (const match of similar) {
          const cosineSim = 2 - 1 / match.score;
          if (cosineSim > CONFLICT_SIMILARITY_THRESHOLD && cosineSim <= DEDUP_SIMILARITY_THRESHOLD) {
            // Mid-range similarity: might be a contradiction or update
            // Heuristic: if both texts are about the same topic but have different
            // values/numbers/states, it's likely a contradiction
            const oldText = match.entry.text || "";
            const newText = entry.text || "";

            // Quick contradiction signals:
            // 1. Both mention the same entity but with different numbers
            // 2. Negation patterns (不/没/no/not + similar keywords)
            // 3. New text explicitly says "changed to" / "改成" / "updated"
            // Fast path: regex for explicit update language
            let hasContradictionSignal =
              /改成|变成|更新为|换成|不再|取消了|changed to|updated to|no longer|switched to/i.test(newText) ||
              (oldText.match(/\d+/) && newText.match(/\d+/) && cosineSim > 0.80);

            // Store-level LLM contradiction detection (conservative: cosine > 0.70)
            if (!hasContradictionSignal && this.llmClient && cosineSim > 0.70) {
              try {
                const result = await this.llmClient.completeJson<{ contradiction: boolean }>(
                  `Do these two memories contradict each other? Answer {"contradiction": true} or {"contradiction": false}.\n\nOLD: "${oldText.slice(0, 300)}"\nNEW: "${newText.slice(0, 300)}"`,
                  "contradiction-detect",
                );
                if (result?.contradiction === true) {
                  hasContradictionSignal = true;
                }
              } catch { /* LLM failure: fall back to regex only */ }
            }

            if (hasContradictionSignal) {
              // Audit: record contradiction-based expiration (version history)
              _auditExpire?.(match.entry.id, match.entry.scope || "global", "contradiction",
                `old: "${match.entry.text?.slice(0, 100)}" → new: "${newText.slice(0, 100)}"`);

              // Demote old entry
              const existingMeta = parseSmartMetadata(match.entry.metadata, match.entry);
              const oldImportance = match.entry.importance ?? 0.7;
              existingMeta.expired_at = new Date().toISOString();
              existingMeta.expired_reason = `superseded: ${newText.slice(0, 80)}`;
              existingMeta.tier = "peripheral";
              existingMeta.confidence = Math.max(0.05, (existingMeta.confidence ?? 0.7) * 0.15);
              await this.update(
                match.entry.id,
                {
                  importance: Math.max(0.05, oldImportance * 0.1),
                  metadata: stringifySmartMetadata(existingMeta),
                },
              );

              // Contradiction cascade: demote neighbors of the contradicted memory
              try {
                if (match.entry.vector?.length) {
                  const neighbors = await this.vectorSearch(match.entry.vector, 5, 0.3);
                  for (const neighbor of neighbors) {
                    if (neighbor.entry.id === match.entry.id) continue;
                    const neighborSim = 2 - 1 / neighbor.score;
                    if (neighborSim < 0.80) continue;
                    const neighborMeta = parseSmartMetadata(neighbor.entry.metadata, neighbor.entry);
                    if (neighborMeta.tier === "core" && (neighborMeta.confidence ?? 0.7) > 0.8) continue;
                    neighborMeta.confidence = Math.max(0.1, (neighborMeta.confidence ?? 0.7) * 0.5);
                    await this.update(neighbor.entry.id, {
                      importance: Math.max(0.1, (neighbor.entry.importance ?? 0.7) * 0.5),
                      metadata: stringifySmartMetadata(neighborMeta),
                    });
                  }
                }
              } catch { /* cascade failure is non-critical */ }
            }
          }
        }
      } catch {
        // Conflict check failure → proceed with normal write
      }
    }

    // ── Step 2: Normal write (with WAL for crash recovery) ──
    const fullEntry: MemoryEntry = {
      ...entry,
      id: randomUUID(),
      timestamp: Date.now(),
      metadata: entry.metadata || "{}",
    };

    const walTs = new Date(fullEntry.timestamp).toISOString();

    // WAL: log pending before write (Pro feature)
    if (walAppend) {
      await walAppend({
        ts: walTs,
        action: "write",
        text: fullEntry.text,
        scope: fullEntry.scope || "default",
        category: fullEntry.category || "fact",
        groupId: "lancedb",
        importance: fullEntry.importance ?? 0.7,
        status: "pending",
      }).catch(() => {});
    }

    try {
      if (this._adapter) {
        await this._adapter.add([fullEntry as any]);
      } else {
        await this.table!.add([fullEntry]);
      }
      // WAL: mark committed after successful write
      walMarkCommitted?.(walTs).catch(() => {});
    } catch (err: unknown) {
      // WAL: mark failed
      walMarkFailed?.(walTs, String(err)).catch(() => {});
      const e = err as NodeJS.ErrnoException;
      const code = e.code || "";
      const message = e.message || String(err);
      throw new Error(
        `Failed to store memory in "${this.config.dbPath}": ${code} ${message}`,
      );
    }

    // Audit: record creation
    _auditCreate?.(fullEntry.id, fullEntry.scope, fullEntry.scope, "store", fullEntry.text?.slice(0, 200));

    // ── Step 3: Graphiti 时序图谱双写 ──
    const textLen = (fullEntry.text || "").length;
    const entryImportance = typeof fullEntry.importance === "number" ? fullEntry.importance : 0.7;
    if (process.env.GRAPHITI_ENABLED === "true" && entryImportance >= 0.5 && textLen >= 20) {
      const graphitiBase = process.env.GRAPHITI_BASE_URL || "http://127.0.0.1:18799";
      const scope = fullEntry.scope || "default";
      const groupId = scope.startsWith("agent:") ? scope.split(":")[1] || "default" : "default";
      const graphitiWalTs = `graphiti-${walTs}`;

      // WAL for Graphiti write (separate from LanceDB WAL entry)
      if (walAppend) {
        walAppend({
          ts: graphitiWalTs,
          action: "write",
          text: fullEntry.text,
          scope,
          category: fullEntry.category || "fact",
          groupId,
          importance: entryImportance,
          status: "pending",
        }).catch(() => {});
      }

      fetch(`${graphitiBase}/episodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `[${fullEntry.category || "fact"}] ${fullEntry.text}`,
          group_id: groupId,
          reference_time: walTs,
          source: `lancedb-pro-store-${groupId}`,
          category: fullEntry.category || "fact",
        }),
        signal: AbortSignal.timeout(15000),
      })
        .then(() => {
          walMarkCommitted?.(graphitiWalTs).catch(() => {});
        })
        .catch((err) => {
          walMarkFailed?.(graphitiWalTs, String(err)).catch(() => {});
        });
    }

    return fullEntry;
  }

  /**
   * Import a pre-built entry while preserving its id/timestamp.
   * Used for re-embedding / migration / A/B testing across embedding models.
   * Intentionally separate from `store()` to keep normal writes simple.
   */
  async importEntry(entry: MemoryEntry): Promise<MemoryEntry> {
    await this.ensureInitialized();

    if (!entry.id || typeof entry.id !== "string") {
      throw new Error("importEntry requires a stable id");
    }

    const vector = entry.vector || [];
    if (!Array.isArray(vector) || vector.length !== this.config.vectorDim) {
      throw new Error(
        `Vector dimension mismatch: expected ${this.config.vectorDim}, got ${Array.isArray(vector) ? vector.length : "non-array"}`,
      );
    }

    const full: MemoryEntry = {
      ...entry,
      scope: entry.scope || "global",
      importance: Number.isFinite(entry.importance) ? entry.importance : 0.7,
      timestamp: Number.isFinite(entry.timestamp)
        ? entry.timestamp
        : Date.now(),
      metadata: entry.metadata || "{}",
    };

    await this.table!.add([full]);
    return full;
  }

  async hasId(id: string): Promise<boolean> {
    await this.ensureInitialized();
    if (this._adapter) {
      const results = await this._adapter.query({ where: `id = '${escapeSqlLiteral(id)}'`, limit: 1 });
      return results.length > 0;
    }
    const safeId = escapeSqlLiteral(id);
    const res = await this.table!.query()
      .select(["id"])
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();
    return res.length > 0;
  }

  async getById(id: string, scopeFilter?: string[]): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    if (this._adapter) {
      const results = await this._adapter.query({ where: `id = '${escapeSqlLiteral(id)}'`, limit: 1 });
      if (results.length === 0) return null;
      const r = results[0];
      return { id: r.id, text: r.text, vector: r.vector, category: r.category as MemoryEntry["category"], scope: r.scope, importance: r.importance, timestamp: r.timestamp, metadata: r.metadata } as MemoryEntry;
    }

    const safeId = escapeSqlLiteral(id);
    const rows = await this.table!
      .query()
      .where(`id = '${safeId}'`)
      .limit(1)
      .toArray();

    if (rows.length === 0) return null;

    const row = rows[0];
    const rowScope = (row.scope as string | undefined) ?? "global";
    if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
      return null;
    }

    return {
      id: row.id as string,
      text: row.text as string,
      vector: Array.from(row.vector as Iterable<number>),
      category: row.category as MemoryEntry["category"],
      scope: rowScope,
      importance: Number(row.importance),
      timestamp: Number(row.timestamp),
      metadata: (row.metadata as string) || "{}",
    };
  }

  async vectorSearch(vector: number[], limit = 5, minScore = 0.3, scopeFilter?: string[]): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // Adapter path: delegate to backend
    if (this._adapter) {
      const results = await this._adapter.vectorSearch(vector, limit, minScore, scopeFilter);
      return results.map(r => ({
        entry: { id: r.record.id, text: r.record.text, vector: r.record.vector, category: r.record.category as MemoryEntry["category"], scope: r.record.scope, importance: r.record.importance, timestamp: r.record.timestamp, metadata: r.record.metadata } as MemoryEntry,
        score: r.score,
      }));
    }

    const safeLimit = clampInt(limit, 1, 20);
    const fetchLimit = Math.min(safeLimit * 10, 200); // Over-fetch for scope filtering

    let query = this.table!.vectorSearch(vector).distanceType('cosine').limit(fetchLimit);

    // Apply scope filter if provided
    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      query = query.where(`(${scopeConditions}) OR scope IS NULL`); // NULL for backward compatibility
    }

    const results = await query.toArray();
    const mapped: MemorySearchResult[] = [];

    for (const row of results) {
      const distance = Number(row._distance ?? 0);
      const score = 1 / (1 + distance);

      if (score < minScore) continue;

      const rowScope = (row.scope as string | undefined) ?? "global";

      // Double-check scope filter in application layer
      if (
        scopeFilter &&
        scopeFilter.length > 0 &&
        !scopeFilter.includes(rowScope)
      ) {
        continue;
      }

      mapped.push({
        entry: {
          id: row.id as string,
          text: row.text as string,
          vector: row.vector as number[],
          category: row.category as MemoryEntry["category"],
          scope: rowScope,
          importance: Number(row.importance),
          timestamp: Number(row.timestamp),
          metadata: (row.metadata as string) || "{}",
        },
        score,
      });

      if (mapped.length >= safeLimit) break;
    }

    return mapped;
  }

  async bm25Search(
    query: string,
    limit = 5,
    scopeFilter?: string[],
  ): Promise<MemorySearchResult[]> {
    await this.ensureInitialized();

    // Adapter path
    if (this._adapter) {
      const results = await this._adapter.fullTextSearch(query, limit, scopeFilter);
      return results.map(r => ({
        entry: { id: r.record.id, text: r.record.text, vector: r.record.vector, category: r.record.category as MemoryEntry["category"], scope: r.record.scope, importance: r.record.importance, timestamp: r.record.timestamp, metadata: r.record.metadata } as MemoryEntry,
        score: r.score,
      }));
    }

    const safeLimit = clampInt(limit, 1, 20);

    if (!this.ftsIndexCreated) {
      return this.lexicalFallbackSearch(query, safeLimit, scopeFilter);
    }

    try {
      // Use FTS query type explicitly
      let searchQuery = this.table!.search(query, "fts").limit(safeLimit);

      // Apply scope filter if provided
      if (scopeFilter && scopeFilter.length > 0) {
        const scopeConditions = scopeFilter
          .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
          .join(" OR ");
        searchQuery = searchQuery.where(
          `(${scopeConditions}) OR scope IS NULL`,
        );
      }

      const results = await searchQuery.toArray();
      const mapped: MemorySearchResult[] = [];

      for (const row of results) {
        const rowScope = (row.scope as string | undefined) ?? "global";

        // Double-check scope filter in application layer
        if (
          scopeFilter &&
          scopeFilter.length > 0 &&
          !scopeFilter.includes(rowScope)
        ) {
          continue;
        }

        // LanceDB FTS _score is raw BM25 (unbounded). Normalize with sigmoid.
        // LanceDB may return BigInt for numeric columns; coerce safely.
        const rawScore = row._score != null ? Number(row._score) : 0;
        const normalizedScore =
          rawScore > 0 ? 1 / (1 + Math.exp(-rawScore / 5)) : 0.5;

        mapped.push({
          entry: {
            id: row.id as string,
            text: row.text as string,
            vector: row.vector as number[],
            category: row.category as MemoryEntry["category"],
            scope: rowScope,
            importance: Number(row.importance),
            timestamp: Number(row.timestamp),
            metadata: (row.metadata as string) || "{}",
          },
          score: normalizedScore,
        });
      }

      if (mapped.length > 0) {
        return mapped;
      }
      return this.lexicalFallbackSearch(query, safeLimit, scopeFilter);
    } catch (err) {
      log.warn("BM25 search failed, falling back to empty results:", err);
      return this.lexicalFallbackSearch(query, safeLimit, scopeFilter);
    }
  }

  private async lexicalFallbackSearch(query: string, limit: number, scopeFilter?: string[]): Promise<MemorySearchResult[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) return [];

    let searchQuery = this.table!.query().select([
      "id",
      "text",
      "vector",
      "category",
      "scope",
      "importance",
      "timestamp",
      "metadata",
    ]);

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map(scope => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      searchQuery = searchQuery.where(`(${scopeConditions}) OR scope IS NULL`);
    }

    const rows = await searchQuery.toArray();
    const matches: MemorySearchResult[] = [];

    for (const row of rows) {
      const rowScope = (row.scope as string | undefined) ?? "global";
      if (scopeFilter && scopeFilter.length > 0 && !scopeFilter.includes(rowScope)) {
        continue;
      }

      const entry: MemoryEntry = {
        id: row.id as string,
        text: row.text as string,
        vector: row.vector as number[],
        category: row.category as MemoryEntry["category"],
        scope: rowScope,
        importance: Number(row.importance),
        timestamp: Number(row.timestamp),
        metadata: (row.metadata as string) || "{}",
      };

      const metadata = parseSmartMetadata(entry.metadata, entry);
      const score = scoreLexicalHit(trimmedQuery, [
        { text: entry.text, weight: 1 },
        { text: metadata.l0_abstract, weight: 0.98 },
        { text: metadata.l1_overview, weight: 0.92 },
        { text: metadata.l2_content, weight: 0.96 },
      ]);

      if (score <= 0) continue;
      matches.push({ entry, score });
    }

    return matches
      .sort((a, b) => b.score - a.score || b.entry.timestamp - a.entry.timestamp)
      .slice(0, limit);
  }

  async delete(id: string, scopeFilter?: string[]): Promise<boolean> {
    await this.ensureInitialized();

    // Support both full UUID and short prefix (8+ hex chars)
    const uuidRegex =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const prefixRegex = /^[0-9a-f]{8,}$/i;
    const isFullId = uuidRegex.test(id);
    const isPrefix = !isFullId && prefixRegex.test(id);

    if (!isFullId && !isPrefix) {
      throw new Error(`Invalid memory ID format: ${id}`);
    }

    let candidates: Record<string, unknown>[];
    if (isFullId) {
      candidates = await this.table!.query()
        .where(`id = '${id}'`)
        .limit(1)
        .toArray();
    } else {
      // Prefix match: fetch candidates and filter in app layer
      const all = await this.table!.query()
        .select(["id", "scope"])
        .limit(1000)
        .toArray();
      candidates = all.filter((r: Record<string, unknown>) => (r.id as string).startsWith(id));
      if (candidates.length > 1) {
        throw new Error(
          `Ambiguous prefix "${id}" matches ${candidates.length} memories. Use a longer prefix or full ID.`,
        );
      }
    }
    if (candidates.length === 0) {
      return false;
    }

    const resolvedId = candidates[0].id as string;
    const rowScope = (candidates[0].scope as string | undefined) ?? "global";

    // Check scope permissions
    if (
      scopeFilter &&
      scopeFilter.length > 0 &&
      !scopeFilter.includes(rowScope)
    ) {
      throw new Error(`Memory ${resolvedId} is outside accessible scopes`);
    }

    // Audit: record deletion with old value for version history
    _auditDelete?.([resolvedId], rowScope, "user-request");

    if (this._adapter) {
      await this._adapter.delete(`id = '${escapeSqlLiteral(resolvedId)}'`);
    } else {
      await this.table!.delete(`id = '${resolvedId}'`);
    }
    return true;
  }

  async list(
    scopeFilter?: string[],
    category?: string,
    limit = 20,
    offset = 0,
  ): Promise<MemoryEntry[]> {
    await this.ensureInitialized();

    let query = this.table!.query();

    // Build where conditions
    const conditions: string[] = [];

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      conditions.push(`((${scopeConditions}) OR scope IS NULL)`);
    }

    if (category) {
      conditions.push(`category = '${escapeSqlLiteral(category)}'`);
    }

    if (conditions.length > 0) {
      query = query.where(conditions.join(" AND "));
    }

    // Fetch all matching rows (no pre-limit) so app-layer sort is correct across full dataset
    const results = await query
      .select([
        "id",
        "text",
        "category",
        "scope",
        "importance",
        "timestamp",
        "metadata",
      ])
      .toArray();

    return results
      .map(
        (row): MemoryEntry => ({
          id: row.id as string,
          text: row.text as string,
          vector: [], // Don't include vectors in list results for performance
          category: row.category as MemoryEntry["category"],
          scope: (row.scope as string | undefined) ?? "global",
          importance: Number(row.importance),
          timestamp: Number(row.timestamp),
          metadata: (row.metadata as string) || "{}",
        }),
      )
      .sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))
      .slice(offset, offset + limit);
  }

  /** Lightweight scoped row count with 60-second TTL cache. */
  private _countCache = new Map<string, { count: number; ts: number }>();
  async countRows(scopeFilter?: string[]): Promise<number> {
    await this.ensureInitialized();
    const cacheKey = scopeFilter ? scopeFilter.sort().join("|") : "__all__";
    const cached = this._countCache.get(cacheKey);
    if (cached && Date.now() - cached.ts < 60_000) return cached.count;

    let query = this.table!.query().select(["id"]);
    if (scopeFilter && scopeFilter.length > 0) {
      const cond = scopeFilter.map(s => `scope = '${escapeSqlLiteral(s)}'`).join(" OR ");
      query = query.where(`((${cond}) OR scope IS NULL)`);
    }
    const rows = await query.toArray();
    const count = rows.length;
    this._countCache.set(cacheKey, { count, ts: Date.now() });
    return count;
  }

  async stats(scopeFilter?: string[]): Promise<{
    totalCount: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
  }> {
    await this.ensureInitialized();

    let query = this.table!.query();

    if (scopeFilter && scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      query = query.where(`((${scopeConditions}) OR scope IS NULL)`);
    }

    const results = await query.select(["scope", "category"]).toArray();

    const scopeCounts: Record<string, number> = {};
    const categoryCounts: Record<string, number> = {};

    for (const row of results) {
      const scope = (row.scope as string | undefined) ?? "global";
      const category = row.category as string;

      scopeCounts[scope] = (scopeCounts[scope] || 0) + 1;
      categoryCounts[category] = (categoryCounts[category] || 0) + 1;
    }

    return {
      totalCount: results.length,
      scopeCounts,
      categoryCounts,
    };
  }

  async update(
    id: string,
    updates: {
      text?: string;
      vector?: number[];
      importance?: number;
      category?: MemoryEntry["category"];
      metadata?: string;
    },
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    await this.ensureInitialized();

    return this.runSerializedUpdate(async () => {
      // Support both full UUID and short prefix (8+ hex chars), same as delete()
      const uuidRegex =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
      const prefixRegex = /^[0-9a-f]{8,}$/i;
      const isFullId = uuidRegex.test(id);
      const isPrefix = !isFullId && prefixRegex.test(id);

      if (!isFullId && !isPrefix) {
        throw new Error(`Invalid memory ID format: ${id}`);
      }

      let rows: Record<string, unknown>[];
      if (isFullId) {
        const safeId = escapeSqlLiteral(id);
        rows = await this.table!.query()
          .where(`id = '${safeId}'`)
          .limit(1)
          .toArray();
      } else {
        // Prefix match
        const all = await this.table!.query()
          .select([
            "id",
            "text",
            "vector",
            "category",
            "scope",
            "importance",
            "timestamp",
            "metadata",
          ])
          .limit(1000)
          .toArray();
        rows = all.filter((r: Record<string, unknown>) => (r.id as string).startsWith(id));
        if (rows.length > 1) {
          throw new Error(
            `Ambiguous prefix "${id}" matches ${rows.length} memories. Use a longer prefix or full ID.`,
          );
        }
      }

      if (rows.length === 0) return null;

      const row = rows[0];
      const rowScope = (row.scope as string | undefined) ?? "global";

      // Check scope permissions
      if (
        scopeFilter &&
        scopeFilter.length > 0 &&
        !scopeFilter.includes(rowScope)
      ) {
        throw new Error(`Memory ${id} is outside accessible scopes`);
      }

      const original: MemoryEntry = {
        id: row.id as string,
        text: row.text as string,
        vector: Array.from(row.vector as Iterable<number>),
        category: row.category as MemoryEntry["category"],
        scope: rowScope,
        importance: Number(row.importance),
        timestamp: Number(row.timestamp),
        metadata: (row.metadata as string) || "{}",
      };

      // Build updated entry, preserving original timestamp
      const updated: MemoryEntry = {
        ...original,
        text: updates.text ?? original.text,
        vector: updates.vector ?? original.vector,
        category: updates.category ?? original.category,
        scope: rowScope,
        importance: updates.importance ?? original.importance,
        timestamp: original.timestamp, // preserve original
        metadata: updates.metadata ?? original.metadata,
      };

      // Audit: record update with old value snapshot (version history)
      _auditUpdate?.(original.id, rowScope, "memory-update",
        JSON.stringify({
          old: { text: original.text?.slice(0, 200), importance: original.importance, category: original.category },
          new: { text: updated.text?.slice(0, 200), importance: updated.importance, category: updated.category },
        })
      );

      // LanceDB doesn't support in-place update; delete + re-add.
      // Serialize updates per store instance to avoid stale rollback races.
      // If the add fails after delete, attempt best-effort recovery without
      // overwriting a newer concurrent successful update.
      const rollbackCandidate =
        (await this.getById(original.id).catch(() => null)) ?? original;
      const resolvedId = escapeSqlLiteral(row.id as string);
      await this.table!.delete(`id = '${resolvedId}'`);
      try {
        await this.table!.add([updated]);
      } catch (addError) {
        const current = await this.getById(original.id).catch(() => null);
        if (current) {
          throw new Error(
            `Failed to update memory ${id}: write failed after delete, but an existing record was preserved. ` +
            `Write error: ${addError instanceof Error ? addError.message : String(addError)}`,
          );
        }

        try {
          await this.table!.add([rollbackCandidate]);
        } catch (rollbackError) {
          throw new Error(
            `Failed to update memory ${id}: write failed after delete, and rollback also failed. ` +
            `Write error: ${addError instanceof Error ? addError.message : String(addError)}. ` +
            `Rollback error: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }

        throw new Error(
          `Failed to update memory ${id}: write failed after delete, latest available record restored. ` +
          `Write error: ${addError instanceof Error ? addError.message : String(addError)}`,
        );
      }

      return updated;
    });
  }

  private async runSerializedUpdate<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.updateQueue;
    let release: (() => void) | undefined;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.updateQueue = previous.then(() => lock);

    await previous;
    try {
      return await action();
    } finally {
      release?.();
    }
  }

  async patchMetadata(
    id: string,
    patch: MetadataPatch,
    scopeFilter?: string[],
  ): Promise<MemoryEntry | null> {
    const existing = await this.getById(id, scopeFilter);
    if (!existing) return null;

    const metadata = buildSmartMetadata(existing, patch);
    return this.update(
      id,
      { metadata: stringifySmartMetadata(metadata) },
      scopeFilter,
    );
  }

  async bulkDelete(scopeFilter: string[], beforeTimestamp?: number): Promise<number> {
    await this.ensureInitialized();

    const conditions: string[] = [];

    if (scopeFilter.length > 0) {
      const scopeConditions = scopeFilter
        .map((scope) => `scope = '${escapeSqlLiteral(scope)}'`)
        .join(" OR ");
      conditions.push(`(${scopeConditions})`);
    }

    if (beforeTimestamp) {
      conditions.push(`timestamp < ${beforeTimestamp}`);
    }

    if (conditions.length === 0) {
      throw new Error(
        "Bulk delete requires at least scope or timestamp filter for safety",
      );
    }

    const whereClause = conditions.join(" AND ");

    // Count first
    const countResults = await this.table!.query().where(whereClause).toArray();
    const deleteCount = countResults.length;

    // Then delete
    if (deleteCount > 0) {
      await this.table!.delete(whereClause);
    }

    return deleteCount;
  }

  /** Last FTS error for diagnostics */
  private _lastFtsError: string | null = null;

  get lastFtsError(): string | null {
    return this._lastFtsError;
  }

  /** Get FTS index health status */
  getFtsStatus(): { available: boolean; lastError: string | null } {
    return {
      available: this.ftsIndexCreated,
      lastError: this._lastFtsError,
    };
  }

  /** Rebuild FTS index (drops and recreates). Useful for recovery after corruption. */
  async rebuildFtsIndex(): Promise<{ success: boolean; error?: string }> {
    await this.ensureInitialized();
    try {
      // Drop existing FTS index if any
      const indices = await this.table!.listIndices();
      for (const idx of indices) {
        if (idx.indexType === "FTS" || idx.columns?.includes("text")) {
          try {
            // TODO: type this — LanceDB index type lacks .name property in typings
            await this.table!.dropIndex((idx as any).name || "text");
          } catch (err) {
            // TODO: type this — LanceDB index type lacks .name property in typings
            log.warn(`dropIndex(${(idx as any).name || "text"}) failed:`, err);
          }
        }
      }
      // Recreate
      await this.createFtsIndex(this.table!);
      this.ftsIndexCreated = true;
      this._lastFtsError = null;
      return { success: true };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._lastFtsError = msg;
      this.ftsIndexCreated = false;
      return { success: false, error: msg };
    }
  }
}

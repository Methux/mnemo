// SPDX-License-Identifier: MIT
/**
 * Mnemo Core — simplified entry point
 *
 * Three ways to create an instance:
 *   1. Auto-detect:  createMnemo({ dbPath: './db' })
 *   2. Preset:       createMnemo({ preset: 'ollama', dbPath: './db' })
 *   3. Full config:  createMnemo({ embedding: { ... }, dbPath: './db' })
 */

import { MemoryStore } from "./store.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
import { Embedder } from "./embedder.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "./decay-engine.js";
import { log } from "./logger.js";

/** Memory category — controls how memories are classified and retrieved. */
export type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other" | "reflection";

/** Supported storage backends. LanceDB is the default (embedded, zero-config). */
export type StorageBackend = "lancedb" | "qdrant" | "chroma" | "pgvector";

/** Built-in provider presets — no need to look up URLs, models, or dimensions. */
export type EmbeddingPreset = "openai" | "ollama" | "voyage" | "jina";

// ── Presets ──

const EMBEDDING_PRESETS: Record<EmbeddingPreset, {
  apiKeyEnv: string;
  baseURL?: string;
  model: string;
  dimensions: number;
  fallbackApiKey?: string;
}> = {
  openai: {
    apiKeyEnv: "OPENAI_API_KEY",
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  ollama: {
    apiKeyEnv: "OLLAMA_API_KEY",
    baseURL: "http://localhost:11434/v1",
    model: "bge-m3",
    dimensions: 1024,
    fallbackApiKey: "ollama",
  },
  voyage: {
    apiKeyEnv: "VOYAGE_API_KEY",
    baseURL: "https://api.voyageai.com/v1",
    model: "voyage-4",
    dimensions: 1024,
  },
  jina: {
    apiKeyEnv: "JINA_API_KEY",
    baseURL: "https://api.jina.ai/v1",
    model: "jina-embeddings-v3",
    dimensions: 1024,
  },
};

export interface MnemoConfig {
  /**
   * Quick setup — use a preset instead of manually configuring embedding.
   * Presets: "openai", "ollama", "voyage", "jina"
   *
   * With a preset, you only need to set the corresponding env var:
   *   - "openai" → OPENAI_API_KEY
   *   - "ollama" → no key needed (auto-detects local Ollama)
   *   - "voyage" → VOYAGE_API_KEY
   *   - "jina"   → JINA_API_KEY
   *
   * Or omit both `preset` and `embedding` for auto-detection
   * (checks OPENAI_API_KEY → Ollama → error).
   */
  preset?: EmbeddingPreset;

  /** Manual embedding configuration. Overrides preset. */
  embedding?: {
    /** Currently only "openai-compatible" is supported (works with OpenAI, Ollama, Voyage, etc.) */
    provider: "openai-compatible";
    /** API key for the embedding provider. Use "ollama" for local Ollama. */
    apiKey: string;
    /** Base URL for the embedding API. */
    baseURL?: string;
    /** Embedding model name. */
    model?: string;
    /** Embedding vector dimensions. */
    dimensions?: number;
    /** Task prefix for query embeddings (provider-specific). */
    taskQuery?: string;
    /** Task prefix for passage embeddings (provider-specific). */
    taskPassage?: string;
  };

  /** Path to the local database directory. */
  dbPath: string;

  /** Weibull decay model configuration. */
  decay?: {
    /** Half-life in days for the recency decay curve. Default: 30. */
    recencyHalfLifeDays?: number;
    /** Weight of recency in the composite score. Default: 0.5. */
    recencyWeight?: number;
    /** Weight of access frequency in the composite score. Default: 0.3. */
    frequencyWeight?: number;
    /** Weight of intrinsic importance in the composite score. Default: 0.2. */
    intrinsicWeight?: number;
  };

  /** Memory tier promotion thresholds. */
  tier?: {
    coreAccessThreshold?: number;
    coreImportanceThreshold?: number;
    peripheralAgeDays?: number;
  };

  /** LLM configuration for smart extraction and contradiction detection. */
  llm?: {
    model?: string;
    baseURL?: string;
    apiKey?: string;
  };

  /** Retrieval pipeline configuration. */
  retrieval?: {
    /** Number of candidates before reranking. Default: 20. */
    candidatePoolSize?: number;
    /** Reranking strategy. Default: "none". */
    rerank?: "cross-encoder" | "lightweight" | "none";
    /** API key for the reranker provider. */
    rerankApiKey?: string;
    /** Reranker model name. */
    rerankModel?: string;
    /** Reranker API endpoint. */
    rerankEndpoint?: string;
    /** Reranker provider. */
    rerankProvider?: string;
  };

  /** Storage backend. Default: "lancedb" (embedded, zero-config). */
  storageBackend?: StorageBackend;
  /** Backend-specific config (e.g., { url: "http://localhost:6333" } for Qdrant). */
  storageConfig?: Record<string, unknown>;
}

export interface MnemoInstance {
  /** Store a memory. Returns the generated memory ID. */
  store(entry: {
    /** The text content to remember. */
    text: string;
    /** Memory category. Default: "fact". */
    category?: MemoryCategory;
    /** Importance score from 0.0 to 1.0. Default: 0.7. */
    importance?: number;
    /** Scope for multi-agent isolation. Default: "global". */
    scope?: string;
  }): Promise<{ id: string }>;

  /** Recall memories by semantic search. Returns ranked results with scores. */
  recall(query: string, options?: {
    /** Maximum number of results. Default: 5. */
    limit?: number;
    /** Only return memories from these scopes. */
    scopeFilter?: string[];
    /** Only return memories of this category. */
    category?: MemoryCategory;
  }): Promise<Array<{
    text: string;
    score: number;
    category: string;
    importance: number;
    timestamp: number;
  }>>;

  /** Delete a memory by ID. Returns true if deleted, false if not found. */
  delete(id: string): Promise<boolean>;

  /** Get memory store statistics. */
  stats(): Promise<{
    totalEntries: number;
    scopeCounts: Record<string, number>;
    categoryCounts: Record<string, number>;
  }>;

  /** Close the instance and release resources. */
  close(): Promise<void>;
}

/**
 * Resolve embedding config from preset, explicit config, or auto-detection.
 */
function resolveEmbedding(config: MnemoConfig): {
  apiKey: string;
  baseURL?: string;
  model: string;
  dimensions: number;
  taskQuery?: string;
  taskPassage?: string;
} {
  // Priority 1: Explicit embedding config
  if (config.embedding) {
    if (!config.embedding.apiKey) {
      throw new Error(
        "mnemo: config.embedding.apiKey is required.\n" +
        "Tip: use a preset instead — createMnemo({ preset: 'openai', dbPath: './db' })"
      );
    }
    return {
      apiKey: config.embedding.apiKey,
      baseURL: config.embedding.baseURL,
      model: config.embedding.model || "text-embedding-3-small",
      dimensions: config.embedding.dimensions || 1024,
      taskQuery: config.embedding.taskQuery,
      taskPassage: config.embedding.taskPassage,
    };
  }

  // Priority 2: Named preset
  if (config.preset) {
    const preset = EMBEDDING_PRESETS[config.preset];
    if (!preset) {
      throw new Error(
        `mnemo: unknown preset "${config.preset}". ` +
        `Available: ${Object.keys(EMBEDDING_PRESETS).join(", ")}`
      );
    }
    const apiKey = process.env[preset.apiKeyEnv] || preset.fallbackApiKey;
    if (!apiKey) {
      throw new Error(
        `mnemo: preset "${config.preset}" requires ${preset.apiKeyEnv} environment variable`
      );
    }
    return {
      apiKey,
      baseURL: preset.baseURL,
      model: preset.model,
      dimensions: preset.dimensions,
    };
  }

  // Priority 3: Auto-detect
  // Check OPENAI_API_KEY first (most common)
  if (process.env.OPENAI_API_KEY) {
    log.info("[mnemo] Auto-detected OPENAI_API_KEY → using OpenAI embeddings");
    const p = EMBEDDING_PRESETS.openai;
    return { apiKey: process.env.OPENAI_API_KEY, baseURL: p.baseURL, model: p.model, dimensions: p.dimensions };
  }

  // Check if Ollama is likely available
  if (process.env.OLLAMA_HOST || process.env.OLLAMA_API_KEY) {
    log.info("[mnemo] Auto-detected Ollama → using local embeddings");
    const p = EMBEDDING_PRESETS.ollama;
    const baseURL = process.env.OLLAMA_HOST
      ? `${process.env.OLLAMA_HOST.replace(/\/$/, "")}/v1`
      : p.baseURL;
    return { apiKey: "ollama", baseURL, model: p.model, dimensions: p.dimensions };
  }

  // Check other providers
  if (process.env.VOYAGE_API_KEY) {
    log.info("[mnemo] Auto-detected VOYAGE_API_KEY → using Voyage embeddings");
    const p = EMBEDDING_PRESETS.voyage;
    return { apiKey: process.env.VOYAGE_API_KEY, baseURL: p.baseURL, model: p.model, dimensions: p.dimensions };
  }
  if (process.env.JINA_API_KEY) {
    log.info("[mnemo] Auto-detected JINA_API_KEY → using Jina embeddings");
    const p = EMBEDDING_PRESETS.jina;
    return { apiKey: process.env.JINA_API_KEY, baseURL: p.baseURL, model: p.model, dimensions: p.dimensions };
  }

  throw new Error(
    "mnemo: no embedding provider configured.\n\n" +
    "Options:\n" +
    "  1. Set OPENAI_API_KEY env var (auto-detected)\n" +
    "  2. Use a preset:   createMnemo({ preset: 'ollama', dbPath: './db' })\n" +
    "  3. Full config:    createMnemo({ embedding: { provider: 'openai-compatible', apiKey: '...', model: '...' }, dbPath: './db' })\n\n" +
    "Available presets: openai, ollama, voyage, jina\n" +
    "Docs: https://docs.m-nemo.ai/guide/configuration"
  );
}

/**
 * Create a Mnemo memory instance.
 *
 * @example Auto-detect (uses OPENAI_API_KEY from env)
 * ```typescript
 * const mnemo = await createMnemo({ dbPath: './my-memory-db' });
 * ```
 *
 * @example Preset (zero-config Ollama)
 * ```typescript
 * const mnemo = await createMnemo({ preset: 'ollama', dbPath: './db' });
 * ```
 *
 * @example Full config
 * ```typescript
 * const mnemo = await createMnemo({
 *   embedding: {
 *     provider: "openai-compatible",
 *     apiKey: process.env.OPENAI_API_KEY,
 *     model: "text-embedding-3-small",
 *     dimensions: 1536,
 *   },
 *   dbPath: "./my-memory-db",
 * });
 * ```
 */
export async function createMnemo(config: MnemoConfig): Promise<MnemoInstance> {
  if (!config) throw new Error("mnemo: config is required — see https://docs.m-nemo.ai/guide/quickstart");
  if (!config.dbPath) throw new Error("mnemo: config.dbPath is required — path to local database directory");

  const resolved = resolveEmbedding(config);

  const embedder = new Embedder({
    apiKey: resolved.apiKey,
    baseURL: resolved.baseURL,
    model: resolved.model,
    dimensions: resolved.dimensions,
    taskQuery: resolved.taskQuery,
    taskPassage: resolved.taskPassage,
  });

  const store = new MemoryStore({
    dbPath: config.dbPath,
    vectorDim: resolved.dimensions,
    storageBackend: config.storageBackend,
    storageConfig: config.storageConfig,
  });

  const decayEngine = createDecayEngine({
    ...DEFAULT_DECAY_CONFIG,
    ...(config.decay || {}),
  });

  const retriever = createRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...(config.retrieval || {}),
  }, { decayEngine });

  return {
    async store(entry) {
      const vector = await embedder.embed(entry.text);
      const category = entry.category || "fact";
      const result = await store.store({
        text: entry.text,
        vector,
        category: category as "preference" | "fact" | "decision" | "entity" | "other" | "reflection",
        importance: entry.importance ?? 0.7,
        scope: entry.scope || "global",
      });
      return { id: result.id };
    },

    async recall(query, options = {}) {
      const results = await retriever.retrieve({
        query,
        limit: options.limit ?? 5,
        scopeFilter: options.scopeFilter,
        category: options.category,
        source: "manual",
      });
      return results.map(r => ({
        text: r.entry.text,
        score: r.score,
        category: r.entry.category || "fact",
        importance: r.entry.importance ?? 0.7,
        timestamp: r.entry.timestamp ?? Date.now(),
      }));
    },

    async delete(id: string) {
      return store.delete(id);
    },

    async stats() {
      const s = await store.stats();
      return {
        totalEntries: s.totalCount,
        scopeCounts: s.scopeCounts,
        categoryCounts: s.categoryCounts,
      };
    },

    async close() {
      if (store.adapter) {
        try { await store.adapter.close(); } catch {}
      }
    },
  };
}

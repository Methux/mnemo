// SPDX-License-Identifier: MIT
/**
 * Mnemo Core — simplified entry point
 * Usage: const mnemo = await createMnemo(config)
 */

import { MemoryStore } from "./store.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
import { Embedder } from "./embedder.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "./decay-engine.js";

/** Memory category — controls how memories are classified and retrieved. */
export type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other" | "reflection";

/** Supported storage backends. LanceDB is the default (embedded, zero-config). */
export type StorageBackend = "lancedb" | "qdrant" | "chroma" | "pgvector";

export interface MnemoConfig {
  /** Embedding provider configuration. */
  embedding: {
    /** Currently only "openai-compatible" is supported (works with OpenAI, Ollama, Voyage, etc.) */
    provider: "openai-compatible";
    /** API key for the embedding provider. Use "ollama" for local Ollama. */
    apiKey: string;
    /** Base URL for the embedding API. Default: OpenAI. Use "http://localhost:11434/v1" for Ollama. */
    baseURL?: string;
    /** Embedding model name. Default: "text-embedding-3-small". */
    model?: string;
    /** Embedding vector dimensions. Default: 1024. */
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
 * Create a Mnemo memory instance.
 *
 * @example
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
 *
 * await mnemo.store({ text: "User prefers dark mode", category: "preference" });
 * const results = await mnemo.recall("UI preferences");
 * ```
 */
export async function createMnemo(config: MnemoConfig): Promise<MnemoInstance> {
  if (!config) throw new Error("mnemo: config is required — see https://github.com/Methux/mnemo#quick-start");
  if (!config.embedding) throw new Error("mnemo: config.embedding is required");
  if (!config.embedding.apiKey) throw new Error("mnemo: config.embedding.apiKey is required (use 'ollama' for local Ollama)");
  if (!config.dbPath) throw new Error("mnemo: config.dbPath is required — path to local database directory");

  const dimensions = config.embedding.dimensions || 1024;

  const embedder = new Embedder({
    apiKey: config.embedding.apiKey,
    baseURL: config.embedding.baseURL,
    model: config.embedding.model || "text-embedding-3-small",
    dimensions,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
  });

  const store = new MemoryStore({
    dbPath: config.dbPath,
    vectorDim: dimensions,
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

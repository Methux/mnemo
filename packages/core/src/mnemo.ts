/**
 * Mnemo Core — simplified entry point
 * Usage: const mnemo = await createMnemo(config)
 */

import { MemoryStore } from "./store.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "./retriever.js";
import { Embedder } from "./embedder.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "./decay-engine.js";
import { SmartExtractor } from "./smart-extractor.js";
import { createLlmClient } from "./llm-client.js";

export interface MnemoConfig {
  embedding: {
    provider: "openai-compatible";
    apiKey: string;
    baseURL?: string;
    model?: string;
    dimensions?: number;
    taskQuery?: string;
    taskPassage?: string;
  };
  dbPath: string;
  decay?: {
    recencyHalfLifeDays?: number;
    recencyWeight?: number;
    frequencyWeight?: number;
    intrinsicWeight?: number;
  };
  tier?: {
    coreAccessThreshold?: number;
    coreImportanceThreshold?: number;
    peripheralAgeDays?: number;
  };
  llm?: {
    model?: string;
    baseURL?: string;
    apiKey?: string;
  };
  retrieval?: {
    candidatePoolSize?: number;
    rerank?: "cross-encoder" | "lightweight" | "none";
    rerankApiKey?: string;
    rerankModel?: string;
    rerankEndpoint?: string;
    rerankProvider?: string;
  };
}

export interface MnemoInstance {
  store(entry: {
    text: string;
    category?: string;
    importance?: number;
    scope?: string;
  }): Promise<{ id: string }>;

  recall(query: string, options?: {
    limit?: number;
    scopeFilter?: string[];
    category?: string;
  }): Promise<Array<{
    text: string;
    score: number;
    category: string;
    importance: number;
    timestamp: number;
  }>>;

  stats(): Promise<{ totalEntries: number }>;

  close(): Promise<void>;
}

export async function createMnemo(config: MnemoConfig): Promise<MnemoInstance> {
  const embedder = new Embedder({
    apiKey: config.embedding.apiKey,
    baseURL: config.embedding.baseURL,
    model: config.embedding.model || "voyage-3-large",
    dimensions: config.embedding.dimensions || 1024,
    taskQuery: config.embedding.taskQuery,
    taskPassage: config.embedding.taskPassage,
  });

  const store = new MemoryStore({
    dbPath: config.dbPath,
    embedder,
  });

  await store.initialize();

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
      const result = await store.store({
        text: entry.text,
        vector,
        category: entry.category || "fact",
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

    async stats() {
      const count = await store.count();
      return { totalEntries: count };
    },

    async close() {
      // LanceDB handles cleanup automatically
    },
  };
}

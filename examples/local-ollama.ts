/**
 * Mnemo — 100% Local Setup with Ollama ($0/mo)
 *
 * Prerequisites:
 *   1. Install Ollama: https://ollama.com
 *   2. Pull models:
 *      ollama pull bge-m3
 *      ollama pull qwen3:8b
 *      ollama pull bge-reranker-v2-m3
 *   3. npm install @mnemoai/core
 *
 * No API keys needed. Everything runs locally.
 */

import { createMnemo } from "@mnemoai/core";

async function main() {
  const mnemo = await createMnemo({
    // Ollama embedding — runs locally, 1024 dimensions
    embedding: {
      provider: "openai-compatible",
      apiKey: "ollama", // Ollama doesn't need a real key
      baseURL: "http://127.0.0.1:11434/v1",
      model: "bge-m3",
      dimensions: 1024,
    },
    dbPath: "./local-memory-db",

    // Ollama LLM for smart extraction
    llm: {
      model: "qwen3:8b",
      baseURL: "http://127.0.0.1:11434/v1",
      apiKey: "ollama",
    },

    // Ollama reranker — local cross-encoder
    retrieval: {
      rerank: "cross-encoder",
      rerankProvider: "ollama",
      rerankModel: "bge-reranker-v2-m3",
      // endpoint auto-set to http://127.0.0.1:11434/api/rerank
    },
  });

  // Store and recall — same API as cloud version
  await mnemo.store({
    text: "Local memories are free and private",
    category: "fact",
    importance: 0.9,
  });

  const results = await mnemo.recall("privacy");
  console.log("Results:", results.length);
  // Full Weibull decay, triple-path retrieval, reranking — all local!
}

main().catch(console.error);

/**
 * Mnemo — Basic Usage Example
 *
 * Prerequisites:
 *   npm install @mnemoai/core
 *   export VOYAGE_API_KEY=pa-your-key
 */

import { createMnemo } from "@mnemoai/core";

async function main() {
  // Initialize Mnemo with Voyage embeddings
  const mnemo = await createMnemo({
    embedding: {
      provider: "openai-compatible",
      apiKey: process.env.VOYAGE_API_KEY!,
      baseURL: "https://api.voyageai.com/v1",
      model: "voyage-4",
      dimensions: 1024,
    },
    dbPath: "./my-memory-db",
  });

  // Store memories — Mnemo auto-classifies and assigns importance
  await mnemo.store({
    text: "User prefers dark mode and minimal UI",
    category: "preference",
    importance: 0.8,
  });

  await mnemo.store({
    text: "Project deadline is March 30th",
    category: "fact",
    importance: 0.9,
  });

  await mnemo.store({
    text: "Team decided to use TypeScript for the backend",
    category: "decision",
    importance: 0.7,
  });

  // Recall — triple-path retrieval (Vector + BM25 + Graph)
  // with cross-encoder rerank and Weibull decay
  const results = await mnemo.recall("UI preferences", { limit: 5 });

  for (const r of results) {
    console.log(`[${r.score.toFixed(3)}] ${r.entry.text}`);
    // Weibull decay means:
    //   - Core memories (high importance + frequent recall) barely decay
    //   - Peripheral memories (low importance) fade within days
    //   - Working memories follow standard exponential decay
  }
}

main().catch(console.error);

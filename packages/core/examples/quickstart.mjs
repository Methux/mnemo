/**
 * Mnemo Quickstart — store and recall memories in 10 lines
 *
 * Prerequisites:
 *   npm install @mnemoai/core
 *
 * Usage with OpenAI:
 *   OPENAI_API_KEY=sk-... node quickstart.mjs
 *
 * Usage with Ollama (free, local):
 *   ollama pull nomic-embed-text
 *   node quickstart.mjs --ollama
 */

import { createMnemo } from "@mnemoai/core";

const useOllama = process.argv.includes("--ollama");

const mnemo = await createMnemo({
  embedding: {
    provider: "openai-compatible",
    apiKey: useOllama ? "ollama" : process.env.OPENAI_API_KEY,
    baseURL: useOllama ? "http://localhost:11434/v1" : "https://api.openai.com/v1",
    model: useOllama ? "nomic-embed-text" : "text-embedding-3-small",
    dimensions: useOllama ? 768 : 1536,
  },
  dbPath: "./my-memory-db",
});

// Store some memories
await mnemo.store({ text: "User prefers dark mode", category: "preference" });
await mnemo.store({ text: "User is a software engineer at Acme Corp", category: "fact" });
await mnemo.store({ text: "User decided to use TypeScript for the new project", category: "decision" });

console.log("Stored 3 memories");

// Recall relevant memories
const results = await mnemo.recall("What does the user do for work?");
console.log("\nRecall results:");
for (const r of results) {
  console.log(`  [${r.score.toFixed(2)}] ${r.text}`);
}

// Check stats
const stats = await mnemo.stats();
console.log(`\nTotal memories: ${stats.totalEntries}`);

await mnemo.close();

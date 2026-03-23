/**
 * Mnemo — Using a custom storage backend (Qdrant, Chroma, PGVector)
 *
 * Prerequisites:
 *   npm install @mnemoai/core
 *   # Plus the backend driver:
 *   npm install @qdrant/js-client-rest   # for Qdrant
 *   npm install chromadb                  # for Chroma
 *   npm install pg                        # for PGVector
 */

import { createMnemo } from "@mnemoai/core";

// ── Option A: Qdrant ──
const mnemoQdrant = await createMnemo({
  embedding: {
    provider: "openai-compatible",
    apiKey: process.env.OPENAI_API_KEY,
    model: "text-embedding-3-small",
    dimensions: 1536,
  },
  dbPath: "./qdrant-memories",
  storageBackend: "qdrant",
  storageConfig: {
    url: "http://localhost:6333",
    collectionName: "memories",
  },
});

// ── Option B: PGVector ──
// const mnemoPg = await createMnemo({
//   embedding: { ... },
//   dbPath: "./pg-memories",
//   storageBackend: "pgvector",
//   storageConfig: {
//     connectionString: "postgresql://user:pass@localhost:5432/mydb",
//   },
// });

// ── Option C: Chroma ──
// const mnemoChroma = await createMnemo({
//   embedding: { ... },
//   dbPath: "./chroma-memories",
//   storageBackend: "chroma",
//   storageConfig: {
//     url: "http://localhost:8000",
//     collectionName: "memories",
//   },
// });

await mnemoQdrant.store({ text: "Stored in Qdrant!" });
const results = await mnemoQdrant.recall("What was stored?");
console.log(results);
await mnemoQdrant.close();

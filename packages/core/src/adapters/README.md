# Storage Adapters

Mnemo supports pluggable storage backends via the `StorageAdapter` interface.

## Available Adapters

| Adapter | Status | BM25/FTS | Install | Best For |
|---------|--------|----------|---------|----------|
| **LanceDB** | Stable (default) | Built-in | — | Embedded, edge, single-node |
| **Qdrant** | Stable | No (vector only) | `npm i @qdrant/js-client-rest` | High-perf filtering, Rust speed |
| **Chroma** | Stable | Yes (queryTexts) | `npm i chromadb` | Prototyping, Python ecosystem |
| **PGVector** | Stable | Yes (pg tsvector) | `npm i pg pgvector` | Existing Postgres, full SQL |
| Weaviate | Planned | — | — | Hybrid search, GraphQL |
| Milvus | Planned | — | — | Billion-scale, GPU |
| Pinecone | Planned | — | — | Fully managed SaaS |
| SQLite-vec | Planned | — | — | Ultra-lightweight, edge |

## Quick Start

```typescript
import { createMnemo } from '@mnemoai/core';

// Default — LanceDB (embedded, zero config)
const mnemo = await createMnemo({ storage: 'lancedb' });

// Qdrant (self-hosted or Qdrant Cloud)
const mnemo = await createMnemo({
  storage: 'qdrant',
  storageConfig: { url: 'http://localhost:6333' },
});

// Chroma (embedded or server mode)
const mnemo = await createMnemo({
  storage: 'chroma',
  storageConfig: { url: 'http://localhost:8000' },
});

// PGVector (existing PostgreSQL)
const mnemo = await createMnemo({
  storage: 'pgvector',
  storageConfig: { connectionString: 'postgres://user:pass@localhost:5432/mnemo' },
});
```

## Choosing a Backend

| Scenario | Recommended |
|----------|-------------|
| Getting started / prototyping | **LanceDB** (zero setup) |
| Already running PostgreSQL | **PGVector** (no extra service) |
| Need fastest vector search | **Qdrant** (Rust, HNSW) |
| Python-heavy stack | **Chroma** (pip install) |
| Need BM25 + vector | **LanceDB** or **PGVector** |
| Air-gapped / edge deployment | **LanceDB** (embedded) |

## Creating a Custom Adapter

Implement the `StorageAdapter` interface and register it:

```typescript
import { StorageAdapter, registerAdapter } from '@mnemoai/core/storage-adapter';

class MyAdapter implements StorageAdapter {
  readonly name = 'my-backend';
  async connect(dbPath: string) { /* ... */ }
  async ensureTable(dim: number) { /* ... */ }
  async add(records: MemoryRecord[]) { /* ... */ }
  async vectorSearch(vector, limit, minScore, scopeFilter) { /* ... */ }
  async fullTextSearch(query, limit, scopeFilter) { /* ... */ }
  // ... implement all methods from StorageAdapter
}

registerAdapter('my-backend', () => new MyAdapter());
```

## Interface Reference

See `storage-adapter.ts` for the full `StorageAdapter` interface with JSDoc.

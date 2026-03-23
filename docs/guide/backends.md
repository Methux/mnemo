# Storage Backends

Mnemo supports 4 storage backends. LanceDB is the default — embedded, zero-config, no external services needed.

## LanceDB (Default)

Embedded vector database. No setup required.

```typescript
const mnemo = await createMnemo({
  embedding: { /* ... */ },
  dbPath: './my-memory-db',
  // storageBackend: 'lancedb',  // default, can be omitted
});
```

**Pros:** Zero config, embedded, fast, full BM25 support
**Cons:** Single-process access (no concurrent writers)

## Qdrant

High-performance vector database with filtering.

```bash
# Start Qdrant
docker run -p 6333:6333 qdrant/qdrant

# Install driver
npm install @qdrant/js-client-rest
```

```typescript
const mnemo = await createMnemo({
  embedding: { /* ... */ },
  dbPath: './qdrant-memories',
  storageBackend: 'qdrant',
  storageConfig: {
    url: 'http://localhost:6333',
    collectionName: 'memories',    // optional, default: 'mnemo_memories'
  },
});
```

**Pros:** Production-grade, concurrent access, filtering, cloud-hosted option
**Cons:** Requires running a server, no native BM25

## Chroma

Open-source embedding database.

```bash
# Start Chroma
docker run -p 8000:8000 chromadb/chroma

# Install driver
npm install chromadb
```

```typescript
const mnemo = await createMnemo({
  embedding: { /* ... */ },
  dbPath: './chroma-memories',
  storageBackend: 'chroma',
  storageConfig: {
    url: 'http://localhost:8000',
    collectionName: 'memories',
  },
});
```

**Pros:** Simple, Python ecosystem integration
**Cons:** Requires server, no native BM25

## PGVector

PostgreSQL with vector extensions — use your existing database.

```bash
# Install driver
npm install pg

# Enable pgvector in your PostgreSQL
CREATE EXTENSION vector;
```

```typescript
const mnemo = await createMnemo({
  embedding: { /* ... */ },
  dbPath: './pg-memories',
  storageBackend: 'pgvector',
  storageConfig: {
    connectionString: 'postgresql://user:pass@localhost:5432/mydb',
    tableName: 'memories',         // optional, default: 'mnemo_memories'
  },
});
```

**Pros:** Use existing Postgres, SQL queries, battle-tested
**Cons:** Requires PostgreSQL + pgvector extension

## Comparison

| Backend | Setup | BM25 | Concurrent | Cloud Option |
|---------|-------|------|------------|-------------|
| **LanceDB** | Zero config | ✅ | Single writer | LanceDB Cloud |
| **Qdrant** | Docker/cloud | ❌ | ✅ | Qdrant Cloud |
| **Chroma** | Docker | ❌ | ✅ | — |
| **PGVector** | PostgreSQL | ❌ | ✅ | Any managed PG |

## Custom Adapters

You can register your own storage adapter:

```typescript
import { registerAdapter, type StorageAdapter } from '@mnemoai/core/storage-adapter';

registerAdapter('my-backend', (config) => {
  return {
    // implement StorageAdapter interface
  } as StorageAdapter;
});
```

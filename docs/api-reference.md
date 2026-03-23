# API Reference

## createMnemo(config)

Creates a Mnemo instance.

```typescript
import { createMnemo } from '@mnemoai/core';

const mnemo = await createMnemo({
  embedding: {
    provider: 'openai-compatible',
    apiKey: process.env.OPENAI_API_KEY,  // or 'ollama' for local
    model: 'text-embedding-3-small',
    dimensions: 1536,
  },
  dbPath: './memory-db',
});
```

### Config Options

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `embedding.provider` | `"openai-compatible"` | — | Embedding provider (works with OpenAI, Ollama, Voyage, etc.) |
| `embedding.apiKey` | `string` | — | API key. Use `"ollama"` for local Ollama. |
| `embedding.baseURL` | `string?` | OpenAI | API base URL. `"http://localhost:11434/v1"` for Ollama. |
| `embedding.model` | `string?` | `"text-embedding-3-small"` | Embedding model name. |
| `embedding.dimensions` | `number?` | `1024` | Vector dimensions. |
| `dbPath` | `string` | — | Path to local database directory. |
| `storageBackend` | `"lancedb" \| "qdrant" \| "chroma" \| "pgvector"` | `"lancedb"` | Storage backend. |
| `storageConfig` | `object?` | — | Backend-specific config (e.g., `{ url: "http://localhost:6333" }`). |
| `decay.recencyHalfLifeDays` | `number?` | `30` | Weibull decay half-life in days. |
| `retrieval.rerank` | `"cross-encoder" \| "lightweight" \| "none"` | `"none"` | Reranking strategy. |

## mnemo.store(entry)

Store a memory. Returns `{ id: string }`.

```typescript
const { id } = await mnemo.store({
  text: 'User prefers dark mode',
  category: 'preference',   // "preference" | "fact" | "decision" | "entity" | "other" | "reflection"
  importance: 0.8,           // 0.0 - 1.0 (default: 0.7)
  scope: 'global',           // optional, default: 'global'
});
```

## mnemo.recall(query, options?)

Retrieve memories by semantic search. Returns ranked results with scores.

```typescript
const memories = await mnemo.recall('UI preferences', {
  limit: 5,
  scopeFilter: ['global', 'agent:default'],
  category: 'preference',
});

// Returns: Array<{ text, score, category, importance, timestamp }>
```

## mnemo.delete(id)

Delete a memory by ID. Returns `true` if deleted, `false` if not found.

```typescript
const deleted = await mnemo.delete('mem_abc123');
```

## mnemo.stats()

Get memory store statistics.

```typescript
const { totalEntries, scopeCounts, categoryCounts } = await mnemo.stats();
// totalEntries: 42
// scopeCounts: { global: 30, "agent:bot1": 12 }
// categoryCounts: { fact: 20, preference: 15, decision: 7 }
```

## mnemo.close()

Close the instance and release resources (especially important for non-LanceDB backends).

```typescript
await mnemo.close();
```

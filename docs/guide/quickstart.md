# Quick Start

## Installation

```bash
npm install @mnemoai/core
```

## Basic Usage

```typescript
import { createMnemo } from '@mnemoai/core';

// Auto-detect: uses OPENAI_API_KEY from env
const mnemo = await createMnemo({ dbPath: './my-memory-db' });

// Or use a preset (no config needed):
// const mnemo = await createMnemo({ preset: 'openai', dbPath: './my-memory-db' });
// const mnemo = await createMnemo({ preset: 'ollama', dbPath: './my-memory-db' });

// Store memories
await mnemo.store({ text: 'User prefers dark mode', category: 'preference' });
await mnemo.store({ text: 'User is a backend engineer', category: 'fact' });

// Recall — automatically applies decay, dedup, and ranking
const results = await mnemo.recall('What does the user do?');
for (const r of results) {
  console.log(`[${r.score.toFixed(2)}] ${r.text}`);
}

// Stats
const { totalEntries } = await mnemo.stats();
console.log(`Total memories: ${totalEntries}`);

// Cleanup
await mnemo.close();
```

## Using Ollama ($0, fully local)

No API key needed — see the [Local Setup guide](/guide/ollama).

```typescript
const mnemo = await createMnemo({ preset: 'ollama', dbPath: './my-memory-db' });
```

Or with full config:

```typescript
const mnemo = await createMnemo({
  embedding: {
    provider: 'openai-compatible',
    apiKey: 'ollama',
    baseURL: 'http://localhost:11434/v1',
    model: 'bge-m3',
    dimensions: 1024,
  },
  dbPath: './my-memory-db',
});
```

## Available Presets

| Preset | Provider | Model | Dimensions | Env Var |
|--------|----------|-------|-----------|---------|
| `openai` | OpenAI | text-embedding-3-small | 1536 | `OPENAI_API_KEY` |
| `ollama` | Ollama (local) | bge-m3 | 1024 | none needed |
| `voyage` | Voyage AI | voyage-4 | 1024 | `VOYAGE_API_KEY` |
| `jina` | Jina AI | jina-embeddings-v3 | 1024 | `JINA_API_KEY` |

## Using a Different Backend

```typescript
const mnemo = await createMnemo({
  preset: 'openai',
  dbPath: './my-memory-db',
  storageBackend: 'qdrant',
  storageConfig: { url: 'http://localhost:6333' },
});
```

See [Storage Backends](/guide/backends) for all options.

## Upgrading to Cloud

Mnemo Cloud provides a managed API with adaptive retrieval — no self-hosting required.

```bash
# Register at https://m-nemo.ai and get your API key
curl -X POST https://api.m-nemo.ai/v1/store \
  -H "Authorization: Bearer mn_your_key" \
  -H "Content-Type: application/json" \
  -d '{"text": "User prefers dark mode"}'
```

See [Mnemo Cloud](/pro) for features and pricing.

## Next Steps

- [Local Setup ($0)](/guide/ollama) — Run everything locally with Ollama
- [Configuration](/guide/configuration) — All config options explained
- [API Reference](/api/) — Full API documentation
- [Storage Backends](/guide/backends) — LanceDB, Qdrant, Chroma, PGVector
- [Mnemo Cloud](/pro) — Managed API, adaptive retrieval, zero ops

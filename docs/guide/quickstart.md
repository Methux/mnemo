# Quick Start

## Installation

```bash
npm install @mnemoai/core
```

## Basic Usage

```typescript
import { createMnemo } from '@mnemoai/core';

const mnemo = await createMnemo({
  embedding: {
    provider: 'openai-compatible',
    apiKey: process.env.OPENAI_API_KEY,
    model: 'text-embedding-3-small',
    dimensions: 1536,
  },
  dbPath: './my-memory-db',
});

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
const mnemo = await createMnemo({
  embedding: {
    provider: 'openai-compatible',
    apiKey: 'ollama',
    baseURL: 'http://localhost:11434/v1',
    model: 'nomic-embed-text',
    dimensions: 768,
  },
  dbPath: './my-memory-db',
});
```

## Using a Different Backend

```typescript
const mnemo = await createMnemo({
  embedding: { /* ... */ },
  dbPath: './my-memory-db',
  storageBackend: 'qdrant',
  storageConfig: { url: 'http://localhost:6333' },
});
```

See [Storage Backends](/guide/backends) for all options.

## Next Steps

- [Local Setup ($0)](/guide/ollama) — Run everything locally with Ollama
- [Configuration](/guide/configuration) — All config options explained
- [API Reference](/api/) — Full API documentation
- [Storage Backends](/guide/backends) — LanceDB, Qdrant, Chroma, PGVector

# API Reference

## createMnemo(config)

Creates a Mnemo instance.

```typescript
import { createMnemo } from '@mnemoai/core';

const mnemo = await createMnemo({
  embedding: {
    provider: 'openai-compatible',
    apiKey: process.env.VOYAGE_API_KEY,
    model: 'voyage-3-large',
    dimensions: 1024,
  },
  dbPath: './memory-db',
});
```

## mnemo.store(entry)

Store a memory.

```typescript
const { id } = await mnemo.store({
  text: 'User prefers dark mode',
  category: 'preference',   // profile|preferences|entities|events|cases|patterns
  importance: 0.8,           // 0.0 - 1.0
  scope: 'global',           // optional, default: 'global'
});
```

## mnemo.recall(query, options?)

Retrieve memories by semantic search.

```typescript
const memories = await mnemo.recall('UI preferences', {
  limit: 5,
  scopeFilter: ['global', 'agent:default'],
  category: 'preference',
});

// Returns:
// [{ text, score, category, importance, timestamp }]
```

## mnemo.stats()

Get memory store statistics.

```typescript
const { totalEntries } = await mnemo.stats();
```

## mnemo.close()

Gracefully close the instance.

# @mnemoai/client

Official client for [Mnemo Cloud](https://m-nemo.ai) — long-term memory for AI agents.

## Install

```bash
npm install @mnemoai/client
```

## Quick Start

```javascript
import { createCloudMnemo } from "@mnemoai/client";

const mnemo = createCloudMnemo({ apiKey: "mn_your_key" });

// Store a memory
const { id } = await mnemo.store({
  text: "User is a software engineer who prefers TypeScript",
  category: "fact",
  importance: 0.9,
});

// Recall memories by semantic search
const memories = await mnemo.recall("what does the user do?", { limit: 5 });
memories.forEach(m => console.log(m.text, m.score));

// Delete a memory
await mnemo.delete(id);

// Check usage
const stats = await mnemo.stats();
console.log(stats.totalEntries, "memories stored");
```

## API

### `createCloudMnemo(config)`

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `apiKey` | string | Yes | API key from [Mnemo Cloud](https://api.m-nemo.ai/signup) |
| `endpoint` | string | No | Custom endpoint (default: `https://api.m-nemo.ai`) |

### `mnemo.store(entry)`

Store a memory. Returns `{ id: string }`.

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `text` | string | required | The text to remember |
| `category` | string | `"fact"` | `fact`, `preference`, `decision`, `entity`, `other` |
| `importance` | number | `0.7` | Importance score (0.0–1.0) |
| `scope` | string | `"global"` | Scope for multi-agent isolation |

### `mnemo.recall(query, options?)`

Recall memories by semantic search. Returns array of `{ text, score, category, importance, timestamp }`.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `limit` | number | `5` | Max results |
| `category` | string | — | Filter by category |
| `scopeFilter` | string[] | — | Filter by scopes |

### `mnemo.delete(id)`

Delete a memory by ID. Returns `boolean`.

### `mnemo.stats()`

Returns `{ totalEntries, scopeCounts, categoryCounts, plan }`.

## Requirements

- Node.js 18+ (uses native `fetch`)
- [Mnemo Cloud API key](https://api.m-nemo.ai/signup)

## Links

- [Mnemo Cloud docs](https://m-nemo.ai)
- [Full API reference](https://github.com/Methux/mnemo/blob/main/docs/pro.md)
- [GitHub](https://github.com/Methux/mnemo)

# createMnemo()

Create a Mnemo memory instance.

## Signature

```typescript
function createMnemo(config: MnemoConfig): Promise<MnemoInstance>
```

## Example

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
```

## Parameters

### `config.embedding` (required)

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `provider` | `"openai-compatible"` | — | Provider type |
| `apiKey` | `string` | — | API key (use `"ollama"` for local) |
| `baseURL` | `string?` | OpenAI URL | API endpoint |
| `model` | `string?` | `"text-embedding-3-small"` | Model name |
| `dimensions` | `number?` | `1024` | Vector dimensions |

### `config.dbPath` (required)

Path to the local database directory. Will be created if it doesn't exist.

### `config.storageBackend` (optional)

```typescript
type StorageBackend = "lancedb" | "qdrant" | "chroma" | "pgvector"
```

Default: `"lancedb"` (embedded, zero-config).

### `config.decay` (optional)

See [Weibull Decay](/guide/decay) for details.

### `config.retrieval` (optional)

See [Retrieval Pipeline](/guide/retrieval) for details.

## Errors

| Error | Cause |
|-------|-------|
| `mnemo: config is required` | No config passed |
| `mnemo: config.embedding is required` | Missing embedding config |
| `mnemo: config.embedding.apiKey is required` | Missing API key |
| `mnemo: config.dbPath is required` | Missing database path |

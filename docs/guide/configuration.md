# Configuration

## Three Ways to Configure

```typescript
// 1. Auto-detect (simplest — reads OPENAI_API_KEY from env)
const mnemo = await createMnemo({ dbPath: './db' });

// 2. Preset (one word — openai, ollama, voyage, jina)
const mnemo = await createMnemo({ preset: 'ollama', dbPath: './db' });

// 3. Full config (complete control)
const mnemo = await createMnemo({ embedding: { ... }, dbPath: './db' });
```

## Presets

| Preset | Provider | Model | Dimensions | Env Var | Cost |
|--------|----------|-------|-----------|---------|------|
| `openai` | OpenAI | text-embedding-3-small | 1536 | `OPENAI_API_KEY` | ~$0.02/1K |
| `ollama` | Ollama (local) | bge-m3 | 1024 | none | $0 |
| `voyage` | Voyage AI | voyage-4 | 1024 | `VOYAGE_API_KEY` | ~$0.06/1K |
| `jina` | Jina AI | jina-embeddings-v3 | 1024 | `JINA_API_KEY` | ~$0.02/1K |

## Full Config Reference

```typescript
const mnemo = await createMnemo({
  // Option A: Use a preset
  preset: 'openai',  // or 'ollama', 'voyage', 'jina'

  // Option B: Manual embedding config (overrides preset)
  embedding: {
    provider: 'openai-compatible',
    apiKey: 'sk-...',                    // or 'ollama' for local
    baseURL: 'https://api.openai.com/v1', // optional
    model: 'text-embedding-3-small',      // optional, default
    dimensions: 1536,                     // optional, default: 1024
    taskQuery: 'search_query',            // optional, provider-specific
    taskPassage: 'search_document',       // optional, provider-specific
  },

  // Required: Database path
  dbPath: './my-memory-db',

  // Optional: Storage backend
  storageBackend: 'lancedb',  // 'lancedb' | 'qdrant' | 'chroma' | 'pgvector'
  storageConfig: {},           // backend-specific options

  // Optional: Weibull decay
  decay: {
    recencyHalfLifeDays: 30,   // half-life in days (other weights use optimized defaults)
  },

  // Optional: Memory tiers
  tier: {
    coreAccessThreshold: 5,          // accesses to promote to Core
    coreImportanceThreshold: 0.8,    // importance to promote to Core
    peripheralAgeDays: 90,           // days before demotion to Peripheral
  },

  // Optional: LLM for smart extraction
  llm: {
    model: 'gpt-4.1-mini',
    baseURL: 'https://api.openai.com/v1',
    apiKey: 'sk-...',
  },

  // Optional: Retrieval pipeline
  retrieval: {
    candidatePoolSize: 30,  // candidates before reranking
    rerank: 'none',            // 'cross-encoder' | 'lightweight' | 'none'
    rerankApiKey: '...',
    rerankModel: '...',
    rerankEndpoint: '...',
    rerankProvider: '...',     // 'jina' | 'siliconflow' | 'voyage' | 'ollama'
  },
});
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | Default API key for embedding and LLM |
| `MNEMO_DB_PATH` | Override default database path |
| `MNEMO_CONFIG` | Path to JSON config file |
| `MNEMO_DEBUG` | Enable debug logging |

## Embedding Providers

| Provider | baseURL | Model Example |
|----------|---------|---------------|
| OpenAI | `https://api.openai.com/v1` (default) | `text-embedding-3-small` |
| Ollama | `http://localhost:11434/v1` | `bge-m3` |
| Voyage | `https://api.voyageai.com/v1` | `voyage-4` |
| Jina | `https://api.jina.ai/v1` | `jina-embeddings-v3` |
| Any OpenAI-compatible | Your endpoint | Your model |

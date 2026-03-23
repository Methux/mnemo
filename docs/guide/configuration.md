# Configuration

## Full Config Reference

```typescript
const mnemo = await createMnemo({
  // Required: Embedding provider
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
    recencyHalfLifeDays: 30,   // half-life in days
    recencyWeight: 0.5,        // weight of recency score
    frequencyWeight: 0.3,      // weight of access frequency
    intrinsicWeight: 0.2,      // weight of importance score
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
    candidatePoolSize: 20,
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
| `MNEMO_PRO_KEY` | Pro license key |
| `MNEMO_DEBUG` | Enable debug logging |

## Embedding Providers

| Provider | baseURL | Model Example |
|----------|---------|---------------|
| OpenAI | `https://api.openai.com/v1` (default) | `text-embedding-3-small` |
| Ollama | `http://localhost:11434/v1` | `nomic-embed-text` |
| Voyage | `https://api.voyageai.com/v1` | `voyage-3-large` |
| Jina | `https://api.jina.ai/v1` | `jina-embeddings-v3` |
| Any OpenAI-compatible | Your endpoint | Your model |

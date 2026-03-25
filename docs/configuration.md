# Configuration Reference

## Minimal Config (Core)

```json
{
  "embedding": {
    "provider": "openai-compatible",
    "apiKey": "${VOYAGE_API_KEY}",
    "model": "voyage-4"
  },
  "dbPath": "./memory-db"
}
```

## Recommended Config

See [config/mnemo.example.json](../config/mnemo.example.json) for a full example with all options.

## Config Options

### embedding (required)
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| provider | string | "openai-compatible" | Embedding provider |
| apiKey | string | — | API key (supports `${ENV_VAR}` syntax) |
| baseURL | string | — | API base URL |
| model | string | "voyage-4" | Model name |
| dimensions | integer | 1024 | Vector dimensions |

### decay
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| recencyHalfLifeDays | number | 30 | Half-life for Weibull decay |
| recencyWeight | number | 0.4 | Weight for recency in composite score |
| frequencyWeight | number | 0.3 | Weight for access frequency |
| intrinsicWeight | number | 0.3 | Weight for intrinsic importance |

### tier
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| coreAccessThreshold | integer | 10 | Access count to promote to Core |
| coreImportanceThreshold | number | 0.8 | Importance to promote to Core |
| peripheralAgeDays | integer | 60 | Days before demotion to Peripheral |

### retrieval
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| candidatePoolSize | integer | 20 | Number of candidates per search path |
| rerank | string | "cross-encoder" | Rerank strategy: cross-encoder, lightweight, none |
| rerankApiKey | string | — | API key for reranker |
| rerankProvider | string | "jina" | Provider: jina, voyage, siliconflow, pinecone |

### llm
| Field | Type | Default | Description |
|-------|------|---------|-------------|
| model | string | "gpt-4.1-mini" | LLM for smart extraction |
| baseURL | string | — | API base URL |
| apiKey | string | — | API key |

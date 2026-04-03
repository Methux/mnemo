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
| Field | Type | Description |
|-------|------|-------------|
| recencyHalfLifeDays | number | Half-life for Weibull decay (default: sensible preset) |

Composite score weights and tier transition thresholds use optimized defaults. Mnemo Cloud applies additional adaptive tuning automatically.

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

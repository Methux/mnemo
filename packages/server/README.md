# @mnemoai/server

Mnemo REST API server. Zero dependencies beyond `@mnemoai/core`.

## Quick Start

```bash
npx @mnemoai/server
```

Or with configuration:

```bash
OPENAI_API_KEY=sk-... MNEMO_PORT=8080 npx @mnemoai/server
```

## Endpoints

| Method | Path | Body | Description |
|--------|------|------|-------------|
| `POST` | `/store` | `{ text, category?, importance?, scope? }` | Store a memory |
| `POST` | `/recall` | `{ query, limit?, scopeFilter?, category? }` | Recall memories |
| `DELETE` | `/memories/:id` | — | Delete a memory |
| `GET` | `/stats` | — | Get statistics |
| `GET` | `/health` | — | Health check |

## Examples

```bash
# Store
curl -X POST http://localhost:18100/store \
  -H "Content-Type: application/json" \
  -d '{"text": "User prefers dark mode", "category": "preference"}'

# Recall
curl -X POST http://localhost:18100/recall \
  -H "Content-Type: application/json" \
  -d '{"query": "UI preferences", "limit": 5}'

# Stats
curl http://localhost:18100/stats

# Delete
curl -X DELETE http://localhost:18100/memories/mem_abc123
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `MNEMO_PORT` | `18100` | Server port |
| `MNEMO_DB_PATH` | `./mnemo-data` | Database directory |
| `OPENAI_API_KEY` | — | Embedding API key |
| `MNEMO_EMBEDDING_MODEL` | `text-embedding-3-small` | Embedding model |
| `MNEMO_EMBEDDING_DIMENSIONS` | `1536` | Vector dimensions |
| `MNEMO_EMBEDDING_BASE_URL` | OpenAI | Embedding API URL |
| `MNEMO_STORAGE_BACKEND` | `lancedb` | Storage backend |
| `MNEMO_STORAGE_CONFIG` | — | JSON string for backend config |

## Using with Ollama ($0)

```bash
MNEMO_EMBEDDING_BASE_URL=http://localhost:11434/v1 \
MNEMO_EMBEDDING_MODEL=bge-m3 \
MNEMO_EMBEDDING_DIMENSIONS=1024 \
npx @mnemoai/server
```

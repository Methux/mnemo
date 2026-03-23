# Local Setup ($0 with Ollama)

Run Mnemo entirely on your machine — no API keys, no cloud services, no cost.

## Prerequisites

Install [Ollama](https://ollama.ai) and pull the embedding model:

```bash
ollama pull nomic-embed-text
```

## Usage

```typescript
import { createMnemo } from '@mnemoai/core';

const mnemo = await createMnemo({
  embedding: {
    provider: 'openai-compatible',
    apiKey: 'ollama',                          // any non-empty string works
    baseURL: 'http://localhost:11434/v1',       // Ollama's OpenAI-compatible endpoint
    model: 'nomic-embed-text',
    dimensions: 768,
  },
  dbPath: './local-memory-db',
});

await mnemo.store({ text: 'User likes hiking on weekends' });
const results = await mnemo.recall('hobbies');
```

## Optional: Local LLM for Smart Extraction

For the full pipeline (smart extraction + contradiction detection), also pull an LLM:

```bash
ollama pull qwen3:8b
```

Then configure:

```typescript
const mnemo = await createMnemo({
  embedding: {
    provider: 'openai-compatible',
    apiKey: 'ollama',
    baseURL: 'http://localhost:11434/v1',
    model: 'nomic-embed-text',
    dimensions: 768,
  },
  llm: {
    apiKey: 'ollama',
    baseURL: 'http://localhost:11434/v1',
    model: 'qwen3:8b',
  },
  dbPath: './local-memory-db',
});
```

## Optional: Local Reranker

For cross-encoder reranking without an API:

```bash
ollama pull bge-reranker-v2-m3
```

```typescript
const mnemo = await createMnemo({
  embedding: { /* ... */ },
  retrieval: {
    rerank: 'cross-encoder',
    rerankProvider: 'ollama',
    rerankModel: 'bge-reranker-v2-m3',
    rerankEndpoint: 'http://localhost:11434',
  },
  dbPath: './local-memory-db',
});
```

## Performance

| Component | Model | RAM | Speed |
|-----------|-------|-----|-------|
| Embedding | nomic-embed-text | ~300MB | ~5ms/query |
| LLM | qwen3:8b | ~5GB | ~500ms/extraction |
| Reranker | bge-reranker-v2-m3 | ~1GB | ~50ms/rerank |

All models run on CPU. GPU acceleration available if you have one.

# Comparison

## Feature Comparison

| Capability | Mem0 | Zep | Letta | Cognee | **Mnemo Core** | **Mnemo Pro** |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| Vector search | Yes | Yes | Yes | Yes | Yes | Yes |
| BM25 keyword search | No | No | No | Yes | Yes | Yes |
| Knowledge graph | Paid tier | Yes | No | Yes | Yes | Yes |
| Forgetting model | No | Basic | Basic | No | **Weibull** | **Weibull** |
| Memory tiers | No | No | No | No | Yes | Yes |
| Cross-encoder rerank | No | Basic | No | No | Yes | Yes |
| Contradiction detection | No | Yes | No | Partial | Yes | Yes |
| Triple-path fusion | No | No | No | No | Yes | Yes |
| Scope isolation | Basic | No | No | No | Yes | Yes |
| Self-hosted | Yes | Cloud only | Docker | Yes | Yes | Yes |
| $0 local (Ollama) | No | No | No | No | Yes | Yes |
| TypeScript SDK | Yes | Yes | Yes | No | Yes | Yes |
| Python SDK | Yes | Yes | Yes | Yes | Yes | Yes |

Note: Features and pricing may change. Check each project's official site for current information.

## Architecture Differences

Each framework takes a different approach:

- **Mem0** — Cloud-first SaaS with open-source option. Simple API, large community.
- **Zep** — Built around Graphiti temporal knowledge graph. Optimized for voice AI latency.
- **Letta** — Full agent platform where agents manage their own memory (virtual memory paradigm).
- **Cognee** — Python-first knowledge engine with auto-generated ontologies and pipeline architecture.
- **Mnemo** — Cognitive science-first. Weibull decay, triple-path retrieval, lightweight and embeddable.

## When to Choose Mnemo

- You want intelligent forgetting, not infinite storage
- You need a lightweight, embeddable memory layer (not a full agent platform)
- You want to run locally for free with Ollama
- You care about retrieval quality (triple-path + rerank + decay)
- You're building in TypeScript/Node.js

## Benchmark

See [LOCOMO Benchmark](/guide/benchmark) for retrieval accuracy comparison tested under identical conditions.

# Comparison

## Feature Comparison

| Capability | Mem0 | Zep | Letta | Cognee | **Mnemo Core** | **Mnemo Cloud** |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| Vector search | Yes | Yes | Yes | Yes | Yes | Yes |
| BM25 keyword search | No | Yes | No | Yes | Yes | Yes |
| Knowledge graph | Yes | Yes | No | Yes | Yes | Yes |
| Forgetting model | No | Basic | Agent-managed | No | **Weibull** | **Weibull** |
| Memory tiers | No | No | No | No | Yes | Yes |
| Cross-encoder rerank | Yes | Yes | No | No | Yes | Yes |
| Contradiction detection | Graph layer | Temporal versioning | No | Partial | LLM 3-layer | LLM 3-layer |
| Triple-path fusion | No | No | No | No | Yes | Yes |
| Scope isolation | Basic | No | No | No | Yes | Yes |
| Self-hosted | Yes | CE deprecated | Docker | Yes | Yes | Yes |
| $0 local (Ollama) | Partial | No | Partial | No | Yes | Yes |
| TypeScript SDK | Yes | Yes | Yes | No | Yes | Yes |
| Python SDK | Yes | Yes | Yes | Yes | Yes | Yes |

Note: Features and pricing may change. Check each project's official site for current information. Last verified: April 2026.

## Architecture Differences

Each framework takes a different approach:

- **Mem0** — Cloud-first SaaS with open-source option. Simple API, large community. Graph memory with conflict detection.
- **Zep** — Built around Graphiti temporal knowledge graph. BM25 hybrid search. Community Edition deprecated, cloud-first.
- **Letta** — Full agent platform where agents manage their own memory (virtual memory paradigm). Apache 2.0.
- **Cognee** — Python-first knowledge engine with auto-generated ontologies and pipeline architecture.
- **Mnemo** — Cognitive science-first. Weibull decay, triple-path retrieval, lightweight and embeddable. MIT licensed.

## When to Choose Mnemo

- You want intelligent forgetting, not infinite storage
- You need a lightweight, embeddable memory layer (not a full agent platform)
- You want to run locally for free with Ollama
- You care about retrieval quality (triple-path + rerank + decay)
- You're building in TypeScript/Node.js

## Benchmark

See [LOCOMO Benchmark](/guide/benchmark) for retrieval accuracy comparison tested under identical conditions.

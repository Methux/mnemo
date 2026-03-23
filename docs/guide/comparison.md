# Mnemo vs Competitors

## Feature Comparison

| Capability | Mem0 $249 | Zep (usage) | Letta $20 | Cognee OSS | **Mnemo Core** FREE | **Mnemo Pro** $69 |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| Vector search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| BM25 keyword search | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| Knowledge graph | $249/mo | ✅ | ❌ | ✅ | ✅ | ✅ |
| Forgetting model | ❌ | Basic | Basic | ❌ | **Weibull** | **Weibull** |
| Memory tiers | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Cross-encoder rerank | ❌ | Basic | ❌ | ❌ | ✅ | ✅ |
| Contradiction detection | ❌ | ✅ | ❌ | Partial | ✅ | ✅ |
| Triple-path fusion | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Scope isolation | Basic | ❌ | ❌ | ❌ | ✅ | ✅ |
| Multi-backend | 20+ | Neo4j only | Postgres | 7+ | 4 | 4 |
| Self-hosted | Hard | ❌ | Docker | ✅ | ✅ | ✅ |
| $0 local (Ollama) | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| TypeScript SDK | ✅ | ✅ | ✅ | Partial | ✅ | ✅ |

## Architecture Differences

### Mem0
- Cloud-first SaaS with open-source self-hosted option
- Graph features locked behind $249/mo Pro tier
- 50k+ GitHub stars, largest community
- AWS exclusive memory partner

### Zep
- Built around Graphiti temporal knowledge graph
- Usage-based pricing ($1.25/1K messages)
- Self-hosted Community Edition deprecated
- Requires Neo4j

### Letta (formerly MemGPT)
- Full agent platform, not just memory
- Agents manage their own memory
- Requires running a Letta server
- Heavier adoption cost if you just need memory

### Cognee
- Python-first knowledge engine
- Batch processing (cognify step)
- Best for document-heavy structured data
- TypeScript is secondary

### Mnemo
- **Cognitive science-first** — Weibull decay, not just storage
- **Lightweight** — npm install, 4 lines to start, 142KB
- **Fully local** — Ollama + LanceDB, $0, no cloud
- **Triple-path retrieval** — Vector + BM25 + Graph fused with RRF
- **Multi-backend** — LanceDB, Qdrant, Chroma, PGVector

## When to Choose Mnemo

- You want intelligent forgetting, not infinite storage
- You need a lightweight, embeddable memory layer (not a full agent platform)
- You want to run locally for free with Ollama
- You care about retrieval quality (triple-path + rerank + decay)
- You're building in TypeScript/Node.js

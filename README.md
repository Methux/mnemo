# 🧠 Mnemo

**The first AI memory framework built on cognitive science.**

Weibull forgetting curves · Triple-path retrieval (Vector + BM25 + Knowledge Graph) · 10-stage retrieval pipeline · Tier-based memory lifecycle · Multi-agent scope isolation.

---

## Why Mnemo?

Every AI memory solution stores memories. Mnemo is the first to **forget intelligently**.

Humans don't remember everything equally — important memories consolidate, trivial ones fade, frequently recalled knowledge strengthens. Mnemo models this with a Weibull stretched-exponential decay engine, tier-based lifecycle management, and access reinforcement. The result: your AI agent's memory stays relevant instead of drowning in noise.

### Mnemo vs Others

| Capability | Mem0 | Zep | Letta | **Mnemo Core** | **Mnemo Pro** |
|:---|:---:|:---:|:---:|:---:|:---:|
| Vector retrieval | ✅ | ✅ | ✅ | ✅ | ✅ |
| BM25 keyword search | ❌ | ❌ | ❌ | ✅ | ✅ |
| Knowledge graph | Pro only | ✅ | ❌ | ❌ | ✅ |
| Forgetting model | ❌ | Basic | Basic | **Weibull** | **Weibull** |
| Memory tiers (core/working/peripheral) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Spaced repetition (access reinforcement) | ❌ | ❌ | ❌ | ✅ | ✅ |
| Emotional salience modulation | ❌ | ❌ | ❌ | ✅ | ✅ |
| Cross-encoder rerank | ❌ | Basic | ❌ | ❌ | ✅ |
| Triple-path retrieval (Vec+BM25+Graph) | ❌ | ❌ | ❌ | ❌ | ✅ |
| Multi-channel write (6 channels) | ❌ | ❌ | ❌ | ❌ | ✅ |
| LLM contradiction detection | ❌ | ✅ | ❌ | ❌ | ✅ |
| Multi-agent scope isolation | Basic | ❌ | ❌ | ❌ | ✅ |
| Resonance gating | ❌ | ❌ | ❌ | ❌ | ✅ |
| Temporal query expansion | ❌ | ❌ | ❌ | ❌ | ✅ |
| Price | $99/mo | $199/mo | $29/mo | **Free** | **$49-99/mo** |

---

## Architecture

```
Write Layer (6 channels)
  ① Hook realtime (Sonnet 4)     ④ Daily archive (Claude)
  ② Plugin deep (GPT-4.1)        ⑤ File watcher (Haiku)
  ③ Scheduled L1 distiller        ⑥ Manual memory_store
          │
          ▼
    store.ts unified entry
      ┌────┴────┐
      ▼         ▼
   LanceDB   Graphiti/Neo4j
   (Vec+BM25)  (Knowledge Graph)
          │
          ▼
Retrieval Layer (10-stage pipeline)
  S0  Preprocessing (metadata cleanup)
  S1  Resonance gate (adaptive threshold)
  S2  Multi-hop detection
  S3  Triple-path parallel (Vector + BM25 + Graph)
  S4  RRF fusion (weighted merge)
  S5  Min-score filter
  S6  Cross-encoder rerank (Voyage rerank-2)
  S7  Weibull decay + lifecycle boost
  S8  Length normalization + hard cutoff
  S9  Noise filter + MMR deduplication
  S10 Session dedup + context injection
          │
          ▼
    Top-K → Agent Context

Lifecycle Layer
  Tier classification (core/working/peripheral)
  Weibull decay: exp(-λ·t^β) with tier-specific β
  Access reinforcement (spaced repetition)
  Emotional salience modulation
  Session reflection + overnight consolidation
  Weekly dedup + monthly health review
```

---

## Editions

### Mnemo Core (Free, MIT License)

The open-source foundation. Already more capable than most paid solutions.

- **Storage**: LanceDB hybrid (vector + BM25 full-text search)
- **Embedding**: Any OpenAI-compatible provider (Voyage, OpenAI, Jina, Ollama)
- **Retrieval**: Dual-path (Vector + BM25) with RRF fusion
- **Forgetting**: Weibull stretched-exponential decay with tier-specific β
- **Tiers**: Core (β=0.8) / Working (β=1.0) / Peripheral (β=1.3)
- **Spaced repetition**: Access reinforcement extends half-life
- **Emotional salience**: Amygdala-modeled half-life adjustment
- **Smart extraction**: Single LLM extractor (6 categories, L0/L1/L2 structure)
- **Noise filtering**: Embedding-based noise bank + regex fallback
- **Date expansion**: Temporal query normalization (中/EN)
- **Backup**: Daily JSONL + MD mirror

```bash
npm install @mnemo/core
```

### Mnemo Pro (Commercial License)

Full-stack memory system for production AI agents.

Everything in Core, plus:

- **Knowledge graph**: Graphiti/Neo4j integration with WAL
- **Triple-path retrieval**: Vector + BM25 + Graph with unified cross-encoder rerank
- **6-channel write**: Hook realtime + Plugin deep + L1 distiller + Daily archive + File watcher + Manual
- **Cross-encoder rerank**: Voyage rerank-2 with BM25 preservation floor
- **Resonance gating**: Adaptive threshold auto-recall filter
- **LLM contradiction detection**: 5-class conflict resolution (contradict/update/supplement/duplicate/unrelated)
- **Multi-agent scope isolation**: Per-bot memory with configurable access rules
- **Session reflection**: memoryReflection with inheritance+derived mode
- **Self-improvement**: Before-reset notes + learning file management
- **Cron maintenance**: Overnight consolidation + weekly dedup + monthly health review
- **Observability**: mnemo-doctor health check + config validation gate
- **Temporal queries**: Multi-format date expansion for BM25

### Mnemo Cloud (Coming Soon)

Fully managed SaaS. REST API, dashboard, multi-tenant, auto-scaling.

---

## Quick Start (Core)

### Prerequisites

- Node.js 20+
- An embedding API key (Voyage, OpenAI, or Jina)

### Install

```bash
npm install @mnemo/core
```

### Basic Usage

```typescript
import { createMnemo } from '@mnemo/core';

const mnemo = await createMnemo({
  embedding: {
    provider: 'openai-compatible',
    apiKey: process.env.VOYAGE_API_KEY,
    baseURL: 'https://api.voyageai.com/v1',
    model: 'voyage-3-large',
    dimensions: 1024,
  },
  dbPath: './memory-db',
  decay: {
    recencyHalfLifeDays: 30,
    recencyWeight: 0.4,
    frequencyWeight: 0.3,
    intrinsicWeight: 0.3,
  },
});

// Store
await mnemo.store({
  text: 'User prefers dark mode and minimal UI',
  category: 'preference',
  importance: 0.8,
});

// Recall
const results = await mnemo.recall('UI preferences', { limit: 5 });

// The Weibull decay engine automatically handles:
// - New memories score higher (recency boost)
// - Frequently recalled memories resist forgetting (reinforcement)
// - Core memories barely decay (β=0.8), peripheral ones fade fast (β=1.3)
```

### With OpenClaw

```bash
openclaw plugins install mnemo
```

Mnemo integrates natively with OpenClaw gateway — hooks, cron jobs, and multi-agent scopes are auto-configured.

---

## Cognitive Science Behind Mnemo

Mnemo's design is grounded in established memory research:

| Human Memory Mechanism | Mnemo Implementation |
|:---|:---|
| Ebbinghaus forgetting curve | Weibull decay: `exp(-λ·t^β)` |
| Spaced repetition effect | Access reinforcement extends half-life |
| Memory consolidation (sleep) | Overnight cron consolidation jobs |
| Core vs peripheral memory | Tier system with differential decay rates |
| Spreading activation | Graphiti spread search (1-hop traversal) |
| Amygdala emotional tagging | emotionalSalience modulates half-life |
| Interference effect | MMR deduplication in retrieval |
| Selective attention | Resonance gating + noise bank |
| Metamemory | mnemo-doctor + management tools |

---

## Documentation

- [Architecture Deep Dive](docs/architecture.md)
- [Configuration Reference](docs/configuration.md)
- [Retrieval Pipeline](docs/retrieval-pipeline.md)
- [Cognitive Science Model](docs/cognitive-science.md)
- [OpenClaw Integration](docs/openclaw-integration.md)
- [API Reference](docs/api-reference.md)

---

## License

- **Mnemo Core**: MIT License
- **Mnemo Pro**: Commercial License — [Contact for pricing](mailto:rex@mnemo.ai)

---

## Contributing

We welcome contributions to Mnemo Core! See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

Key areas where we'd love help:
- Benchmark evaluation (LOCOMO, MemBench)
- New embedding provider adapters
- Retrieval pipeline optimizations
- Documentation and examples
- Language-specific SDKs (Python, Go)

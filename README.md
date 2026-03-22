<p align="center">
  <img src="docs/logo.svg" width="80" alt="Mnemo" />
</p>

<h1 align="center">Mnemo</h1>

<p align="center">
  <strong>AI memory that forgets intelligently.</strong><br>
  The first memory framework built on cognitive science.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#core-vs-pro">Core vs Pro</a> ·
  <a href="https://mnemo.dev">Website</a> ·
  <a href="docs/api-reference.md">API</a>
</p>

---

## Why Mnemo?

Every AI memory solution stores memories. **Mnemo is the first to forget intelligently.**

Humans don't remember everything equally — important memories consolidate, trivial ones fade, frequently recalled knowledge strengthens. Mnemo models this with:

- **Weibull decay** — stretched-exponential forgetting: `exp(-(t/λ)^β)` with tier-specific β
- **Triple-path retrieval** — Vector + BM25 + Knowledge Graph fused with RRF
- **Three-layer contradiction detection** — regex signal → LLM 5-class → dedup pipeline
- **10-stage retrieval pipeline** — from preprocessing to context injection

The result: your AI agent's memory stays relevant instead of drowning in noise.

## Mnemo vs Paid Competitors

| Capability | Mem0 $99 | Zep $199 | Letta $29 | Cognee $149 | **Mnemo Core** FREE | **Mnemo Pro** $69 |
|:---|:---:|:---:|:---:|:---:|:---:|:---:|
| Vector search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| BM25 keyword search | ❌ | ❌ | ❌ | ✅ | ✅ | ✅ |
| Knowledge graph | Pro | ✅ | ❌ | ✅ | ✅ | ✅ |
| Forgetting model | ❌ | Basic | Basic | ❌ | **Weibull** | **Weibull** |
| Memory tiers | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Cross-encoder rerank | ❌ | Basic | ❌ | ❌ | ✅ | ✅ |
| Contradiction detection | ❌ | ✅ | ❌ | Partial | ✅ | ✅ |
| Triple-path fusion | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| Scope isolation | Basic | ❌ | ❌ | ❌ | ✅ | ✅ |
| Emotional salience | ❌ | ❌ | ❌ | ❌ | ✅ | ✅ |
| WAL crash recovery | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Session reflection | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Self-improvement | ❌ | ❌ | ❌ | ❌ | ❌ | ✅ |
| Observability | Partial | ✅ | ❌ | ❌ | ❌ | ✅ |
| Self-hosted | ❌ | ❌ | ✅ | ✅ | ✅ | ✅ |

> Mnemo Core (free) already outperforms most $99+/mo paid solutions on retrieval quality.

---

## Architecture

```
┌─────────────── Write Layer (6 channels) ───────────────┐
│  ① Hook realtime       ④ Daily archive extractor       │
│  ② Plugin SmartExtract ⑤ File watcher (fs.watch)       │
│  ③ L1 Distiller (cron) ⑥ Manual memory_store           │
└────────────────────────┬───────────────────────────────┘
                         ▼
              store.ts (dedup + contradiction L1)
                    ┌────┴────┐
                    ▼         ▼
                LanceDB    Graphiti/Neo4j
              (Vec + BM25)  (Knowledge Graph + WAL)

┌─────────────── Retrieval Layer (10 stages) ─────────────┐
│  S0  Preprocessing         S5  Min-score filter         │
│  S1  Resonance gate        S6  Cross-encoder rerank     │
│  S2  Multi-hop detection   S7  Weibull decay            │
│  S3  Triple-path parallel  S8  Hard cutoff + normalize  │
│      (Vector‖BM25‖Graph)   S9  MMR deduplication        │
│  S4  RRF fusion            S10 Session dedup + inject   │
└────────────────────────┬────────────────────────────────┘
                         ▼
                   Top-K → Agent Context

┌─────────────── Lifecycle Layer ─────────────────────────┐
│  Tier classification: Core (β=0.8) → Working (β=1.0)   │
│                        → Peripheral (β=1.3)             │
│  Weibull decay: exp(-(t/λ)^β)                          │
│  Access reinforcement (spaced repetition)               │
│  Emotional salience modulation (up to 1.5×)             │
│  Session reflection + overnight consolidation           │
└─────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Option 1: Docker (recommended)

```bash
git clone https://github.com/Methux/mnemo.git
cd mnemo
cp .env.example .env     # add your API keys
docker compose up -d     # starts Neo4j + Graphiti + Dashboard
```

Dashboard at `http://localhost:18800`

### Option 2: 100% Local ($0, no external API)

```bash
# Install Ollama models
ollama pull nomic-embed-text     # embedding
ollama pull qwen3:8b             # smart extraction LLM
ollama pull bge-reranker-v2-m3   # cross-encoder rerank

# Use local config
cp config/mnemo.local.example.json ~/.mnemo/mnemo.json
docker compose up -d   # Neo4j + Graphiti
```

Full Core functionality — embedding, extraction, rerank, graph — all running locally. Zero API cost.

### Option 3: npm

```bash
npm install @mnemo/core
```

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
});

// Store a memory
await mnemo.store({
  text: 'User prefers dark mode and minimal UI',
  category: 'preference',
  importance: 0.8,
});

// Recall — automatically applies decay, rerank, MMR
const results = await mnemo.recall('UI preferences', { limit: 5 });
```

### Option 4: Interactive Setup

```bash
npm run init    # guided wizard — generates config + .env
```

### Option 5: OpenClaw Plugin

```bash
openclaw plugins install mnemo
```

---

## Core vs Pro

### Mnemo Core — Free, MIT License

The open-source foundation. Full retrieval engine, no restrictions.

| Feature | Details |
|:---|:---|
| Storage | LanceDB hybrid (vector + BM25) |
| Retrieval | Triple-path (Vector + BM25 + Graphiti) with RRF fusion |
| Rerank | Cross-encoder (Voyage rerank-2) |
| Decay | Weibull stretched-exponential, tier-specific β |
| Tiers | Core (β=0.8) / Working (β=1.0) / Peripheral (β=1.3) |
| Contradiction | Three-layer detection (regex + LLM + dedup) |
| Extraction | Smart extraction with GPT-4.1 |
| Graph | Graphiti/Neo4j knowledge graph |
| Scopes | Multi-agent isolation |
| Emotional salience | Amygdala-modeled half-life adjustment |
| Noise filtering | Embedding-based noise bank + regex |
| Temporal queries | Date format expansion (中/EN) |

### Mnemo Pro — From $69/mo

Everything in Core, plus enterprise features:

| Feature | Details |
|:---|:---|
| WAL | Write-ahead log for crash recovery |
| Session reflection | Deep summary at session boundaries |
| Self-improvement | Learning from interaction patterns |
| Memory tools | memory_store / search / delete for agents |
| MCP Server | Model Context Protocol integration |
| Observability | Query tracking, latency monitoring, health checks |
| Access tracking | Spaced repetition with reinforcement |

```bash
# Activate Pro
export MNEMO_LICENSE_TOKEN="mnemo_your_token"
# Auto-activates on first run, binds to this machine
```

### Pricing

| Plan | Price | Devices | Support |
|:---|:---|:---:|:---|
| **Core** | Free forever | Unlimited | GitHub Issues |
| **Indie** | $69/mo · $662/yr | 1 | Email |
| **Team** | $149/mo · $1,430/yr | 5 | Priority + Slack |
| **Enterprise** | Custom | Unlimited | Dedicated + SLA |

[Get Mnemo Pro →](https://mnemo.dev/pro)

### API Configuration Guide

Mnemo requires external models for embedding, extraction, and reranking. **You bring your own API keys** — Mnemo does not proxy or bundle API costs. Choose a setup that fits your budget:

| Setup | Embedding | LLM Extraction | Rerank | Est. API Cost |
|:---|:---|:---|:---|:---:|
| **Local** | Ollama nomic-embed-text | Ollama qwen3:8b | Ollama bge-reranker | **$0/mo** |
| **Hybrid** | Voyage voyage-3-large | GPT-4.1-mini | Voyage rerank-2 | ~$20/mo |
| **Cloud** | Voyage voyage-3-large | GPT-4.1 | Voyage rerank-2 | ~$45/mo |

> These are **your own API costs**, not Mnemo subscription fees. All setups use the same Core/Pro features — the difference is model quality.
>
> - **Local**: Runs entirely offline via [Ollama](https://ollama.com). Good enough to beat most paid competitors.
> - **Hybrid**: Best quality-to-cost ratio. Recommended for most users.
> - **Cloud**: Maximum extraction quality for high-volume production.
>
> See `config/mnemo.local.example.json` for the $0 local setup, or `config/mnemo.example.json` for the cloud setup.

---

## Cognitive Science

Mnemo's design maps directly to established memory research:

| Human Memory | Mnemo Implementation |
|:---|:---|
| Ebbinghaus forgetting curve | Weibull decay: `exp(-(t/λ)^β)` |
| Spaced repetition effect | Access reinforcement extends half-life |
| Memory consolidation (sleep) | Session reflection + overnight cron |
| Core vs peripheral memory | Tier system with differential β |
| Spreading activation | Graphiti 1-hop neighborhood traversal |
| Amygdala emotional tagging | emotionalSalience modulates half-life (up to 1.5×) |
| Interference / false memories | MMR deduplication + noise bank |
| Selective attention | Resonance gating (adaptive threshold) |
| Metamemory | mnemo-doctor + Web Dashboard |

---

## Tools

| Tool | Description | Run |
|:---|:---|:---|
| `mnemo init` | Interactive config wizard | `npm run init` |
| `mnemo-doctor` | One-command health check | `npm run doctor` |
| `validate-config` | Config validation gate | `npm run validate` |
| Dashboard | Web UI for browsing, debugging, monitoring | `http://localhost:18800` |

---

## Documentation

- [Architecture Deep Dive](docs/architecture.md)
- [Configuration Reference](docs/configuration.md)
- [Retrieval Pipeline](docs/retrieval-pipeline.md)
- [Cognitive Science Model](docs/cognitive-science.md)
- [API Reference](docs/api-reference.md)
- [OpenClaw Integration](docs/openclaw-integration.md)

---

## License

This project uses a dual-license model:

- **MIT** — Files marked `SPDX-License-Identifier: MIT` (Core features)
- **Commercial** — Files marked `SPDX-License-Identifier: LicenseRef-Mnemo-Pro` (Pro features)

See [LICENSE](LICENSE) and [packages/pro/LICENSE](packages/pro/LICENSE) for details.

---

## Contributing

We welcome contributions to Mnemo Core (MIT-licensed files). See [CONTRIBUTING.md](CONTRIBUTING.md).

Areas where we'd love help:
- Benchmark evaluation (LOCOMO, MemBench)
- New embedding provider adapters
- Retrieval pipeline optimizations
- Language-specific SDKs (Python, Go)
- Documentation and examples

---

<p align="center">
  <sub>Built with cognitive science, not hype.</sub>
</p>

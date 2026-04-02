<p align="center">
  <img src="docs/logo.svg" width="80" alt="Mnemo" />
</p>

<h1 align="center">Mnemo</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/@mnemoai/core"><img src="https://img.shields.io/npm/v/@mnemoai/core?color=4ecdc4&label=npm" alt="npm"></a>
  <a href="https://pypi.org/project/mnemo-memory/"><img src="https://img.shields.io/pypi/v/mnemo-memory?color=4ecdc4&label=pypi" alt="PyPI"></a>
  <a href="https://github.com/Methux/mnemo/actions"><img src="https://github.com/Methux/mnemo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://docs.m-nemo.ai"><img src="https://img.shields.io/badge/docs-m--nemo.ai-blue" alt="Docs"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/PRs-welcome-brightgreen.svg" alt="PRs Welcome"></a>
</p>

<p align="center">
  <strong>AI memory that forgets intelligently.</strong><br>
  A cognitive science-based memory framework for AI agents.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="https://docs.m-nemo.ai">Docs</a> ·
  <a href="#architecture">Architecture</a> ·
  <a href="#core-vs-pro">Core vs Pro</a> ·
  <a href="https://m-nemo.ai">Website</a>
</p>

---

## Why Mnemo?

Every AI memory solution stores memories. **Mnemo forgets intelligently.**

Humans don't remember everything equally — important memories consolidate, trivial ones fade, frequently recalled knowledge strengthens. Mnemo models this with:

- **Weibull decay** — stretched-exponential forgetting: `exp(-(t/λ)^β)` with tier-specific β
- **Triple-path retrieval** — Vector + BM25 + Knowledge Graph fused with RRF
- **Three-layer contradiction detection** — regex signal → LLM 5-class → dedup pipeline
- **10-stage retrieval pipeline** — from preprocessing to context injection
- **Strategy pattern** — Core provides hooks (`candidatePoolFn`, `frequencyTransformFn`, `minScoreFn`, `preSearchHook`, `sessionDedup`); Pro injects adaptive implementations
- **Adaptive retrieval** — candidate pool scales with store size: `min(200, max(50, sqrt(N)*4))`
- **Memory lifecycle** — automatic tier transitions (working/peripheral/core) with JSONL archival

The result: your AI agent's memory stays relevant instead of drowning in noise.

## Feature Highlights

| Capability | Core (Free) | Pro |
|:---|:---:|:---:|
| Vector + BM25 + Knowledge Graph | ✅ | ✅ |
| Weibull forgetting model | ✅ | ✅ |
| Memory tiers (Core/Working/Peripheral) | ✅ | ✅ |
| Cross-encoder rerank | ✅ | ✅ |
| Contradiction detection | ✅ | ✅ |
| Multi-backend (LanceDB, Qdrant, Chroma, PGVector) | ✅ | ✅ |
| Scope isolation (multi-agent) | ✅ | ✅ |
| $0 local deployment (Ollama) | ✅ | ✅ |
| Adaptive retrieval (pool/score/frequency) | — | ✅ |
| Extraction-time context injection | — | ✅ |
| Session deduplication (surfacedIds) | — | ✅ |
| Pro production features | — | ✅ ([details](https://m-nemo.ai)) |

---

## Architecture

```
  ┌─────────────────────────────────────────────────────────────┐
  │  @mnemoai/core (MIT)                                        │
  │                                                             │
  │  Store ──→ Embedding ──→ Vector DB (LanceDB/Qdrant/Chroma) │
  │                              │                              │
  │  Recall ──→ Multi-path ──→ Rerank ──→ Decay ──→ Top-K      │
  │               │                                             │
  │  Hooks:  candidatePoolFn · minScoreFn · frequencyTransformFn│
  │          preSearchHook · sessionDedup                       │
  │               │                                             │
  │  Lifecycle: tier transitions + JSONL archival               │
  └───────────────┼─────────────────────────────────────────────┘
                  │ Pro injects strategies (no code changes)
  ┌───────────────┴─────────────────────────────────────────────┐
  │  @mnemoai/pro (commercial)                                  │
  │  Adaptive pool · Log frequency cap · Context injection      │
  └─────────────────────────────────────────────────────────────┘
```

---

## Quick Start

### Option 1: npm (simplest)

```bash
npm install @mnemoai/core
```

```typescript
import { createMnemo } from '@mnemoai/core';

// Auto-detect: uses OPENAI_API_KEY from env
const mnemo = await createMnemo({ dbPath: './memory-db' });

// Or use a preset for Ollama ($0, fully local)
// const mnemo = await createMnemo({ preset: 'ollama', dbPath: './memory-db' });

// Store a memory
await mnemo.store({
  text: 'User prefers dark mode and minimal UI',
  category: 'preference',
  importance: 0.8,
});

// Recall — automatically applies decay, rerank, MMR
const results = await mnemo.recall('UI preferences', { limit: 5 });
```

**Available presets:** `openai`, `ollama`, `voyage`, `jina` — [see docs](https://docs.m-nemo.ai/guide/configuration)

### Option 2: Python

```bash
pip install mnemo-memory
npx @mnemoai/server   # start the REST API
```

```python
from mnemo import MnemoClient

client = MnemoClient()
client.store("User prefers dark mode", category="preference")
results = client.recall("UI preferences")
```

### Option 3: 100% Local ($0, no external API)

```bash
ollama pull bge-m3               # embedding
ollama pull qwen3:8b             # smart extraction LLM
ollama pull bge-reranker-v2-m3   # cross-encoder rerank
```

```typescript
const mnemo = await createMnemo({ preset: 'ollama', dbPath: './memory-db' });
```

Full Core functionality — embedding, extraction, rerank — all running locally. Zero API cost.

### Option 4: Docker (full stack)

```bash
git clone https://github.com/Methux/mnemo.git
cd mnemo
cp .env.example .env     # add your API keys
docker compose up -d     # starts Neo4j + Graphiti + Dashboard
```

---

## Packages

| Package | Platform | Install |
|:---|:---|:---|
| [@mnemoai/core](https://www.npmjs.com/package/@mnemoai/core) | npm | `npm install @mnemoai/core` |
| @mnemoai/pro | npm (private) | `npm install @mnemoai/pro` (requires license) |
| [@mnemoai/server](https://www.npmjs.com/package/@mnemoai/server) | npm | `npx @mnemoai/server` |
| [@mnemoai/vercel-ai](https://www.npmjs.com/package/@mnemoai/vercel-ai) | npm | `npm install @mnemoai/vercel-ai` |
| [mnemo-memory](https://pypi.org/project/mnemo-memory/) | PyPI | `pip install mnemo-memory` |

---

## Core vs Pro

### Mnemo Core — Free, MIT License

The open-source foundation. Full retrieval engine, no restrictions.

| Feature | Details |
|:---|:---|
| Storage | Pluggable backend — LanceDB (default), Qdrant, Chroma, PGVector |
| Retrieval | Triple-path (Vector + BM25 + Graphiti) with RRF fusion |
| Rerank | Cross-encoder (configurable provider) |
| Decay | Weibull stretched-exponential, tier-specific β |
| Tiers | Core (β=0.8) / Working (β=1.0) / Peripheral (β=1.3) |
| Contradiction | Three-layer detection (regex + LLM + dedup) |
| Extraction | Smart extraction (configurable LLM) |
| Graph | Graphiti/Neo4j knowledge graph |
| Scopes | Multi-agent isolation |
| Noise filtering | Embedding-based noise bank + regex |

### Mnemo Pro — From $69/mo

Everything in Core, plus production features. [Learn more →](https://m-nemo.ai)

```bash
npm install @mnemoai/pro
export MNEMO_PRO_KEY="your_license_key"
```

### Pricing

| Plan | Price | Devices | Support |
|:---|:---|:---:|:---|
| **Core** | Free forever | Unlimited | GitHub Issues |
| **Indie** | $69/mo · $690/yr | 1 | Email |
| **Team** | $199/mo · $1,990/yr | 5 | Priority + Slack |
| **Enterprise** | Custom | Unlimited | Dedicated + SLA |

[Get Mnemo Pro →](https://m-nemo.ai)

### API Configuration Guide

Mnemo is a framework — **you bring your own models**. Choose a setup that fits your budget:

| Setup | Embedding | LLM Extraction | Rerank | Est. API Cost |
|:---|:---|:---|:---|:---:|
| **Local** | Ollama bge-m3 | Ollama qwen3:8b | Ollama bge-reranker | **$0/mo** |
| **Hybrid** | OpenAI text-embedding-3-small | GPT-4.1-mini | Jina reranker | ~$5/mo |
| **Cloud** | Voyage voyage-4 | GPT-4.1 | Voyage rerank-2 | ~$45/mo |

> These are **your own API costs**, not Mnemo subscription fees. All setups use the same Core/Pro features — the difference is model quality.

---

## Cognitive Science

Mnemo's design maps directly to established memory research:

| Human Memory | Mnemo |
|:---|:---|
| Ebbinghaus forgetting curve | Weibull decay model |
| Core vs peripheral memory | Tier system with differential decay rates |
| Interference / false memories | Deduplication + noise filtering |
| Metamemory | mnemo-doctor + Web Dashboard |

---

## Documentation

Full documentation at **[docs.m-nemo.ai](https://docs.m-nemo.ai)**

- [Quick Start](https://docs.m-nemo.ai/guide/quickstart)
- [Local Setup ($0 Ollama)](https://docs.m-nemo.ai/guide/ollama)
- [Configuration Reference](https://docs.m-nemo.ai/guide/configuration)
- [Storage Backends](https://docs.m-nemo.ai/guide/backends)
- [Retrieval Pipeline](https://docs.m-nemo.ai/guide/retrieval)
- [API Reference](https://docs.m-nemo.ai/api/)

---

## Tools

| Tool | Description | Run |
|:---|:---|:---|
| `mnemo init` | Interactive config wizard | `npm run init` |
| `mnemo-doctor` | One-command health check | `npm run doctor` |
| `validate-config` | Config validation gate | `npm run validate` |
| Dashboard | Web UI for browsing, debugging, monitoring | `http://localhost:18800` |

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
- New storage adapters and embedding providers
- Retrieval pipeline optimizations
- Documentation and examples

---

<p align="center">
  <sub>Built with cognitive science, not hype.</sub>
</p>

---

<sub>
**Trademarks:** LanceDB is a trademark of LanceDB, Inc. Neo4j is a trademark of Neo4j, Inc. Qdrant is a trademark of Qdrant Solutions GmbH. Mnemo is not affiliated with, endorsed by, or sponsored by any of these organizations. Storage backends are used under their respective open-source licenses.
</sub>

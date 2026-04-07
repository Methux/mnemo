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
  <strong>Long-term memory for AI agents.</strong><br>
  Store, recall, and forget — just like humans do.
</p>

<p align="center">
  <a href="#quick-start">Quick Start</a> ·
  <a href="https://docs.m-nemo.ai">Docs</a> ·
  <a href="#why-mnemo">Why Mnemo</a> ·
  <a href="#self-hosted-vs-cloud">Self-hosted vs Cloud</a> ·
  <a href="https://m-nemo.ai">Website</a>
</p>

---

## Quick Start

```bash
npm install @mnemoai/core
```

```typescript
import { createMnemo } from '@mnemoai/core';

const mnemo = await createMnemo({ dbPath: './memory-db' });

// Store
await mnemo.store({ text: 'User prefers dark mode and minimal UI' });

// Recall — vector search + BM25 + rerank + decay scoring
const results = await mnemo.recall('What does the user like?');
// → [{ text: "User prefers dark mode and minimal UI", score: 0.92 }]

// Old memories fade automatically. Important ones stick around.
```

Auto-detects `OPENAI_API_KEY` from env. Or use a preset:

```typescript
// 100% local, $0 API cost
const mnemo = await createMnemo({ preset: 'ollama', dbPath: './memory-db' });
```

**Available presets:** `openai` · `ollama` · `voyage` · `jina` — [configuration guide](https://docs.m-nemo.ai/guide/configuration)

<details>
<summary><strong>Python</strong></summary>

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

</details>

<details>
<summary><strong>100% Local with Ollama ($0)</strong></summary>

```bash
ollama pull bge-m3               # embedding
ollama pull qwen3:8b             # smart extraction LLM
ollama pull bge-reranker-v2-m3   # cross-encoder rerank
```

```typescript
const mnemo = await createMnemo({ preset: 'ollama', dbPath: './memory-db' });
```

Full Core functionality — embedding, extraction, rerank — all running locally.

</details>

<details>
<summary><strong>Docker (full stack with Neo4j + Dashboard)</strong></summary>

```bash
git clone https://github.com/Methux/mnemo.git
cd mnemo
cp .env.example .env     # add your API keys
docker compose up -d     # starts Neo4j + Graphiti + Dashboard
```

</details>

---

## Why Mnemo?

Most AI memory systems are glorified vector databases — they store everything and retrieve by similarity. That breaks at scale: your agent drowns in stale, contradictory, and irrelevant memories.

**Mnemo is different.** It models memory the way cognitive science says humans actually remember:

- **Old memories fade.** A Weibull decay model naturally deprioritizes stale information — no manual cleanup needed.
- **Important memories consolidate.** Frequently accessed, high-importance memories promote to a "core" tier with slower decay.
- **Contradictions resolve automatically.** When a user says "I moved to Tokyo" after previously saying "I live in NYC", Mnemo detects the contradiction and expires the old fact.
- **Noise gets filtered.** Debug logs, API errors, meta-questions — automatically excluded from long-term storage.

The result: your agent's memory stays sharp at 100 memories or 10,000.

### How it compares

| | Mnemo | mem0 | Zep | LangMem |
|:---|:---:|:---:|:---:|:---:|
| Local-first (no SaaS lock-in) | **Yes** | No | No | Partial |
| Forgetting model | **Weibull decay** | None | Time window | None |
| Contradiction detection | **Auto** | Manual | Manual | None |
| Multi-backend (LanceDB/Qdrant/Chroma/PGVector) | **Yes** | Qdrant only | Postgres only | Varies |
| Provider agnostic (BYO embedding/LLM) | **Yes** | Limited | No | LangChain only |
| Fully offline ($0 with Ollama) | **Yes** | No | No | No |

---

## Architecture

```
  User message
       │
       ▼
  ┌─── Store ───────────────────────────────────────┐
  │  Embed → Noise filter → Dedup → Contradiction   │
  │  detection → LanceDB (vector + BM25 index)      │
  └──────────────────────────────────────────────────┘
       │
       ▼
  ┌─── Recall ──────────────────────────────────────┐
  │  Vector search + BM25 → RRF fusion → Rerank     │
  │  → Decay scoring → MMR diversity → Top-K         │
  └──────────────────────────────────────────────────┘
       │
       ▼
  ┌─── Lifecycle ───────────────────────────────────┐
  │  Working → Core (consolidate)                    │
  │  Working → Peripheral → Archive (fade out)       │
  │  Driven by composite score, no manual tuning     │
  └──────────────────────────────────────────────────┘
```

Every parameter adapts to your store size. No magic numbers to tune.

---

## Feature Highlights

| Capability | Core (Free) | Cloud |
|:---|:---:|:---:|
| Vector + BM25 + Knowledge Graph | Yes | Yes |
| Weibull forgetting model | Yes | Yes |
| Memory tiers (Core/Working/Peripheral) | Yes | Yes |
| Cross-encoder rerank | Yes | Yes |
| Contradiction detection | Yes | Yes |
| Multi-backend (LanceDB, Qdrant, Chroma, PGVector) | Yes | Yes |
| Scope isolation (multi-agent) | Yes | Yes |
| $0 local deployment (Ollama) | Yes | Yes |
| Adaptive retrieval (pool/score/frequency) | — | Yes |
| Extraction-time context injection | — | Yes |
| Session deduplication | — | Yes |

---

## Self-hosted vs Cloud

**Self-hosted (Core)** — the full framework, MIT licensed, no restrictions. `npm install @mnemoai/core` and run it yourself. You bring your own embedding/LLM keys.

**Mnemo Cloud** — hosted API, zero setup. Adaptive retrieval, intelligent extraction, and contradiction detection built in. No keys to manage, no infrastructure to run.

```bash
# Cloud: one API call, done
curl -X POST https://api.m-nemo.ai/v1/store \
  -H "Authorization: Bearer mn_your_key" \
  -d '{"text": "User prefers dark mode"}'
```

| Plan | Price | What you get |
|:---|:---|:---|
| **Core** | Free forever | Full framework, self-hosted, MIT |
| **Cloud Starter** | $29/month | 10K memories, 1K stores/day, 50K recalls/day |
| **Cloud Pro** | $99/month | 100K memories, 10K stores/day, unlimited recalls |
| **Enterprise** | Contact us | Custom limits, dedicated support, SLA |

[Get Started with Mnemo Cloud →](https://m-nemo.ai)

### API Configuration Guide

Mnemo is a framework — **you bring your own models**. Choose a setup that fits your budget:

| Setup | Embedding | LLM Extraction | Rerank | Est. API Cost |
|:---|:---|:---|:---|:---:|
| **Local** | Ollama bge-m3 | Ollama qwen3:8b | Ollama bge-reranker | **$0/mo** |
| **Hybrid** | OpenAI text-embedding-3-small | GPT-4.1-mini | Jina reranker | ~$5/mo |
| **Cloud** | Voyage voyage-4 | GPT-4.1 | Voyage rerank-2 | ~$45/mo |

> These are **your own API costs**, not Mnemo subscription fees.

---

## Packages

| Package | Platform | Install |
|:---|:---|:---|
| [@mnemoai/core](https://www.npmjs.com/package/@mnemoai/core) | npm | `npm install @mnemoai/core` |
| [Mnemo Cloud](https://m-nemo.ai) | REST API | `https://api.m-nemo.ai` |
| [@mnemoai/server](https://www.npmjs.com/package/@mnemoai/server) | npm | `npx @mnemoai/server` |
| [@mnemoai/vercel-ai](https://www.npmjs.com/package/@mnemoai/vercel-ai) | npm | `npm install @mnemoai/vercel-ai` |
| [mnemo-memory](https://pypi.org/project/mnemo-memory/) | PyPI | `pip install mnemo-memory` |

---

## Cognitive Science

Mnemo's design maps directly to established memory research:

| Human Memory | Mnemo |
|:---|:---|
| Ebbinghaus forgetting curve | Weibull decay model |
| Core vs peripheral memory | Tier system with differential decay rates |
| Interference / false memories | Deduplication + noise filtering |
| Metamemory | mnemo-doctor + Web Dashboard |

Read more: [Architecture →](https://docs.m-nemo.ai/architecture) · [Retrieval Pipeline →](https://docs.m-nemo.ai/guide/retrieval) · [Ablation Tests →](https://docs.m-nemo.ai/guide/ablation)

---

## Documentation

Full docs at **[docs.m-nemo.ai](https://docs.m-nemo.ai)**

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

## Contributing

We welcome contributions to Mnemo Core (MIT-licensed files). See [CONTRIBUTING.md](CONTRIBUTING.md).

Areas where we'd love help:
- Benchmark evaluation (LOCOMO, MemBench)
- New storage adapters and embedding providers
- Retrieval pipeline optimizations
- Documentation and examples

---

## License

Dual-license model:

- **MIT** — Core framework (`SPDX-License-Identifier: MIT`)
- **Commercial** — Cloud features and advanced strategies

See [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Built with cognitive science, not hype.</sub>
</p>

---

<sub>
**Trademarks:** LanceDB is a trademark of LanceDB, Inc. Neo4j is a trademark of Neo4j, Inc. Qdrant is a trademark of Qdrant Solutions GmbH. Mnemo is not affiliated with, endorsed by, or sponsored by any of these organizations. Storage backends are used under their respective open-source licenses.
</sub>

# Architecture Overview

Mnemo is a cognitive science-based AI memory framework with a layered architecture.

## Core Components

### Storage Layer

- **LanceDB** — Embedded vector database (default, zero-config). Supports pluggable backends: Qdrant, Chroma, PGVector.
- **Scope Isolation** — Per-agent namespaces with configurable cross-access rules.

### Retrieval Layer

- **Semantic Search** — Vector similarity matching
- **Keyword Search** — BM25 full-text index
- **Weibull Decay** — Stretched-exponential forgetting with tier-specific parameters
- **Dedup & Noise Filtering** — Embedding-based dedup + regex noise bank

### Extraction Layer

- **Smart Extraction** — LLM-powered 6-category memory extraction from conversations
- **Contradiction Detection** — Multi-layer detection for conflicting facts

## Strategy Pattern

Mnemo uses a strategy pattern to separate framework from intelligence. Core defines optional hook points with fixed defaults; Cloud injects smarter implementations at runtime.

```
┌──────────────────────────────────────────────────────┐
│  @mnemoai/core (MIT)                                 │
│                                                      │
│  ┌─────────────┐   hooks (optional)                  │
│  │  Retrieval   │──→ candidatePoolFn                 │
│  │  Pipeline    │──→ frequencyTransformFn             │
│  │             │──→ minScoreFn                       │
│  │             │──→ preSearchHook                    │
│  │             │──→ sessionDedup                     │
│  └─────────────┘                                     │
│       ▲  if no hook → use fixed default              │
└───────┼──────────────────────────────────────────────┘
        │ injects implementations
┌───────┴──────────────────────────────────────────────┐
│  Mnemo Cloud                                         │
│                                                      │
│  candidatePoolFn  → adaptive pool                    │
│  frequencyTransformFn → soft logarithmic cap         │
│  minScoreFn       → adaptive threshold               │
│  preSearchHook    → extraction-time context injection │
│  sessionDedup     → session-level deduplication       │
└──────────────────────────────────────────────────────┘
```

**Core works fully without Cloud.** When no hook is registered, sensible fixed defaults apply. Cloud strategies activate automatically — no code changes required.

## Memory Lifecycle

The `MemoryLifecycle` class manages tier transitions based on composite decay scores:

```
  working ←──→ peripheral ←──→ core
     │              │
     │         archive to JSONL
     │         (stale peripheral)
     ▼
  No hard capacity limits — decay naturally demotes irrelevant memories
```

- **Working → Core**: based on access frequency and importance thresholds
- **Working → Peripheral**: after extended inactivity
- **Peripheral → Archived**: stale peripheral memories are archived to JSONL files, keeping the active store lean
- Tier transitions are driven by the composite decay score (recency + frequency + intrinsic weights)
- There are no hard capacity limits — the decay model ensures low-value memories fade naturally

## Pro Components

Mnemo Cloud adds production-grade capabilities. See [Mnemo Cloud](/pro) for details.

## Design Principles

1. **Cognitive science first** — Memory model based on established research, not ad-hoc engineering
2. **Every module earns its place** — Validated by [35 ablation tests](/guide/ablation)
3. **Graceful degradation** — Core works fully without Pro; Pro enhances, never gates
4. **Provider agnostic** — Bring your own embedding, LLM, and rerank providers

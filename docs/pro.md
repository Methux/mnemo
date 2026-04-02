# Mnemo Pro

Everything in Core, plus production features.

## Features

| Feature | What It Does |
|---------|-------------|
| **WAL** | Crash recovery for all write operations |
| **Session Reflection** | Automatic summaries at session boundaries |
| **Self-Improvement** | Extraction quality improves over time |
| **Memory Tools** | Full CRUD tools for agent memory management |
| **MCP Server** | Model Context Protocol integration for Claude Code / Desktop |
| **Access Tracking** | Memory reinforcement through usage patterns |
| **Observability** | Query tracking, latency monitoring, health checks |
| **Audit Log** | Compliance-ready append-only logging |
| **Memory Upgrader** | Auto-migration between schema versions |

## Strategy Functions

Pro's core value is in the strategy functions it injects into Core's hook points. These activate automatically when `@mnemoai/pro` is installed — no code changes needed.

### Adaptive Candidate Pool (`candidatePoolFn`)

Dynamically sizes the candidate pool based on store size:

```
candidatePool = min(200, max(50, sqrt(N) * 4))
```

Where `N` = total memory count from `store.countRows()` (cached for 60 seconds). A small store gets at least 50 candidates; a large store caps at 200.

### Adaptive Minimum Score (`minScoreFn`)

Lowers the score threshold for large stores to avoid over-filtering:

```
minScore = N > 1000 ? 0.25 : 0.3
```

Large stores have more noise, so a lower threshold ensures relevant long-tail memories are not discarded.

### Soft Logarithmic Frequency Cap (`frequencyTransformFn`)

Prevents frequently accessed memories from dominating retrieval:

```
effective = count <= 5 ? count : 5 + log2(count - 4)
```

The first 5 accesses count linearly. Beyond that, frequency advantage grows logarithmically — a memory accessed 100 times scores only ~11, not 100.

### Extraction-Time Context Injection (`preSearchHook`)

Before extracting new memories, Pro pre-searches the 5 most relevant existing memories and injects them into the LLM extraction prompt. This gives the extraction LLM context to detect contradictions at extraction time, rather than relying on post-extraction cosine dedup (which is unreliable for semantic contradictions).

### Session Deduplication (`sessionDedup`)

Tracks `surfacedIds` across a retrieval session to avoid returning the same memory twice in consecutive recall calls.

## What Pro Adds Over Core

| Dimension | Core (defaults) | Pro (strategies) |
|:---|:---|:---|
| Candidate pool | Fixed `20` | Adaptive `50–200` based on store size |
| Min score | Fixed `0.3` | `0.25` when N > 1000 |
| Frequency scoring | Raw count | Soft log cap at 5 |
| Contradiction detection | Post-extraction cosine dedup | Pre-extraction context injection |
| Session dedup | None | `surfacedIds` tracking |

## Installation

```bash
npm install @mnemoai/core @mnemoai/pro
export MNEMO_PRO_KEY="your-license-key"
# Pro features activate automatically — no code changes needed.
```

## Pricing

| Plan | Price | Machines |
|------|-------|----------|
| **Core** | Free forever | Unlimited |
| **Indie** | $69/mo | 1 |
| **Team** | $199/mo | 5 |
| **Enterprise** | Custom | Unlimited |

Annual billing saves 2 months.

## Get a License

Visit [m-nemo.ai](https://m-nemo.ai) to purchase.

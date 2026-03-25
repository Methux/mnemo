# Mnemo Pro

Everything in Core, plus production features.

## Pro Features

| Feature | Description |
|---------|-------------|
| **WAL** | Write-ahead log for crash recovery — LanceDB + Graphiti dual-path |
| **Session Reflection** | Deep summary at session boundaries with invariant/derived classification |
| **Self-Improvement** | Feedback loop — past extraction errors inform future extraction |
| **Memory Tools** | memory_store / search / delete / update / list / stats for agents |
| **MCP Server** | Model Context Protocol integration for Claude Code and Claude Desktop |
| **Observability** | Query tracking, latency monitoring, health checks |
| **Access Tracking** | Spaced repetition with log1p reinforcement and maxMultiplier cap |
| **Audit Log** | GDPR-compliant append-only JSONL |
| **Memory Upgrader** | Auto-migration between schema versions |

## Installation

```bash
# 1. Install Core (public, free)
npm install @mnemoai/core

# 2. Install Pro (requires license token)
npm install @mnemoai/pro

# 3. Set license key
export MNEMO_PRO_KEY="your-license-key"

# Pro features activate automatically — no code changes needed.
```

Your existing `createMnemo()` code works unchanged. Core detects `@mnemoai/pro` and loads Pro modules automatically when a valid license is present.

## Pricing

| Plan | Price | Machines | Best For |
|------|-------|----------|----------|
| **Core** | Free forever | Unlimited | Individual developers, evaluation |
| **Indie** | $69/mo | 1 | Solo developers in production |
| **Team** | $199/mo | 5 | Small teams |
| **Enterprise** | Custom | Unlimited | Large organizations |

Annual billing saves 2 months: Indie $690/yr, Team $1,990/yr.

## How It Works

```
@mnemoai/core (MIT, public)
  │
  ├── On startup: checks MNEMO_PRO_KEY
  │
  ├── If valid: import("@mnemoai/pro") → loads 18 Pro modules
  │   └── WAL, reflection, self-improvement, MCP, tools, audit, etc.
  │
  └── If not: Core works normally, 0 errors, 0 warnings
```

No feature flags, no code changes, no conditional imports in your code. Just install the package and set the key.

## Core vs Pro

| | Core (MIT) | Pro |
|---|---|---|
| Retrieval | Triple-path + RRF + rerank | Same |
| Decay | Weibull + tiers | Same |
| Storage | 4 backends | Same |
| WAL | No | Dual-path crash recovery |
| Reflection | No | Session boundary reflection |
| Self-improvement | No | Feedback loop from past errors |
| MCP | No | Built-in MCP server |
| Tools | No | 6 agent memory tools |
| Observability | No | Query tracking + health checks |
| Audit | No | GDPR-compliant JSONL |

## Get a License

Visit [m-nemo.ai/pro](https://m-nemo.ai) to purchase.

# Mnemo Cloud

Everything in Core, plus adaptive intelligence and zero-ops hosting.

## What Cloud Adds Over Core

| Dimension | Core (self-hosted) | Cloud |
|:---|:---|:---|
| Hosting | You run it | Managed API at `api.m-nemo.ai` |
| Embedding | You bring your own keys | Built-in (no API keys needed) |
| Candidate pool | Fixed (sensible default) | Adaptive, scales with store size |
| Min score | Fixed (sensible default) | Adaptive, lowers at scale |
| Frequency scoring | Raw count | Logarithmic frequency cap |
| Contradiction detection | Basic cosine dedup | Extraction-time context injection |
| Session dedup | None | Automatic |
| Smart extraction | Basic (stub prompts) | Full 6-category L0/L1/L2 with few-shot |
| Backup | Manual | Automatic |

## Quick Start

### Option A: SDK (recommended)

```bash
npm install @mnemoai/client
```

```javascript
import { createCloudMnemo } from "@mnemoai/client";

const mnemo = createCloudMnemo({ apiKey: "mn_your_key" });

// Store a memory
const { id } = await mnemo.store({ text: "User prefers dark mode" });

// Recall memories
const memories = await mnemo.recall("UI preferences", { limit: 5 });

// Check usage
const stats = await mnemo.stats();

// Delete a memory
await mnemo.delete(id);
```

### Option B: HTTP API

Works with any language — just HTTP calls.

```bash
# Store
curl -X POST https://api.m-nemo.ai/v1/store \
  -H "Authorization: Bearer mn_your_key" \
  -H "Content-Type: application/json" \
  -d '{"text": "User prefers dark mode"}'

# Recall
curl -X POST https://api.m-nemo.ai/v1/recall \
  -H "Authorization: Bearer mn_your_key" \
  -H "Content-Type: application/json" \
  -d '{"query": "UI preferences"}'
```

## API Reference

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/store` | Store a memory |
| POST | `/v1/recall` | Recall memories by semantic search |
| DELETE | `/v1/memories/:id` | Delete a memory |
| GET | `/v1/stats` | Usage statistics |
| GET | `/v1/health` | Service health check |

### POST /v1/store

```json
{
  "text": "The text content to remember",
  "category": "fact",
  "importance": 0.8,
  "scope": "global"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| text | string | Yes | Memory content |
| category | string | No | `fact`, `preference`, `decision`, `entity`, `other` (default: `fact`) |
| importance | number | No | 0.0–1.0 (default: 0.7) |
| scope | string | No | For multi-agent isolation (default: `global`) |

**Response:** `{ "id": "uuid" }`

### POST /v1/recall

```json
{
  "query": "search query",
  "limit": 5,
  "category": "preference",
  "scopeFilter": ["global"]
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| query | string | Yes | Semantic search query |
| limit | number | No | Max results (default: 5) |
| category | string | No | Filter by category |
| scopeFilter | string[] | No | Filter by scopes |

**Response:** `{ "results": [{ "text", "score", "category", "importance", "timestamp" }] }`

### DELETE /v1/memories/:id

**Response:** `{ "deleted": "uuid" }`

### GET /v1/stats

**Response:** `{ "totalEntries", "scopeCounts", "categoryCounts", "usage_today", "plan" }`

## Pricing

| Plan | Price | Limits |
|------|-------|--------|
| **Core** | Free forever | Self-hosted, unlimited |
| **Cloud Starter** | $29/month | 10K memories, 1K stores/day, 50K recalls/day |
| **Cloud Pro** | $99/month | 100K memories, 10K stores/day, unlimited recalls |
| **Enterprise** | Contact us | Custom limits, dedicated support, SLA |

[Sign Up for Mnemo Cloud →](https://api.m-nemo.ai/signup)

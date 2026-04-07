# Mnemo Cloud

Everything in Core, plus adaptive intelligence and zero-ops hosting.

## What Cloud Adds Over Core

| Dimension | Core (self-hosted) | Cloud |
|:---|:---|:---|
| Hosting | You run it | Managed API at `api.m-nemo.ai` |
| Embedding | You bring your own keys | Built-in |
| Candidate pool | Fixed (sensible default) | Adaptive, scales with store size |
| Min score | Fixed (sensible default) | Adaptive, lowers at scale |
| Frequency scoring | Raw count | Logarithmic frequency cap |
| Contradiction detection | Basic cosine dedup | Extraction-time context injection |
| Session dedup | None | Automatic |
| Smart extraction | Basic (stub prompts) | Full 6-category L0/L1/L2 with few-shot |
| Backup | Manual | Automatic |

## Quick Start

```bash
# Register
curl -X POST https://api.m-nemo.ai/v1/register \
  -H "Content-Type: application/json" \
  -d '{"email": "you@example.com", "embedding_api_key": "sk-..."}'

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

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/v1/register` | Create account, get API key |
| POST | `/v1/store` | Store a memory |
| POST | `/v1/recall` | Recall memories by query |
| DELETE | `/v1/memories/:id` | Delete a memory |
| GET | `/v1/stats` | Usage statistics |
| GET | `/v1/health` | Service health check |

## Pricing

| Plan | Price | Limits |
|------|-------|--------|
| **Core** | Free forever | Self-hosted, unlimited |
| **Cloud Starter** | $29/month | 10K memories, 1K stores/day, 50K recalls/day |
| **Cloud Pro** | $99/month | 100K memories, 10K stores/day, unlimited recalls |
| **Enterprise** | Contact us | Custom limits, dedicated support, SLA |

[Get Started with Mnemo Cloud →](https://m-nemo.ai)

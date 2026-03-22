# OpenClaw Integration

Mnemo integrates natively with OpenClaw gateway as a plugin.

## Installation

```bash
openclaw plugins install mnemo
```

## What Gets Configured

- Plugin: `memory-lancedb-pro` registered in openclaw.json
- Hooks: memory-extractor, query-context, memory-watcher
- Cron: L1 distillers, daily-md-extractor, maintenance tasks
- Services: Graphiti (launchd)

## Multi-Agent Scopes

Configure per-bot memory isolation in openclaw.json:

```json
{
  "scopes": {
    "agentAccess": {
      "bot3": ["global", "agent:bot3", "agent:default"],
      "bot5": ["global", "agent:bot5", "agent:default"]
    }
  }
}
```

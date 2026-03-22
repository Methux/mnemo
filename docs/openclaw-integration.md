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
      "assistant": ["global", "agent:assistant", "agent:default"],
      "researcher": ["global", "agent:researcher", "agent:default"]
    }
  }
}
```

# Host Gateway Integration

Mnemo integrates natively with a compatible gateway as a plugin.

## Installation

```bash
mnemo plugins install mnemo
```

## What Gets Configured

- Plugin: `mnemo` registered in the host config file (`memory-lancedb-pro` accepted as legacy fallback)
- Hooks: memory-extractor, query-context, memory-watcher
- Cron: L1 distillers, daily-md-extractor, maintenance tasks
- Services: Graphiti (launchd)

## Multi-Agent Scopes

Configure per-agent memory isolation in `mnemo.json`:

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

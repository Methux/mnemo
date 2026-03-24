# MCP Server Integration

Mnemo includes a built-in [MCP (Model Context Protocol)](https://modelcontextprotocol.io/) server that exposes memory tools over stdio JSON-RPC. This lets Claude Code, Claude Desktop, and any MCP-compatible client use Mnemo's memory directly.

## Available Tools

| Tool | Description |
|------|-------------|
| `memory_search` | Hybrid retrieval (vector + BM25 + rerank). Returns ranked memories with source attribution. |
| `memory_store` | Store new memories with auto-dedup, noise filtering, and scope isolation. |
| `memory_delete` | Delete a memory by ID (full UUID or 8+ char prefix). |
| `memory_update` | Update text, importance, or category of an existing memory. Triggers re-embedding. |
| `memory_list` | List recent memories with scope/category filtering and pagination. |
| `memory_stats` | Get statistics: total count, scope breakdown, category distribution. |

## Setup with Claude Code

```bash
# Register Mnemo as an MCP server
claude mcp add mnemo-memory -s user -- \
  node --import jiti/register \
  /path/to/mnemo/packages/core/src/mcp-server.ts
```

Or in your Claude Code MCP config (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "mnemo-memory": {
      "command": "node",
      "args": [
        "--import", "jiti/register",
        "/path/to/mnemo/packages/core/src/mcp-server.ts"
      ]
    }
  }
}
```

## Setup with Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "mnemo-memory": {
      "command": "node",
      "args": [
        "--import", "jiti/register",
        "/path/to/mnemo/packages/core/src/mcp-server.ts"
      ]
    }
  }
}
```

## Configuration

The MCP server reads configuration from your Mnemo config file. Key settings:

```json
{
  "embedding": {
    "provider": "openai-compatible",
    "apiKey": "your-key",
    "model": "voyage-3-large",
    "dimensions": 1024
  },
  "dbPath": "~/.mnemo/memory-db",
  "retrieval": {
    "candidatePoolSize": 40,
    "rerank": "cross-encoder",
    "rerankProvider": "voyage",
    "rerankModel": "rerank-2"
  }
}
```

## Tool Details

### memory_search

```
query: string       — Search query
limit?: number      — Max results (default: 5, max: 20)
scope?: string      — Specific scope to search
category?: string   — Filter by category
```

Returns ranked results with retrieval source attribution (vector, BM25, reranked).

### memory_store

```
text: string         — Information to remember
importance?: number  — 0-1 score (default: 0.7)
category?: string    — "preference" | "fact" | "decision" | "entity" | "other"
scope?: string       — Target scope (default: agent's default scope)
```

Automatically checks for duplicates (cosine > 0.98) and filters noise (greetings, boilerplate).

### memory_update

```
memoryId: string      — Memory ID to update
text?: string         — New text (triggers re-embedding)
importance?: number   — New importance score
category?: string     — New category
```

### memory_list

```
limit?: number    — Max items (default: 10, max: 50)
offset?: number   — Skip N items for pagination
scope?: string    — Filter by scope
category?: string — Filter by category
```

## Features

- **Scope isolation**: Each agent only sees memories in its accessible scopes
- **Noise filtering**: Greetings, boilerplate, and meta-questions are automatically rejected
- **Dedup on write**: Near-identical memories (cosine > 0.98) are detected and skipped
- **WAL protection**: Write-ahead log ensures no memory loss on crash
- **Markdown mirror**: Optionally writes a human-readable log of all stored memories

## Pro Features

With Mnemo Pro, the MCP server additionally supports:

- Access tracking and analytics
- Audit logging for all operations
- WAL crash recovery
- Session reflection integration

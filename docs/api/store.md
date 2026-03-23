# mnemo.store()

Store a memory.

## Signature

```typescript
mnemo.store(entry: {
  text: string;
  category?: MemoryCategory;
  importance?: number;
  scope?: string;
}): Promise<{ id: string }>
```

## Example

```typescript
const { id } = await mnemo.store({
  text: 'User prefers dark mode and minimal UI',
  category: 'preference',
  importance: 0.8,
  scope: 'global',
});

console.log(`Stored memory: ${id}`);
```

## Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `text` | `string` | — | The text content to remember |
| `category` | `MemoryCategory?` | `"fact"` | Memory classification |
| `importance` | `number?` | `0.7` | Importance score (0.0 – 1.0) |
| `scope` | `string?` | `"global"` | Scope for multi-agent isolation |

### Categories

```typescript
type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other" | "reflection"
```

| Category | Use For |
|----------|---------|
| `preference` | User preferences, settings, likes/dislikes |
| `fact` | Factual information about the user or world |
| `decision` | Decisions made, choices, commitments |
| `entity` | People, places, organizations |
| `reflection` | Session summaries, insights |
| `other` | Anything else |

## Behavior

- **Deduplication**: If a very similar memory exists (>92% cosine similarity), the existing memory is updated instead of creating a duplicate.
- **Contradiction detection**: If a conflicting memory is found, the old one is demoted.
- **Embedding**: The text is automatically embedded using the configured provider.

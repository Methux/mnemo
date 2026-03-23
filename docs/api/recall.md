# mnemo.recall()

Retrieve memories by semantic search. Automatically applies Weibull decay, deduplication, and ranking.

## Signature

```typescript
mnemo.recall(query: string, options?: {
  limit?: number;
  scopeFilter?: string[];
  category?: MemoryCategory;
}): Promise<Array<{
  text: string;
  score: number;
  category: string;
  importance: number;
  timestamp: number;
}>>
```

## Example

```typescript
const results = await mnemo.recall('What are the user preferences?', {
  limit: 5,
  category: 'preference',
});

for (const r of results) {
  console.log(`[${r.score.toFixed(2)}] ${r.text}`);
}
```

## Parameters

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `query` | `string` | — | Natural language query |
| `limit` | `number?` | `5` | Maximum results to return |
| `scopeFilter` | `string[]?` | all scopes | Only search these scopes |
| `category` | `MemoryCategory?` | all | Only return this category |

## Return Value

Array of results, sorted by relevance score (highest first):

| Field | Type | Description |
|-------|------|-------------|
| `text` | `string` | Memory content |
| `score` | `number` | Relevance score (0.0 – 1.0) |
| `category` | `string` | Memory category |
| `importance` | `number` | Importance score |
| `timestamp` | `number` | Creation timestamp (ms since epoch) |

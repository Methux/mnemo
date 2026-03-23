# mnemo.stats()

Get memory store statistics.

## Signature

```typescript
mnemo.stats(): Promise<{
  totalEntries: number;
  scopeCounts: Record<string, number>;
  categoryCounts: Record<string, number>;
}>
```

## Example

```typescript
const { totalEntries, scopeCounts, categoryCounts } = await mnemo.stats();

console.log(`Total: ${totalEntries}`);
console.log('By scope:', scopeCounts);   // { global: 30, "agent:bot1": 12 }
console.log('By category:', categoryCounts); // { fact: 20, preference: 15 }
```

# mnemo.delete()

Delete a memory by ID.

## Signature

```typescript
mnemo.delete(id: string): Promise<boolean>
```

## Example

```typescript
const deleted = await mnemo.delete('mem_abc123');
console.log(deleted ? 'Deleted' : 'Not found');
```

## Returns

- `true` — memory was found and deleted
- `false` — memory was not found

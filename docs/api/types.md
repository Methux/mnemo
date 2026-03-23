# Types

All types are exported from `@mnemoai/core` and provide full TypeScript autocomplete.

## MnemoConfig

```typescript
import type { MnemoConfig } from '@mnemoai/core';
```

See [createMnemo()](/api/create-mnemo) for all fields.

## MnemoInstance

```typescript
import type { MnemoInstance } from '@mnemoai/core';
```

The object returned by `createMnemo()`. Methods: `store()`, `recall()`, `delete()`, `stats()`, `close()`.

## MemoryCategory

```typescript
import type { MemoryCategory } from '@mnemoai/core';

type MemoryCategory = "preference" | "fact" | "decision" | "entity" | "other" | "reflection";
```

## StorageBackend

```typescript
import type { StorageBackend } from '@mnemoai/core';

type StorageBackend = "lancedb" | "qdrant" | "chroma" | "pgvector";
```

## StorageAdapter

For building custom storage backends:

```typescript
import type { StorageAdapter } from '@mnemoai/core';
```

## MemoryEntry

Low-level memory record:

```typescript
import type { MemoryEntry } from '@mnemoai/core';

interface MemoryEntry {
  id: string;
  text: string;
  vector: number[];
  category: MemoryCategory;
  scope: string;
  importance: number;
  timestamp: number;
  metadata?: string;
}
```

## Logger

```typescript
import type { Logger } from '@mnemoai/core';
import { setLogger } from '@mnemoai/core';

// Inject a custom logger
setLogger({
  info: console.info,
  warn: console.warn,
  error: console.error,
  debug: console.debug,
});
```

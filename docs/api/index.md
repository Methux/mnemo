# API Reference

## Quick Overview

```typescript
import { createMnemo } from '@mnemoai/core';

const mnemo = await createMnemo(config);

await mnemo.store({ text: '...', category: 'fact' });
const results = await mnemo.recall('query');
await mnemo.delete('memory-id');
const stats = await mnemo.stats();
await mnemo.close();
```

## Methods

| Method | Description |
|--------|-------------|
| [`createMnemo(config)`](/api/create-mnemo) | Create a Mnemo instance |
| [`mnemo.store(entry)`](/api/store) | Store a memory |
| [`mnemo.recall(query, options?)`](/api/recall) | Recall memories by semantic search |
| [`mnemo.delete(id)`](/api/delete) | Delete a memory |
| [`mnemo.stats()`](/api/stats) | Get memory statistics |
| `mnemo.close()` | Close and release resources |

## Types

| Type | Description |
|------|-------------|
| [`MnemoConfig`](/api/types#mnemoconfig) | Configuration for createMnemo() |
| [`MnemoInstance`](/api/types#mnemoinstance) | The instance returned by createMnemo() |
| [`MemoryCategory`](/api/types#memorycategory) | Union type for memory categories |
| [`StorageBackend`](/api/types#storagebackend) | Union type for storage backends |

## Advanced Exports

For advanced use cases, the package also exports:

```typescript
import { MemoryStore } from '@mnemoai/core';           // Low-level store
import { registerAdapter } from '@mnemoai/core';        // Custom backends
import { log, setLogger } from '@mnemoai/core';         // Logger
import type { StorageAdapter } from '@mnemoai/core';    // Adapter interface
```

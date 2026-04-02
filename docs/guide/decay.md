# Weibull Decay

Mnemo is the first AI memory framework to use a cognitive science-based forgetting model.

## Why Forgetting Matters

Other memory systems store everything forever. This leads to:
- **Noise accumulation** — outdated facts drown relevant ones
- **Contradictions** — old preferences override new ones
- **Slow retrieval** — searching through irrelevant memories

Mnemo models human forgetting using the **Weibull distribution**, the same model used in reliability engineering and cognitive psychology.

## The Weibull Function

```
S(t) = exp(-(t/λ)^β)
```

| Parameter | Meaning |
|-----------|---------|
| `t` | Time since memory creation (days) |
| `λ` | Scale parameter (derived from half-life) |
| `β` | Shape parameter (controls decay curve shape) |

## Memory Tiers

Different memories decay at different rates, just like in human cognition:

| Tier | β | Behavior | Example |
|------|---|----------|---------|
| **Core** | 0.8 | Slow start, then rapid drop | User's name, job, key preferences |
| **Working** | 1.0 | Standard exponential | Recent conversations, tasks |
| **Peripheral** | 1.3 | Fast initial drop, long tail | One-off mentions, trivia |

### Decay Curves

At half-life = 30 days:

| Days | Core (β=0.8) | Working (β=1.0) | Peripheral (β=1.3) |
|------|-------------|-----------------|-------------------|
| 0 | 100% | 100% | 100% |
| 15 | 72% | 71% | 68% |
| 30 | 50% | 50% | 50% |
| 60 | 28% | 25% | 21% |
| 90 | 17% | 13% | 8% |

## Tier Promotion

Memories move between tiers based on usage:

- **→ Core**: accessed ≥5 times OR importance ≥0.8
- **→ Peripheral**: not accessed for 90+ days
- **Working**: everything else (default)

## Soft Logarithmic Frequency Cap

Raw access count can create a runaway advantage for frequently recalled memories, drowning out newer or less-accessed but relevant ones. Mnemo Pro applies a soft logarithmic cap:

```
effective = count <= 5 ? count : 5 + log2(count - 4)
```

| Raw Count | Effective Score |
|:---------:|:--------------:|
| 1 | 1.0 |
| 5 | 5.0 |
| 10 | 7.6 |
| 50 | 10.5 |
| 100 | 11.5 |

The first 5 accesses count at full value. Beyond that, each doubling of accesses adds only +1. This keeps frequently recalled memories competitive without letting them dominate the ranking.

In Core (without Pro), raw frequency count is used directly — no cap is applied.

## Lifecycle Integration

The `MemoryLifecycle` class ties decay to tier transitions:

- The **composite decay score** (recency weight + frequency weight + intrinsic weight) is computed for each memory
- When the composite score crosses tier thresholds, the memory is promoted or demoted:
  - **Working → Core**: accessed >= 5 times OR importance >= 0.8
  - **Working → Peripheral**: not accessed for 90+ days
- **Stale peripheral memories** (those below a minimum composite threshold) are archived to JSONL files, keeping the active vector store lean
- There are **no hard capacity limits** — the decay model ensures irrelevant memories fade naturally through tier demotion and eventual archival

## Configuration

```typescript
const mnemo = await createMnemo({
  embedding: { /* ... */ },
  dbPath: './db',
  decay: {
    recencyHalfLifeDays: 30,   // default: 30
    recencyWeight: 0.5,        // default: 0.5
    frequencyWeight: 0.3,      // default: 0.3
    intrinsicWeight: 0.2,      // default: 0.2
  },
  tier: {
    coreAccessThreshold: 5,
    coreImportanceThreshold: 0.8,
    peripheralAgeDays: 90,
  },
});
```

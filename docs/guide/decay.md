# Weibull Decay

Mnemo is the first AI memory framework to use a cognitive science-based forgetting model.

## Why Forgetting Matters

Other memory systems store everything forever. This leads to:
- **Noise accumulation** — outdated facts drown relevant ones
- **Contradictions** — old preferences override new ones
- **Slow retrieval** — searching through irrelevant memories

Mnemo models human forgetting using the **Weibull distribution**, the same model used in reliability engineering and cognitive psychology.

## How It Works

The Weibull stretched-exponential function controls how memories fade over time. Each memory tier has its own shape parameter (β), optimized through [35 ablation tests](/guide/ablation) to match cognitive science research on different memory types:

- **Core memories** (user identity, key preferences) — sub-exponential decay: slow to fade, highly persistent
- **Working memories** (recent conversations, active tasks) — standard exponential decay
- **Peripheral memories** (one-off mentions, trivia) — super-exponential: fades faster than standard

Important memories with high `importance` or `emotionalSalience` decay more slowly. Frequently accessed memories are reinforced — just like human recall strengthens neural pathways.

## Memory Tiers

Different memories decay at different rates, just like in human cognition:

| Tier | Behavior | Example |
|------|----------|---------|
| **Core** | Very persistent, almost never forgotten | User's name, job, key preferences |
| **Working** | Standard decay rate | Recent conversations, tasks |
| **Peripheral** | Fades quickly unless reinforced | One-off mentions, trivia |

## Tier Transitions

Memories move between tiers based on usage patterns. Promotion and demotion are driven by a **composite decay score** that combines recency, frequency, and intrinsic value with optimized weights:

- **→ Core**: sufficient access frequency + high composite score + high importance
- **→ Peripheral**: low composite score or extended inactivity
- **Working**: default tier for all new memories

Transition thresholds are derived from empirical testing, not hardcoded magic numbers.

## Frequency Scoring

Raw access count can create a runaway advantage for frequently recalled memories, drowning out newer or less-accessed but relevant ones. Mnemo Cloud applies a **soft logarithmic frequency cap** — the first few accesses count at full value, then each subsequent doubling adds diminishing returns.

This keeps frequently recalled memories competitive without letting them dominate the ranking.

In Core (self-hosted), raw frequency count is used directly. Cloud applies the optimized frequency transform automatically.

## Lifecycle Integration

The `MemoryLifecycle` class ties decay to tier transitions:

- A **composite decay score** combining recency, frequency, and intrinsic value is computed for each memory
- When the composite score crosses tier thresholds, the memory is promoted or demoted
- **Stale peripheral memories** below a minimum composite threshold are archived to JSONL files, keeping the active vector store lean
- There are **no hard capacity limits** — the decay model ensures irrelevant memories fade naturally through tier demotion and eventual archival

## Configuration

Core provides configurable decay parameters. Sensible defaults are built in — most users don't need to change them:

```typescript
const mnemo = await createMnemo({
  embedding: { /* ... */ },
  dbPath: './db',
  decay: {
    recencyHalfLifeDays: 30,  // how fast memories fade
  },
});
```

Mnemo Cloud uses optimized parameters tuned through extensive benchmarking. No configuration needed.

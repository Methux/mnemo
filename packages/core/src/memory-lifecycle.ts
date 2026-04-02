// SPDX-License-Identifier: MIT
/**
 * Memory Lifecycle Manager — Natural decay-driven memory management
 *
 * No hard-coded capacity limits. Memories live or die based on their
 * decay composite score (recency × frequency × intrinsic value).
 *
 * Flow:
 * 1. Score all memories via decay engine (already built)
 * 2. Evaluate tier transitions via tier manager (already built)
 * 3. Archive stale peripheral memories to JSONL (new)
 * 4. Delete expired/contradicted memories (cleanup)
 *
 * Like human memory: active memories stay strong, unused ones naturally
 * fade and eventually disappear. No "capacity" — just competition.
 */

import type { MemoryStore, MemoryEntry } from "./store.js";
import type { DecayEngine } from "./decay-engine.js";
import type { TierManager, TierTransition } from "./tier-manager.js";
import { getDecayableFromEntry } from "./smart-metadata.js";
import { log } from "./logger.js";

// ============================================================================
// Types
// ============================================================================

export interface LifecycleResult {
  /** Number of tier transitions applied */
  transitions: number;
  /** Number of memories archived (moved from LanceDB to JSONL) */
  archived: number;
  /** Number of expired memories deleted */
  expired: number;
  /** Total memories evaluated */
  evaluated: number;
}

export interface LifecycleConfig {
  /** Minimum hours between lifecycle runs (default: 1) */
  throttleHours: number;
  /** Archive file path pattern. {scope} is replaced with scope name. */
  archivePath?: string;
}

const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  throttleHours: 1,
};

// ============================================================================
// Lifecycle Manager
// ============================================================================

export class MemoryLifecycle {
  private lastRunByScope = new Map<string, number>();

  constructor(
    private store: MemoryStore,
    private decayEngine: DecayEngine,
    private tierManager: TierManager,
    private config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
    private archiveWriter?: (scope: string, entries: MemoryEntry[]) => Promise<void>,
  ) {}

  /**
   * Run lifecycle for a scope. Throttled to max once per throttleHours.
   * Safe to call frequently — will no-op if called too soon.
   */
  async run(scopeFilter: string[]): Promise<LifecycleResult | null> {
    const scopeKey = scopeFilter.sort().join("|");
    const lastRun = this.lastRunByScope.get(scopeKey) || 0;
    const hoursSince = (Date.now() - lastRun) / 3_600_000;

    if (hoursSince < this.config.throttleHours) {
      return null; // Throttled
    }

    this.lastRunByScope.set(scopeKey, Date.now());

    try {
      return await this.runInternal(scopeFilter);
    } catch (err) {
      log.warn(`memory-lifecycle: error during lifecycle run: ${err}`);
      return null;
    }
  }

  private async runInternal(scopeFilter: string[]): Promise<LifecycleResult> {
    const result: LifecycleResult = {
      transitions: 0,
      archived: 0,
      expired: 0,
      evaluated: 0,
    };

    // 1. Fetch all memories for this scope
    const entries = await this.store.list(scopeFilter, undefined, 10000, 0);
    result.evaluated = entries.length;

    if (entries.length === 0) return result;

    log.info(`memory-lifecycle: evaluating ${entries.length} memories for ${scopeFilter.join(",")}`);

    // 2. Convert to DecayableMemory and score
    const decayables = entries.map(entry => {
      const { memory } = getDecayableFromEntry(entry);
      return memory;
    });

    const scores = this.decayEngine.scoreAll(decayables);
    const scoreMap = new Map(scores.map(s => [s.memoryId, s]));

    // 3. Delete expired memories (contradicted, already flagged)
    for (const entry of entries) {
      try {
        const meta = JSON.parse(entry.metadata || "{}");
        if (meta.expired_at) {
          await this.store.delete(entry.id, scopeFilter);
          result.expired++;
        }
      } catch { /* skip parse errors */ }
    }

    // 4. Evaluate tier transitions
    const tierables = decayables.map(m => ({
      id: m.id,
      tier: m.tier,
      importance: m.importance,
      accessCount: m.accessCount,
      createdAt: m.createdAt,
    }));

    const transitions = this.tierManager.evaluateAll(tierables, scores);

    for (const t of transitions) {
      try {
        await this.store.patchMetadata(t.memoryId, { tier: t.toTier }, scopeFilter);
        result.transitions++;
        log.info(`memory-lifecycle: ${t.fromTier} → ${t.toTier}: ${t.memoryId.slice(0, 8)} (${t.reason})`);
      } catch (err) {
        log.warn(`memory-lifecycle: failed to transition ${t.memoryId}: ${err}`);
      }
    }

    // 5. Archive stale peripheral memories
    // A memory reaches this point naturally: created → working → peripheral (via tier demotion)
    // → composite drops below staleThreshold → archived here.
    // No hard cutoff — the decay engine's composite score is the sole judge.
    const staleScores = this.decayEngine.getStaleMemories(decayables);
    const toArchive: MemoryEntry[] = [];

    for (const stale of staleScores) {
      const entry = entries.find(e => e.id === stale.memoryId);
      const decayable = decayables.find(d => d.id === stale.memoryId);
      if (!entry || !decayable) continue;

      // Only archive peripheral memories — core/working are still "alive"
      if (decayable.tier !== "peripheral") continue;

      toArchive.push(entry);
    }

    if (toArchive.length > 0 && this.archiveWriter) {
      try {
        const scope = scopeFilter[0] || "global";
        await this.archiveWriter(scope, toArchive);

        for (const entry of toArchive) {
          await this.store.delete(entry.id, scopeFilter);
          result.archived++;
        }

        log.info(`memory-lifecycle: archived ${result.archived} stale peripheral memories`);
      } catch (err) {
        log.warn(`memory-lifecycle: archive failed, skipping deletion: ${err}`);
        // Don't delete if archive fails — safety first
      }
    }

    log.info(
      `memory-lifecycle: done — evaluated=${result.evaluated}, transitions=${result.transitions}, archived=${result.archived}, expired=${result.expired}`,
    );

    return result;
  }
}

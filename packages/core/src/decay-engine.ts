/**
 * Decay Engine — Weibull stretched-exponential decay model
 *
 * Composite score = recencyWeight * recency + frequencyWeight * frequency + intrinsicWeight * intrinsic
 *
 * - Recency: Weibull decay with importance-modulated half-life and tier-specific beta
 * - Frequency: Logarithmic saturation with time-weighted access pattern bonus
 * - Intrinsic: importance × confidence
 */

import type { MemoryTier } from "./memory-categories.js";

// ============================================================================
// Types
// ============================================================================

const MS_PER_DAY = 86_400_000;

export interface DecayConfig {
  /** Days until recency score halves (default: 30) */
  recencyHalfLifeDays: number;
  /** Weight of recency in composite (default: 0.4) */
  recencyWeight: number;
  /** Weight of access frequency (default: 0.3) */
  frequencyWeight: number;
  /** Weight of importance × confidence (default: 0.3) */
  intrinsicWeight: number;
  /** Below this composite = stale (default: 0.3) */
  staleThreshold: number;
  /** Minimum search boost (default: 0.3) */
  searchBoostMin: number;
  /** Importance modulation coefficient for half-life (default: 1.5) */
  importanceModulation: number;
  /** Weibull beta for Core tier — sub-exponential (default: 0.8) */
  betaCore: number;
  /** Weibull beta for Working tier — standard exponential (default: 1.0) */
  betaWorking: number;
  /** Weibull beta for Peripheral tier — super-exponential (default: 1.3) */
  betaPeripheral: number;
  /** Decay floor for Core memories (default: 0.9) */
  coreDecayFloor: number;
  /** Decay floor for Working memories (default: 0.7) */
  workingDecayFloor: number;
  /** Decay floor for Peripheral memories (default: 0.5) */
  peripheralDecayFloor: number;
}

// NOTE: These weights are initial values pending grid-search optimization.
// The LOCOMO benchmark results (locomo_Voyage-large_20260321_122613.json) contain
// only question-level accuracy, not per-memory signal scores (decay, usage, emotion,
// degree), so offline re-scoring is not feasible. To optimize:
//   1. Instrument live retrieval to log per-memory signal scores alongside hit/miss
//   2. Run grid search over weight space (constraint: sum = 1.0):
//        recencyWeight:  [0.25, 0.30, 0.35, 0.40]
//        frequencyWeight: [0.10, 0.15, 0.20, 0.25]
//        emotionWeight (via importanceModulation): [0.05, 0.10, 0.15]
//        degreeWeight (via tier floors): [0.05, 0.10, 0.15]
//        intrinsicWeight: [0.10, 0.15, 0.20]
//   3. Evaluate top-5 hit rate on accumulated retrieval logs
export const DEFAULT_DECAY_CONFIG: DecayConfig = {
  recencyHalfLifeDays: 30,
  recencyWeight: 0.4,       // initial — pending optimization
  frequencyWeight: 0.3,     // initial — pending optimization
  intrinsicWeight: 0.3,     // initial — pending optimization
  staleThreshold: 0.3,
  searchBoostMin: 0.3,
  importanceModulation: 1.5,
  betaCore: 0.8,
  betaWorking: 1.0,
  betaPeripheral: 1.3,
  coreDecayFloor: 0.9,
  workingDecayFloor: 0.7,
  peripheralDecayFloor: 0.5,
};

export interface DecayScore {
  memoryId: string;
  recency: number;
  frequency: number;
  intrinsic: number;
  composite: number;
}

/** Minimal memory fields needed for decay calculation. */
export interface DecayableMemory {
  id: string;
  importance: number;
  confidence: number;
  tier: MemoryTier;
  accessCount: number;
  createdAt: number;
  lastAccessedAt: number;
  /** Emotional salience (0-1). Modulates decay: high salience = slower decay. */
  emotionalSalience: number;
}

export interface DecayEngine {
  /** Calculate decay score for a single memory */
  score(memory: DecayableMemory, now?: number): DecayScore;
  /** Calculate decay scores for multiple memories */
  scoreAll(memories: DecayableMemory[], now?: number): DecayScore[];
  /** Apply decay boost to search results (multiplies each score by boost) */
  applySearchBoost(
    results: Array<{ memory: DecayableMemory; score: number }>,
    now?: number,
  ): void;
  /** Find stale memories (composite below threshold) */
  getStaleMemories(
    memories: DecayableMemory[],
    now?: number,
  ): DecayScore[];
}

// ============================================================================
// Factory
// ============================================================================

export function createDecayEngine(
  config: DecayConfig = DEFAULT_DECAY_CONFIG,
): DecayEngine {
  const {
    recencyHalfLifeDays: halfLife,
    recencyWeight: rw,
    frequencyWeight: fw,
    intrinsicWeight: iw,
    staleThreshold,
    searchBoostMin: boostMin,
    importanceModulation: mu,
    betaCore,
    betaWorking,
    betaPeripheral,
    coreDecayFloor,
    workingDecayFloor,
    peripheralDecayFloor,
  } = config;

  function getTierBeta(tier: MemoryTier): number {
    switch (tier) {
      case "core":
        return betaCore;
      case "working":
        return betaWorking;
      case "peripheral":
        return betaPeripheral;
    }
  }

  function getTierFloor(tier: MemoryTier): number {
    switch (tier) {
      case "core":
        return coreDecayFloor;
      case "working":
        return workingDecayFloor;
      case "peripheral":
        return peripheralDecayFloor;
    }
  }

  /**
   * Recency: Weibull stretched-exponential decay with importance + salience modulated half-life.
   * effectiveHL = halfLife * exp(mu * importance) * (1 + salience * 0.5)
   *
   * Salience effect: a memory with salience=1.0 gets 1.5x the half-life.
   * This models the human brain's amygdala tagging: emotionally charged
   * memories decay slower regardless of their "importance" category.
   */
  function recency(memory: DecayableMemory, now: number): number {
    const lastActive =
      memory.accessCount > 0 ? memory.lastAccessedAt : memory.createdAt;
    const daysSince = Math.max(0, (now - lastActive) / MS_PER_DAY);
    const salience = memory.emotionalSalience ?? 0.3;
    const effectiveHL = halfLife * Math.exp(mu * memory.importance) * (1 + salience * 0.5);
    const lambda = Math.LN2 / effectiveHL;
    const beta = getTierBeta(memory.tier);
    return Math.exp(-lambda * Math.pow(daysSince, beta));
  }

  /**
   * Frequency: logarithmic saturation curve with time-weighted access pattern bonus.
   * base = 1 - exp(-accessCount / 5)
   * For memories with >1 access, a recentness bonus is applied.
   */
  function frequency(memory: DecayableMemory): number {
    const base = 1 - Math.exp(-memory.accessCount / 5);
    if (memory.accessCount <= 1) return base;

    const lastActive =
      memory.accessCount > 0 ? memory.lastAccessedAt : memory.createdAt;
    const accessSpanDays = Math.max(
      1,
      (lastActive - memory.createdAt) / MS_PER_DAY,
    );
    const avgGapDays = accessSpanDays / Math.max(memory.accessCount - 1, 1);
    const recentnessBonus = Math.exp(-avgGapDays / 30);
    return base * (0.5 + 0.5 * recentnessBonus);
  }

  /**
   * Intrinsic value: importance × confidence × (1 + salience * 0.3).
   * Salience gives a mild intrinsic boost — emotionally significant memories
   * are inherently more valuable even if importance score is moderate.
   */
  function intrinsic(memory: DecayableMemory): number {
    const salience = memory.emotionalSalience ?? 0.3;
    return memory.importance * memory.confidence * (1 + salience * 0.3);
  }

  function scoreOne(memory: DecayableMemory, now: number): DecayScore {
    const r = recency(memory, now);
    const f = frequency(memory);
    const i = intrinsic(memory);
    const composite = rw * r + fw * f + iw * i;

    return {
      memoryId: memory.id,
      recency: r,
      frequency: f,
      intrinsic: i,
      composite,
    };
  }

  return {
    score(memory, now = Date.now()) {
      return scoreOne(memory, now);
    },

    scoreAll(memories, now = Date.now()) {
      return memories.map((m) => scoreOne(m, now));
    },

    applySearchBoost(results, now = Date.now()) {
      for (const r of results) {
        const ds = scoreOne(r.memory, now);
        const tierFloor = Math.max(getTierFloor(r.memory.tier), ds.composite);
        const multiplier = boostMin + ((1 - boostMin) * tierFloor);
        r.score *= Math.min(1, Math.max(boostMin, multiplier));
      }
    },

    getStaleMemories(memories, now = Date.now()) {
      const scores = memories.map((m) => scoreOne(m, now));
      return scores
        .filter((s) => s.composite < staleThreshold)
        .sort((a, b) => a.composite - b.composite);
    },
  };
}

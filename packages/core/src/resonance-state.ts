/**
 * Adaptive Resonance Threshold
 *
 * Maintains a sliding window of recent auto-recall top-1 cosine scores
 * to compute an adaptive resonance gate threshold (P25 of the window).
 * Persisted to ~/.openclaw/memory/resonance-state.json.
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

const STATE_PATH = join(homedir(), ".openclaw", "memory", "resonance-state.json");
const WINDOW_SIZE = 100;
const COLD_START_MIN = 20;
const DEFAULT_THRESHOLD = 0.45;
const THRESHOLD_FLOOR = 0.30;
const THRESHOLD_CEILING = 0.60;

interface ResonanceStateData {
  scores: number[];
}

let cached: ResonanceStateData | null = null;

function loadState(): ResonanceStateData {
  if (cached) return cached;
  try {
    const raw = readFileSync(STATE_PATH, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.scores)) {
      cached = { scores: parsed.scores.filter((s: unknown) => typeof s === "number" && Number.isFinite(s as number)).slice(-WINDOW_SIZE) };
      return cached;
    }
  } catch {
    // file doesn't exist or is corrupted — start fresh
  }
  cached = { scores: [] };
  return cached;
}

function saveState(state: ResonanceStateData): void {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state), "utf8");
  } catch {
    // best-effort persistence
  }
}

/**
 * Get the adaptive resonance threshold.
 * - Cold start (< 20 samples): returns default 0.45
 * - Otherwise: P25 of sliding window, clamped to [0.30, 0.60]
 */
export function getAdaptiveThreshold(): number {
  const state = loadState();
  if (state.scores.length < COLD_START_MIN) {
    return DEFAULT_THRESHOLD;
  }

  // Compute P25 (25th percentile)
  const sorted = [...state.scores].sort((a, b) => a - b);
  const idx = Math.floor(sorted.length * 0.25);
  const p25 = sorted[idx];

  return Math.min(THRESHOLD_CEILING, Math.max(THRESHOLD_FLOOR, p25));
}

/**
 * Record a top-1 cosine score from an auto-recall probe.
 * Appends to the sliding window and persists.
 */
export function recordResonanceScore(score: number): void {
  if (!Number.isFinite(score)) return;
  const state = loadState();
  state.scores.push(score);
  // Trim to window size
  if (state.scores.length > WINDOW_SIZE) {
    state.scores = state.scores.slice(-WINDOW_SIZE);
  }
  cached = state;
  saveState(state);
}

// SPDX-License-Identifier: MIT
/**
 * Hybrid Retrieval System
 * Combines vector search + BM25 full-text search with RRF fusion
 */

import type { MemoryEntry, MemoryStore, MemorySearchResult } from "./store.js";
import type { Embedder } from "./embedder.js";
import { filterNoise } from "./noise-filter.js";
import type { DecayEngine, DecayableMemory } from "./decay-engine.js";
import type { TierManager } from "./tier-manager.js";
import { toLifecycleMemory, getDecayableFromEntry } from "./smart-metadata.js";
import { getAdaptiveThreshold, recordResonanceScore } from "./resonance-state.js";
import { requirePro } from "./license.js";
import { log } from "./logger.js";

// Pro: Access tracking & query tracking — graceful degradation without license
type AccessTracker = { bumpAccess: (id: string) => Promise<void> };
let _parseAccessMetadata: ((m: unknown) => { accessCount: number; lastAccessedAt: number }) | null = null;
let _computeEffectiveHalfLife: ((hl: number, ac: number, la: number, rf?: number, mx?: number) => number) | null = null;
// TODO: type this with actual query-tracker signature
let _recordQuery: ((...args: unknown[]) => void) | null = null;

if (requirePro("access-tracking")) {
  import("@mnemoai/" + "pro").then((mod) => {
    _parseAccessMetadata = mod.parseAccessMetadata;
    _computeEffectiveHalfLife = mod.computeEffectiveHalfLife;
    _recordQuery = mod.recordQuery;
  }).catch(() => {});
}

// Fallbacks for Core mode (no access reinforcement)
function parseAccessMetadata(m: unknown): { accessCount: number; lastAccessedAt: number } {
  if (_parseAccessMetadata) return _parseAccessMetadata(m);
  return { accessCount: 0, lastAccessedAt: 0 };
}
function computeEffectiveHalfLife(hl: number, _ac: number, _la: number, _rf?: number, _mx?: number): number {
  if (_computeEffectiveHalfLife) return _computeEffectiveHalfLife(hl, _ac, _la, _rf, _mx);
  return hl; // Core: use fixed half-life without reinforcement
}
function recordQuery(data: unknown): void {
  _recordQuery?.(data);
}
import { appendFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Graphiti Graph Search Integration (3rd retrieval path)
// ============================================================================

/** Lazy-read env at call time — openclaw.json env may inject after module load. */
function getGraphitiConfig() {
  return {
    enabled: process.env.GRAPHITI_ENABLED === "true",
    baseUrl: process.env.GRAPHITI_BASE_URL || "http://127.0.0.1:18799",
    timeoutMs: 3000,
  };
}

interface GraphitiFact {
  fact: string;
  source_node?: string;
  target_node?: string;
  from_node?: string;
  to_node?: string;
  created_at?: string;
  valid_at?: string | null;
  score?: number | null;
  degree?: number;
  source?: "search" | "spread";
}

/**
 * Query Graphiti /spread for graph-traversal results.
 * Returns synthetic MemorySearchResult entries. Fails silently (returns []).
 */
async function graphitiSpreadSearch(
  query: string,
  groupId: string = "default",
  searchLimit: number = 3,
  spreadLimit: number = 3,
): Promise<Array<MemorySearchResult & { rank: number }>> {
  const cfg = getGraphitiConfig();
  if (!cfg.enabled) return [];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), cfg.timeoutMs);
    const resp = await fetch(`${cfg.baseUrl}/spread`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query,
        group_id: groupId,
        search_limit: searchLimit,
        spread_depth: 1,
        spread_limit: spreadLimit,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return [];

    const facts: GraphitiFact[] = await resp.json();
    if (!Array.isArray(facts) || facts.length === 0) return [];

    const seen = new Set<string>();
    const results: Array<MemorySearchResult & { rank: number }> = [];

    for (let i = 0; i < facts.length; i++) {
      const f = facts[i];
      const factText = f.fact?.trim();
      if (!factText || factText.length < 5 || seen.has(factText)) continue;
      seen.add(factText);

      const nodes = [f.source_node, f.target_node, f.from_node, f.to_node]
        .filter(Boolean).join(" → ");
      const text = nodes ? `[图谱] ${factText} (${nodes})` : `[图谱] ${factText}`;

      const baseScore = f.source === "search" ? 0.75 : 0.45;
      const degreeBoost = f.degree ? Math.min(0.15, Math.log1p(f.degree) * 0.02) : 0;

      results.push({
        entry: {
          id: `graphiti-${i}-${Date.now()}`,
          text,
          category: "entity" as const,
          importance: 0.8,
          timestamp: f.created_at ? new Date(f.created_at).getTime() : Date.now(),
          scope: "global",
        },
        score: Math.min(1.0, baseScore + degreeBoost),
        rank: i + 1,
      });
    }
    return results;
  } catch {
    return []; // Silent fallback
  }
}

// ============================================================================
// Types & Configuration
// ============================================================================

export interface RetrievalConfig {
  mode: "hybrid" | "vector";
  vectorWeight: number;
  bm25Weight: number;
  minScore: number;
  rerank: "cross-encoder" | "lightweight" | "none";
  candidatePoolSize: number;
  /** Recency boost half-life in days (default: 14). Set 0 to disable. */
  recencyHalfLifeDays: number;
  /** Max recency boost factor (default: 0.10) */
  recencyWeight: number;
  /** Filter noise from results (default: true) */
  filterNoise: boolean;
  /** Reranker API key (enables cross-encoder reranking) */
  rerankApiKey?: string;
  /** Reranker model (default: jina-reranker-v3) */
  rerankModel?: string;
  /** Reranker API endpoint (default: https://api.jina.ai/v1/rerank). */
  rerankEndpoint?: string;
  /** Reranker provider format. Determines request/response shape and auth header.
   *  - "jina" (default): Authorization: Bearer, string[] documents, results[].relevance_score
   *  - "siliconflow": same format as jina (alias, for clarity)
   *  - "voyage": Authorization: Bearer, string[] documents, data[].relevance_score
   *  - "pinecone": Api-Key header, {text}[] documents, data[].score */
  rerankProvider?: "jina" | "siliconflow" | "voyage" | "pinecone" | "ollama";
  /**
   * Length normalization: penalize long entries that dominate via sheer keyword
   * density. Formula: score *= 1 / (1 + log2(charLen / anchor)).
   * anchor = reference length (default: 500 chars). Entries shorter than anchor
   * get a slight boost; longer entries get penalized progressively.
   * Set 0 to disable. (default: 300)
   */
  lengthNormAnchor: number;
  /**
   * Hard cutoff after rerank: discard results below this score.
   * Applied after all scoring stages (rerank, recency, importance, length norm).
   * Higher = fewer but more relevant results. (default: 0.35)
   */
  hardMinScore: number;
  /**
   * Time decay half-life in days. Entries older than this lose score.
   * Different from recencyBoost (additive bonus for new entries):
   * this is a multiplicative penalty for old entries.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At halfLife days: ~0.68x. At 2*halfLife: ~0.59x. At 4*halfLife: ~0.52x.
   * Set 0 to disable. (default: 60)
   */
  timeDecayHalfLifeDays: number;
  /** Access reinforcement factor for time decay half-life extension.
   *  Higher = stronger reinforcement. 0 to disable. (default: 0.5) */
  reinforcementFactor: number;
  /** Maximum half-life multiplier from access reinforcement.
   *  Prevents frequently accessed memories from becoming immortal. (default: 3) */
  maxHalfLifeMultiplier: number;
  /** Enable multi-hop query routing: detected multi-hop queries skip Graphiti
   *  spread and rely on LanceDB secondary retrieval instead. (default: true) */
  multiHopRouting: boolean;
  /** Optional: adaptive candidate pool size based on memory count (Pro). */
  candidatePoolFn?: (memoryCount: number) => number;
  /** Optional: adaptive min score based on memory count (Pro). */
  minScoreFn?: (memoryCount: number) => number;
  /** Enable session-level dedup for auto-recall (Pro). */
  sessionDedup?: boolean;
}

export interface RetrievalContext {
  query: string;
  limit: number;
  scopeFilter?: string[];
  category?: string;
  /** Retrieval source: "manual" for user-triggered, "auto-recall" for system-initiated, "cli" for CLI commands. */
  source?: "manual" | "auto-recall" | "cli";
}

export interface RetrievalResult extends MemorySearchResult {
  sources: {
    vector?: { score: number; rank: number };
    bm25?: { score: number; rank: number };
    graphiti?: { score: number; rank: number };
    fused?: { score: number };
    reranked?: { score: number };
  };
  /** Enriched text with L1 overview for precision. Prefer over entry.text when detail is needed. */
  detail?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

export const DEFAULT_RETRIEVAL_CONFIG: RetrievalConfig = {
  mode: "hybrid",
  vectorWeight: 0.7,
  bm25Weight: 0.3,
  minScore: 0.3,
  rerank: "cross-encoder",
  candidatePoolSize: 30,
  recencyHalfLifeDays: 14,
  recencyWeight: 0.1,
  filterNoise: true,
  rerankModel: "jina-reranker-v3",
  rerankEndpoint: "https://api.jina.ai/v1/rerank",
  lengthNormAnchor: 500,
  hardMinScore: 0.35,
  timeDecayHalfLifeDays: 60,
  reinforcementFactor: 0.5,
  maxHalfLifeMultiplier: 3,
  multiHopRouting: true,
};

// ============================================================================
// Utility Functions
// ============================================================================

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.floor(value)));
}

function clamp01(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return Number.isFinite(fallback) ? fallback : 0;
  return Math.min(1, Math.max(0, value));
}

function clamp01WithFloor(value: number, floor: number): number {
  const safeFloor = clamp01(floor, 0);
  return Math.max(safeFloor, clamp01(value, safeFloor));
}

// ============================================================================
// Rerank Provider Adapters
// ============================================================================

type RerankProvider = "jina" | "siliconflow" | "voyage" | "pinecone" | "ollama";

interface RerankItem {
  index: number;
  score: number;
}

/** Build provider-specific request headers and body */
function buildRerankRequest(
  provider: RerankProvider,
  apiKey: string,
  model: string,
  query: string,
  documents: string[],
  topN: number,
): { headers: Record<string, string>; body: Record<string, unknown> } {
  switch (provider) {
    case "pinecone":
      return {
        headers: {
          "Content-Type": "application/json",
          "Api-Key": apiKey,
          "X-Pinecone-API-Version": "2024-10",
        },
        body: {
          model,
          query,
          documents: documents.map((text) => ({ text })),
          top_n: topN,
          rank_fields: ["text"],
        },
      };
    case "voyage":
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents,
          // Voyage uses top_k (not top_n) to limit reranked outputs.
          top_k: topN,
        },
      };
    case "ollama":
      // Ollama rerank API: POST /api/rerank (available since Ollama 0.6+)
      // Models: jina-reranker-v1-turbo, bge-reranker-v2-m3, etc.
      // No API key needed for local Ollama
      return {
        headers: {
          "Content-Type": "application/json",
        },
        body: {
          model,
          query,
          documents,
          top_n: topN,
        },
      };
    case "siliconflow":
    case "jina":
    default:
      return {
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: {
          model,
          query,
          documents,
          top_n: topN,
        },
      };
  }
}

/** Parse provider-specific response into unified format */
function parseRerankResponse(
  provider: RerankProvider,
  data: Record<string, unknown>,
): RerankItem[] | null {
  const parseItems = (
    items: unknown,
    scoreKeys: Array<"score" | "relevance_score">,
  ): RerankItem[] | null => {
    if (!Array.isArray(items)) return null;
    const parsed: RerankItem[] = [];
    for (const raw of items as Array<Record<string, unknown>>) {
      const index =
        typeof raw?.index === "number" ? raw.index : Number(raw?.index);
      if (!Number.isFinite(index)) continue;
      let score: number | null = null;
      for (const key of scoreKeys) {
        const value = raw?.[key];
        const n = typeof value === "number" ? value : Number(value);
        if (Number.isFinite(n)) {
          score = n;
          break;
        }
      }
      if (score === null) continue;
      parsed.push({ index, score });
    }
    return parsed.length > 0 ? parsed : null;
  };

  switch (provider) {
    case "ollama": {
      // Ollama: { results: [{ index, relevance_score }] }
      // Same format as Jina, but also check data[] for compatibility
      return (
        parseItems(data.results, ["relevance_score", "score"]) ??
        parseItems(data.data, ["relevance_score", "score"])
      );
    }
    case "pinecone": {
      // Pinecone: usually { data: [{ index, score, ... }] }
      // Also tolerate results[] with score/relevance_score for robustness.
      return (
        parseItems(data.data, ["score", "relevance_score"]) ??
        parseItems(data.results, ["score", "relevance_score"])
      );
    }
    case "voyage": {
      // Voyage: usually { data: [{ index, relevance_score }] }
      // Also tolerate results[] for compatibility across gateways.
      return (
        parseItems(data.data, ["relevance_score", "score"]) ??
        parseItems(data.results, ["relevance_score", "score"])
      );
    }
    case "siliconflow":
    case "jina":
    default: {
      // Jina / SiliconFlow: usually { results: [{ index, relevance_score }] }
      // Also tolerate data[] for compatibility across gateways.
      return (
        parseItems(data.results, ["relevance_score", "score"]) ??
        parseItems(data.data, ["relevance_score", "score"])
      );
    }
  }
}

// Cosine similarity for reranking fallback
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error("Vector dimensions must match for cosine similarity");
  }

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const norm = Math.sqrt(normA) * Math.sqrt(normB);
  return norm === 0 ? 0 : dotProduct / norm;
}

// ============================================================================
// Memory Retriever
// ============================================================================

const RETRIEVAL_LOG_PATH = join(homedir(), ".openclaw", "memory", "retrieval-log.jsonl");

export class MemoryRetriever {
  private accessTracker: AccessTracker | null = null;
  private tierManager: TierManager | null = null;
  /** Session-level dedup: memories already surfaced won't be re-injected. */
  private surfacedIds: Set<string> = new Set();

  constructor(
    private store: MemoryStore,
    private embedder: Embedder,
    private config: RetrievalConfig = DEFAULT_RETRIEVAL_CONFIG,
    private decayEngine: DecayEngine | null = null,
  ) { }

  setAccessTracker(tracker: AccessTracker): void {
    this.accessTracker = tracker;
  }

  /**
   * Resonance check: fast vector probe to see if the query "resonates"
   * with any high-salience memories. Returns true if at least one memory
   * has cosine similarity above threshold. This mimics human associative
   * memory — most inputs don't trigger recall, only resonant ones do.
   */
  private async resonanceCheck(
    query: string,
    scopeFilter?: string[],
  ): Promise<{ resonates: boolean; topScore: number }> {
    try {
      const queryVector = await this.embedder.embedQuery(query);
      const threshold = getAdaptiveThreshold();
      const probeResults = await this.store.vectorSearch(
        queryVector,
        3,
        threshold,
        scopeFilter,
      );
      if (probeResults.length === 0) return { resonates: false, topScore: 0 };

      const topScore = Math.max(...probeResults.map(r => r.score));

      // Record top score for adaptive threshold sliding window
      recordResonanceScore(topScore);

      // At least one result resonates — check if it has meaningful salience
      // (not just a random match with a low-importance peripheral memory)
      for (const r of probeResults) {
        const importance = r.entry.importance ?? 0.5;
        const similarity = r.score;
        // Resonance = strong similarity OR moderate similarity + high importance
        if (similarity >= 0.55 || (similarity >= threshold && importance >= 0.7)) {
          return { resonates: true, topScore };
        }
      }
      return { resonates: false, topScore };
    } catch {
      // If resonance check fails, allow recall (fail-open)
      return { resonates: true, topScore: 0 };
    }
  }

  /**
   * Strip metadata blocks from auto-recall queries.
   * OpenClaw core may pass the full message including Conversation info,
   * Replied message, and Sender metadata JSON blocks. We only want the
   * actual user text for semantic search.
   */
  private cleanAutoRecallQuery(raw: string): string {
    // Remove ```json ... ``` code blocks (metadata envelopes)
    let cleaned = raw.replace(/```json[\s\S]*?```/g, "");
    // Remove known metadata headers
    cleaned = cleaned.replace(/Conversation info \(untrusted metadata\):/g, "");
    cleaned = cleaned.replace(/Sender \(untrusted metadata\):/g, "");
    cleaned = cleaned.replace(/Replied message \(untrusted, for context\):/g, "");
    // Remove [Queued messages ...] headers
    cleaned = cleaned.replace(/\[Queued messages[^\]]*\]/g, "");
    cleaned = cleaned.replace(/---\s*\nQueued #\d+/g, "");
    // Collapse whitespace
    cleaned = cleaned.replace(/\n{3,}/g, "\n").trim();
    // If nothing left after cleaning, return original (safety)
    return cleaned.length > 2 ? cleaned : raw;
  }

  /**
   * Expand date expressions in query to multiple formats for BM25 matching.
   * "3月17日" → "3月17日 3/17 03-17 2026-03-17"
   * "2026年3月17日" → "2026年3月17日 3/17 2026-03-17 03-17"
   * "昨天/前天/上周" → resolved to absolute dates
   */
  private expandDateFormats(query: string): string {
    const now = new Date();
    const year = now.getFullYear();
    let expanded = query;

    // Pattern: X月Y日 or X月Y号
    expanded = expanded.replace(/(\d{1,2})月(\d{1,2})[日号]/g, (match, m, d) => {
      const mm = String(m).padStart(2, "0");
      const dd = String(d).padStart(2, "0");
      return `${match} ${m}/${d} ${year}-${mm}-${dd} ${mm}-${dd}`;
    });

    // Pattern: YYYY年X月Y日
    expanded = expanded.replace(/(\d{4})年(\d{1,2})月(\d{1,2})[日号]/g, (match, y, m, d) => {
      const mm = String(m).padStart(2, "0");
      const dd = String(d).padStart(2, "0");
      return `${match} ${m}/${d} ${y}-${mm}-${dd} ${mm}-${dd}`;
    });

    // Pattern: X.Y or X/Y (might be dates like 3/17)
    // Don't expand — these are already BM25-friendly

    // Relative dates
    const relMap: Record<string, number> = {
      "今天": 0, "昨天": -1, "前天": -2, "大前天": -3,
    };
    for (const [word, offset] of Object.entries(relMap)) {
      if (expanded.includes(word)) {
        const d = new Date(now.getTime() + offset * 86400000);
        const iso = d.toISOString().slice(0, 10);
        const m = d.getMonth() + 1;
        const day = d.getDate();
        expanded = expanded.replace(word, `${word} ${iso} ${m}/${day} ${m}月${day}日`);
      }
    }

    return expanded;
  }

  async retrieve(context: RetrievalContext): Promise<RetrievalResult[]> {
    let { query, limit, scopeFilter, category, source } = context;
    // Clean metadata pollution from auto-recall queries
    if (source === "auto-recall") {
      query = this.cleanAutoRecallQuery(query);
    }
    const safeLimit = clampInt(limit, 1, 20);
    const t0 = performance.now();

    // ── 共振门控：auto-recall 时先做快速共振检测 ──
    let resonanceTriggered = false;
    let resonanceTopScore = 0;
    if (source === "auto-recall") {
      const { resonates, topScore: probeTopScore } = await this.resonanceCheck(query, scopeFilter);
      resonanceTriggered = resonates;
      resonanceTopScore = probeTopScore;
      if (!resonates) {
        // Fire-and-forget tracking for gated-out queries
        const trackEntry = JSON.stringify({
          ts: new Date().toISOString(),
          query: query.substring(0, 200),
          source: source || "manual",
          queryType: "gated-out",
          resonanceScore: resonanceTopScore,
          resonanceTriggered: false,
          lancedbCount: 0,
          graphitiCount: 0,
          rerankCount: 0,
          finalCount: 0,
          totalLatencyMs: Math.round(performance.now() - t0),
          lancedbLatencyMs: 0,
          graphitiLatencyMs: 0,
          rerankLatencyMs: 0,
        }) + "\n";
        appendFile(RETRIEVAL_LOG_PATH, trackEntry).catch(() => {});
        recordQuery({
          timestamp: new Date().toISOString(),
          query: query.substring(0, 200),
          source: (source === "auto-recall" ? "auto" : source || "manual") as "auto" | "manual" | "cli",
          hitCount: 0,
          topScore: resonanceTopScore,
          latency_ms: Math.round(performance.now() - t0),
          queryType: "gated-out",
          resonancePass: false,
        });
        return []; // 无共振 → 不注入记忆
      }
    }

    // ── Multi-hop 检测 ──
    const isMultiHop = this.config.multiHopRouting && this.isMultiHopQuery(query);

    // ── 并发查询：LanceDB + Graphiti ──
    const tLance0 = performance.now();
    const lanceDbPromise = (async () => {
      if (this.config.mode === "vector" || !this.store.hasFtsSupport) {
        return this.vectorOnlyRetrieval(query, safeLimit, scopeFilter, category);
      } else {
        return this.hybridRetrieval(query, safeLimit, scopeFilter, category);
      }
    })();

    const tGraphiti0 = performance.now();
    const graphitiPromise = (async (): Promise<RetrievalResult[]> => {
      if (process.env.GRAPHITI_ENABLED !== "true") return [];
      try {
        const graphitiBase = process.env.GRAPHITI_BASE_URL || "http://127.0.0.1:18799";
        const scope = scopeFilter?.[0] || "default";
        const groupId = scope.startsWith("agent:") ? scope.split(":")[1] || "default" : "default";

        // Multi-hop queries skip spread (spread follows single-entity neighborhoods)
        const useSpread = source === "auto-recall" && !isMultiHop;
        const endpoint = useSpread ? "/spread" : "/search";
        const body = useSpread
          ? { query, group_id: groupId, search_limit: 3, spread_depth: 1, spread_limit: 3 }
          : { query, group_id: groupId, limit: Math.min(safeLimit, 5) };

        const resp = await fetch(`${graphitiBase}${endpoint}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok) return [];

        const facts = (await resp.json()) as Array<{
          fact: string; valid_at?: string; expired_at?: string; created_at?: string;
          degree?: number; source?: string;
        }>;
        return facts
          .filter(f => f.fact && !f.expired_at)
          .map((f, i) => {
            const isSpread = f.source === "spread";
            const degreeBoost = f.degree ? Math.min(0.15, Math.log1p(f.degree) * 0.03) : 0;
            const baseScore = isSpread ? 0.45 : 0.65;
            return {
              entry: {
                id: `graphiti-${Date.now()}-${i}`,
                text: f.fact,
                vector: [],
                category: "fact" as const,
                scope: scope,
                importance: 0.7,
                timestamp: f.valid_at ? new Date(f.valid_at).getTime() : Date.now(),
                metadata: JSON.stringify({ source: isSpread ? "graphiti-spread" : "graphiti", valid_at: f.valid_at, degree: f.degree }),
              },
              score: baseScore + (0.01 * (facts.length - i)) + degreeBoost,
              sources: { graphiti: { rank: i + 1 } },
            } as RetrievalResult;
          });
      } catch {
        return [];
      }
    })();

    const [lanceResults, graphitiResults] = await Promise.all([lanceDbPromise, graphitiPromise]);
    const tLanceMs = Math.round(performance.now() - tLance0);
    const tGraphitiMs = Math.round(performance.now() - tGraphiti0);

    // ── Adaptive Graphiti fusion ──
    // Strategy: LanceDB is the primary source. Graphiti supplements based on
    // LanceDB confidence. When LanceDB top scores are high, Graphiti adds little;
    // when LanceDB is uncertain, Graphiti can fill gaps.
    const lanceTexts = new Set(lanceResults.map(r => r.entry.text.slice(0, 80)));
    const uniqueGraphiti = graphitiResults.filter(
      r => !lanceTexts.has(r.entry.text.slice(0, 80))
    );

    // Compute LanceDB confidence: median score of top results
    const lanceConfidence = lanceResults.length > 0
      ? lanceResults[Math.min(2, lanceResults.length - 1)].score  // 3rd-best score
      : 0;

    // Adaptive Graphiti budget: fewer slots when LanceDB is confident
    // High confidence (>0.7) → 1 Graphiti slot; Low confidence (<0.3) → up to 4 slots
    const graphitiBudget = Math.max(0, Math.round((1 - lanceConfidence) * 5));
    const cappedGraphiti = uniqueGraphiti.slice(0, graphitiBudget);

    // Merge: LanceDB fills primary slots, Graphiti fills remaining
    // LanceDB gets at least (limit - graphitiBudget) guaranteed slots
    const lanceSlots = Math.max(safeLimit - cappedGraphiti.length, Math.ceil(safeLimit * 0.7));
    const combined = [
      ...lanceResults.slice(0, lanceSlots),
      ...cappedGraphiti,
    ];

    // ── 跨源统一 Rerank（所有结果都过 reranker）──
    let merged: RetrievalResult[];
    let rerankCount = 0;
    const tRerank0 = performance.now();
    // Adaptive: skip rerank when candidate set is small — reranker adds noise at low N
    if (this.config.rerank !== "none" && this.config.rerankApiKey && combined.length >= 20) {
      const queryVector = await this.embedder.embedQuery(query);
      merged = await this.rerankResults(query, queryVector, combined);
      rerankCount = merged.length;
      merged = merged.slice(0, safeLimit);
    } else {
      merged = combined.slice(0, safeLimit);
    }
    const tRerankMs = Math.round(performance.now() - tRerank0);

    // Record access for reinforcement — top-1 only to prevent stale memories from
    // accumulating access counts by co-retrieval proximity
    if (this.accessTracker && source === "manual" && merged.length > 0) {
      const top = merged[0];
      if (!top.entry.id.startsWith("graphiti-") && top.score >= 0.5) {
        this.accessTracker.recordAccess([top.entry.id]);
      }
    }

    // Tier promotion/demotion based on access patterns (Pro only)
    if (source === "manual" && merged.length > 0) {
      this.recordAccessAndMaybeTransition(merged).catch(() => {});
    }

    // ── Fire-and-forget tracking log ──
    const topScore = merged.length > 0 ? Math.max(...merged.map(r => r.score)) : 0;
    const trackEntry = JSON.stringify({
      ts: new Date().toISOString(),
      query: query.substring(0, 200),
      source: source || "manual",
      queryType: isMultiHop ? "multi-hop" : "single",
      resonanceScore: topScore,
      resonanceTriggered,
      lancedbCount: lanceResults.length,
      graphitiCount: graphitiResults.length,
      rerankCount,
      finalCount: merged.length,
      totalLatencyMs: Math.round(performance.now() - t0),
      lancedbLatencyMs: tLanceMs,
      graphitiLatencyMs: tGraphitiMs,
      rerankLatencyMs: tRerankMs,
    }) + "\n";
    appendFile(RETRIEVAL_LOG_PATH, trackEntry).catch(() => {});
    recordQuery({
      timestamp: new Date().toISOString(),
      query: query.substring(0, 200),
      source: (source === "auto-recall" ? "auto" : source || "manual") as "auto" | "manual" | "cli",
      hitCount: merged.length,
      topScore,
      latency_ms: Math.round(performance.now() - t0),
      queryType: isMultiHop ? "multi-hop" : "single",
      resonancePass: true,
    });

    // Enrich results with L1 overview for precision (optional field, entry.text unchanged)
    for (const r of merged) {
      try {
        const meta = JSON.parse(r.entry.metadata || "{}");
        if (meta.l1_overview) {
          (r as RetrievalResult).detail = `${r.entry.text}\n${meta.l1_overview}`;
        }
      } catch { /* ignore */ }
    }

    // Pro enables session-level dedup for auto-recall via config.sessionDedup.
    if (this.config.sessionDedup && source === "auto-recall") {
      const deduped = merged.filter(r => !this.surfacedIds.has(r.entry.id));
      for (const r of deduped) {
        this.surfacedIds.add(r.entry.id);
      }
      return deduped;
    }

    return merged;
  }

  /** Reset surfaced IDs (call when session resets). */
  resetSurfaced(): void {
    this.surfacedIds.clear();
  }

  private async vectorOnlyRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<RetrievalResult[]> {
    const queryVector = await this.embedder.embedQuery(query);
    // Pro injects minScoreFn; core uses fixed value.
    const effectiveMinScore = this.config.minScoreFn
      ? this.config.minScoreFn(await this.store.countRows(scopeFilter))
      : this.config.minScore;
    const results = await this.store.vectorSearch(
      queryVector,
      limit,
      effectiveMinScore,
      scopeFilter,
    );

    // Filter by category if specified
    const catFiltered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    // Filter expired/contradicted memories (fail-open on parse errors)
    const filtered = catFiltered.filter((r) => {
      try {
        const meta = JSON.parse(r.entry.metadata || "{}");
        return !meta.expired_at;
      } catch { return true; }
    });

    const mapped = filtered.map(
      (result, index) =>
        ({
          ...result,
          sources: {
            vector: { score: result.score, rank: index + 1 },
          },
        }) as RetrievalResult,
    );

    const weighted = this.decayEngine ? mapped : this.applyImportanceWeight(this.applyRecencyBoost(mapped));
    const lengthNormalized = this.applyLengthNormalization(weighted);
    const hardFiltered = lengthNormalized.filter(r => r.score >= this.config.hardMinScore);
    const lifecycleRanked = this.decayEngine
      ? this.applyDecayBoost(hardFiltered)
      : this.applyTimeDecay(hardFiltered);
    const denoised = this.config.filterNoise
      ? filterNoise(lifecycleRanked, r => r.entry.text)
      : lifecycleRanked;

    // MMR deduplication: avoid top-k filled with near-identical memories
    const deduplicated = this.applyMMRDiversity(denoised);

    return deduplicated.slice(0, limit);
  }

  private async hybridRetrieval(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<RetrievalResult[]> {
    // Pro injects candidatePoolFn for adaptive scaling; core uses fixed config value.
    const memCount = this.config.candidatePoolFn || this.config.minScoreFn
      ? await this.store.countRows(scopeFilter) : 0;
    const candidatePoolSize = this.config.candidatePoolFn
      ? this.config.candidatePoolFn(memCount)
      : this.config.candidatePoolSize;

    // Compute query embedding once, reuse for vector search + reranking
    const queryVector = await this.embedder.embedQuery(query);

    // Run vector + BM25 in parallel (Graphiti handled in outer retrieve())
    const [vectorResults, bm25Results] = await Promise.all([
      this.runVectorSearch(
        queryVector,
        candidatePoolSize,
        scopeFilter,
        category,
      ),
      this.runBM25Search(query, candidatePoolSize, scopeFilter, category),
    ]);

    // Fuse results using RRF (async: validates BM25-only entries exist in store)
    const fusedResults = await this.fuseResults(vectorResults, bm25Results);

    // Pro injects minScoreFn for adaptive threshold; core uses fixed config value.
    const adaptiveMinScore = this.config.minScoreFn
      ? this.config.minScoreFn(memCount)
      : this.config.minScore;
    const scoreFiltered = fusedResults.filter(
      (r) => r.score >= adaptiveMinScore,
    );

    // Filter expired/contradicted memories (fail-open on parse errors)
    const filtered = scoreFiltered.filter((r) => {
      try {
        const meta = JSON.parse(r.entry.metadata || "{}");
        return !meta.expired_at;
      } catch { return true; }
    });

    // Rerank if enabled
    const reranked =
      this.config.rerank !== "none"
        ? await this.rerankResults(
          query,
          queryVector,
          filtered.slice(0, limit * 2),
        )
        : filtered;

    const temporallyRanked = this.decayEngine
      ? reranked
      : this.applyImportanceWeight(this.applyRecencyBoost(reranked));

    // Apply length normalization (penalize long entries dominating via keyword density)
    const lengthNormalized = this.applyLengthNormalization(temporallyRanked);

    // Hard minimum score cutoff should be based on semantic / lexical relevance.
    // Lifecycle decay and time-decay are used for re-ranking, not for dropping
    // otherwise relevant fresh memories.
    const hardFiltered = lengthNormalized.filter(r => r.score >= this.config.hardMinScore);

    // Apply lifecycle-aware decay or legacy time decay after thresholding
    const lifecycleRanked = this.decayEngine
      ? this.applyDecayBoost(hardFiltered)
      : this.applyTimeDecay(hardFiltered);

    // Filter noise
    const denoised = this.config.filterNoise
      ? filterNoise(lifecycleRanked, r => r.entry.text)
      : lifecycleRanked;

    // MMR deduplication: avoid top-k filled with near-identical memories
    const deduplicated = this.applyMMRDiversity(denoised);

    return deduplicated.slice(0, limit);
  }

  private async runVectorSearch(
    queryVector: number[],
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    const results = await this.store.vectorSearch(
      queryVector,
      limit,
      0.1,
      scopeFilter,
    );

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async runBM25Search(
    query: string,
    limit: number,
    scopeFilter?: string[],
    category?: string,
  ): Promise<Array<MemorySearchResult & { rank: number }>> {
    // Expand date formats for better BM25 matching
    const expandedQuery = this.expandDateFormats(query);
    const results = await this.store.bm25Search(expandedQuery, limit, scopeFilter);

    // Filter by category if specified
    const filtered = category
      ? results.filter((r) => r.entry.category === category)
      : results;

    return filtered.map((result, index) => ({
      ...result,
      rank: index + 1,
    }));
  }

  private async fuseResults(
    vectorResults: Array<MemorySearchResult & { rank: number }>,
    bm25Results: Array<MemorySearchResult & { rank: number }>,
  ): Promise<RetrievalResult[]> {
    // Create maps for quick lookup
    const vectorMap = new Map<string, MemorySearchResult & { rank: number }>();
    const bm25Map = new Map<string, MemorySearchResult & { rank: number }>();

    vectorResults.forEach((result) => {
      vectorMap.set(result.entry.id, result);
    });

    bm25Results.forEach((result) => {
      bm25Map.set(result.entry.id, result);
    });

    // Get all unique document IDs
    const allIds = new Set([...vectorMap.keys(), ...bm25Map.keys()]);

    // Calculate RRF scores
    const fusedResults: RetrievalResult[] = [];

    for (const id of allIds) {
      const vectorResult = vectorMap.get(id);
      const bm25Result = bm25Map.get(id);

      // FIX(#15): BM25-only results may be "ghost" entries whose vector data was
      // deleted but whose FTS index entry lingers until the next index rebuild.
      // Validate that the entry actually exists in the store before including it.
      if (!vectorResult && bm25Result) {
        try {
          const exists = await this.store.hasId(id);
          if (!exists) continue; // Skip ghost entry
        } catch {
          // If hasId fails, keep the result (fail-open)
        }
      }

      // Use the result with more complete data (prefer vector result if both exist)
      const baseResult = vectorResult || bm25Result!;

      // Use vector similarity as the base score.
      // BM25 hit acts as a bonus (keyword match confirms relevance).
      const vectorScore = vectorResult ? vectorResult.score : 0;
      const bm25Score = bm25Result ? bm25Result.score : 0;
      // Weighted fusion: vectorWeight/bm25Weight directly control score blending.
      // BM25 high-score floor (>= 0.75) preserves exact keyword matches
      // (e.g. API keys, ticket numbers) that may have low vector similarity.
      const weightedFusion = (vectorScore * this.config.vectorWeight)
                           + (bm25Score * this.config.bm25Weight);
      const fusedScore = vectorResult
        ? clamp01(
          Math.max(
            weightedFusion,
            bm25Score >= 0.75 ? bm25Score * 0.92 : 0,
          ),
          0.1,
        )
        : clamp01(bm25Result!.score, 0.1);

      fusedResults.push({
        entry: baseResult.entry,
        score: fusedScore,
        sources: {
          vector: vectorResult
            ? { score: vectorResult.score, rank: vectorResult.rank }
            : undefined,
          bm25: bm25Result
            ? { score: bm25Result.score, rank: bm25Result.rank }
            : undefined,
          fused: { score: fusedScore },
        },
      });
    }

    // Sort by fused score descending (Graphiti handled in outer retrieve())
    return fusedResults.sort((a, b) => b.score - a.score);
  }

  /**
   * Rerank results using cross-encoder API (Jina, Pinecone, or compatible).
   * Falls back to cosine similarity if API is unavailable or fails.
   */
  private async rerankResults(
    query: string,
    queryVector: number[],
    results: RetrievalResult[],
  ): Promise<RetrievalResult[]> {
    if (results.length === 0) {
      return results;
    }

    // Try cross-encoder rerank via configured provider API
    if (process.env.MNEMO_DEBUG) {
      log.debug(`[rerank] rerank=${this.config.rerank}, provider=${this.config.rerankProvider}, model=${this.config.rerankModel}`);
    }
    const isLocalRerank = this.config.rerankProvider === "ollama";
    if (this.config.rerank === "cross-encoder" && (this.config.rerankApiKey || isLocalRerank)) {
      try {
        const provider = this.config.rerankProvider || "jina";
        const model = this.config.rerankModel || (isLocalRerank ? "bge-reranker-v2-m3" : "jina-reranker-v3");
        const endpoint =
          this.config.rerankEndpoint || (isLocalRerank ? "http://127.0.0.1:11434/api/rerank" : "https://api.jina.ai/v1/rerank");
        // Feed L0+L1 to reranker for better semantic matching
        const documents = results.map((r) => {
          try {
            const meta = JSON.parse(r.entry.metadata || "{}");
            const overview = meta.l1_overview || "";
            return overview ? `${r.entry.text}\n${overview}` : r.entry.text;
          } catch {
            return r.entry.text;
          }
        });

        // Build provider-specific request
        const { headers, body } = buildRerankRequest(
          provider,
          this.config.rerankApiKey,
          model,
          query,
          documents,
          results.length,
        );

        // Timeout: 5 seconds to prevent stalling retrieval pipeline
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 5000);

        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        clearTimeout(timeout);

        if (response.ok) {
          const data = (await response.json()) as Record<string, unknown>;

          // Parse provider-specific response into unified format
          const parsed = parseRerankResponse(provider, data);

          if (!parsed) {
            log.warn(
              "Rerank API: invalid response shape, falling back to cosine",
            );
          } else {
            // Build a Set of returned indices to identify unreturned candidates
            const returnedIndices = new Set(parsed.map((r) => r.index));

            const reranked = parsed
              .filter((item) => item.index >= 0 && item.index < results.length)
              .map((item) => {
                const original = results[item.index];
                const floor = this.getRerankPreservationFloor(original, false);
                // Blend: 60% cross-encoder score + 40% original fused score
                const blendedScore = clamp01WithFloor(
                  item.score * 0.6 + original.score * 0.4,
                  floor,
                );
                return {
                  ...original,
                  score: blendedScore,
                  sources: {
                    ...original.sources,
                    reranked: { score: item.score },
                  },
                };
              });

            // Keep unreturned candidates with their original scores (slightly penalized)
            const unreturned = results
              .filter((_, idx) => !returnedIndices.has(idx))
              .map(r => ({
                ...r,
                score: clamp01WithFloor(
                  r.score * 0.8,
                  this.getRerankPreservationFloor(r, true),
                ),
              }));

            return [...reranked, ...unreturned].sort(
              (a, b) => b.score - a.score,
            );
          }
        } else {
          const errText = await response.text().catch(() => "");
          log.warn(
            `Rerank API returned ${response.status}: ${errText.slice(0, 200)}, falling back to cosine`,
          );
        }
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          log.warn("Rerank API timed out (5s), falling back to cosine");
        } else {
          log.warn("Rerank API failed, falling back to cosine:", error);
        }
      }
    }

    // Fallback: lightweight cosine similarity rerank
    try {
      const reranked = results.map((result) => {
        // Skip cosine for entries without valid vectors (e.g. Graphiti facts)
        if (!result.entry.vector || result.entry.vector.length === 0 || !queryVector || queryVector.length === 0) {
          return result;
        }
        const cosineScore = cosineSimilarity(queryVector, result.entry.vector);
        const combinedScore = result.score * 0.7 + cosineScore * 0.3;

        return {
          ...result,
          score: clamp01(combinedScore, result.score),
          sources: {
            ...result.sources,
            reranked: { score: cosineScore },
          },
        };
      });

      return reranked.sort((a, b) => b.score - a.score);
    } catch (error) {
      log.warn("Reranking failed, returning original results:", error);
      return results;
    }
  }

  private getRerankPreservationFloor(result: RetrievalResult, unreturned: boolean): number {
    const bm25Score = result.sources.bm25?.score ?? 0;

    // Exact lexical hits (IDs, env vars, ticket numbers) should not disappear
    // just because a reranker under-scores symbolic or mixed-language queries.
    if (bm25Score >= 0.75) {
      return result.score * (unreturned ? 1.0 : 0.95);
    }
    if (bm25Score >= 0.6) {
      return result.score * (unreturned ? 0.95 : 0.9);
    }
    return result.score * (unreturned ? 0.8 : 0.5);
  }

  /**
   * Apply recency boost: newer memories get a small score bonus.
   * This ensures corrections/updates naturally outrank older entries
   * when semantic similarity is close.
   * Formula: boost = exp(-ageDays / halfLife) * weight
   */
  private applyRecencyBoost(results: RetrievalResult[]): RetrievalResult[] {
    const { recencyHalfLifeDays, recencyWeight } = this.config;
    if (!recencyHalfLifeDays || recencyHalfLifeDays <= 0 || !recencyWeight) {
      return results;
    }

    const now = Date.now();
    const boosted = results.map((r) => {
      const ts =
        r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;
      const boost = Math.exp(-ageDays / recencyHalfLifeDays) * recencyWeight;
      return {
        ...r,
        score: clamp01(r.score + boost, r.score),
      };
    });

    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Apply importance weighting: memories with higher importance get a score boost.
   * This ensures critical memories (importance=1.0) outrank casual ones (importance=0.5)
   * when semantic similarity is close.
   * Formula: score *= (baseWeight + (1 - baseWeight) * importance)
   * With baseWeight=0.7: importance=1.0 → ×1.0, importance=0.5 → ×0.85, importance=0.0 → ×0.7
   */
  private applyImportanceWeight(results: RetrievalResult[]): RetrievalResult[] {
    const baseWeight = 0.7;
    const weighted = results.map((r) => {
      const importance = r.entry.importance ?? 0.7;
      const factor = baseWeight + (1 - baseWeight) * importance;
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * baseWeight),
      };
    });
    return weighted.sort((a, b) => b.score - a.score);
  }

  private applyDecayBoost(results: RetrievalResult[]): RetrievalResult[] {
    if (!this.decayEngine || results.length === 0) return results;

    const scored = results.map((result) => ({
      memory: toLifecycleMemory(result.entry.id, result.entry),
      score: result.score,
    }));

    // Adaptive: blend decay influence based on corpus size.
    // /500 ensures decay is gentle at small corpora (14% at ~140 memories)
    // and dominant at large corpora (80% at ~1000 memories).
    const alpha = Math.max(0, 1 - results.length / 500);
    this.decayEngine.applySearchBoost(scored);

    const reranked = results.map((result, index) => ({
      ...result,
      score: clamp01(
        alpha * result.score + (1 - alpha) * scored[index].score,
        result.score * 0.3,
      ),
    }));

    return reranked.sort((a, b) => b.score - a.score);
  }

  /**
   * Detect multi-hop queries that involve multiple entities or relationships.
   * Multi-hop queries benefit from LanceDB secondary retrieval rather than
   * Graphiti spread (which follows single-entity neighborhoods).
   */
  private isMultiHopQuery(query: string): boolean {
    // Count distinct capitalized words (potential entity names, >= 2 chars)
    const capitalizedWords = new Set(
      (query.match(/\b[A-Z\u4e00-\u9fff][a-zA-Z\u4e00-\u9fff]{1,}/g) || [])
    );
    if (capitalizedWords.size >= 2) return true;

    // Relationship / comparison patterns
    const relationPatterns = [
      /和.{1,20}的关系/,
      /compared\s+to/i,
      /difference\s+between/i,
      /为什么/,
      /how\s+does\s+.{1,30}\s+relate\s+to/i,
      /between\s+.{1,30}\s+and\s+/i,
      /相比/,
      /区别/,
      /之间/,
    ];
    for (const pat of relationPatterns) {
      if (pat.test(query)) return true;
    }

    // Long query with question mark
    if (query.length > 100 && /[?？]/.test(query)) return true;

    return false;
  }

  /**
   * via sheer keyword density and broad semantic coverage.
   * Short, focused entries (< anchor) get a slight boost.
   * Long, sprawling entries (> anchor) get penalized.
   * Formula: score *= 1 / (1 + log2(charLen / anchor))
   */
  private applyLengthNormalization(
    results: RetrievalResult[],
  ): RetrievalResult[] {
    const anchor = this.config.lengthNormAnchor;
    if (!anchor || anchor <= 0) return results;

    const normalized = results.map((r) => {
      const charLen = r.entry.text.length;
      const ratio = charLen / anchor;
      // No penalty for entries at or below anchor length.
      // Gentle logarithmic decay for longer entries:
      //   anchor (500) → 1.0, 800 → 0.75, 1000 → 0.67, 1500 → 0.56, 2000 → 0.50
      // This prevents long, keyword-rich entries from dominating top-k
      // while keeping their scores reasonable.
      const logRatio = Math.log2(Math.max(ratio, 1)); // no boost for short entries
      const factor = 1 / (1 + 0.5 * logRatio);
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.3),
      };
    });

    return normalized.sort((a, b) => b.score - a.score);
  }

  /**
   * Time decay: multiplicative penalty for old entries.
   * Unlike recencyBoost (additive bonus for new entries), this actively
   * penalizes stale information so recent knowledge wins ties.
   * Formula: score *= 0.5 + 0.5 * exp(-ageDays / halfLife)
   * At 0 days: 1.0x (no penalty)
   * At halfLife: ~0.68x
   * At 2*halfLife: ~0.59x
   * Floor at 0.5x (never penalize more than half)
   */
  private applyTimeDecay(results: RetrievalResult[]): RetrievalResult[] {
    const halfLife = this.config.timeDecayHalfLifeDays;
    if (!halfLife || halfLife <= 0) return results;

    const now = Date.now();
    const decayed = results.map((r) => {
      const ts =
        r.entry.timestamp && r.entry.timestamp > 0 ? r.entry.timestamp : now;
      const ageDays = (now - ts) / 86_400_000;

      // Access reinforcement: frequently recalled memories decay slower
      const { accessCount, lastAccessedAt } = parseAccessMetadata(
        r.entry.metadata,
      );
      const effectiveHL = computeEffectiveHalfLife(
        halfLife,
        accessCount,
        lastAccessedAt,
        this.config.reinforcementFactor,
        this.config.maxHalfLifeMultiplier,
      );

      // floor at 0.5: even very old entries keep at least 50% of their score
      const factor = 0.5 + 0.5 * Math.exp(-ageDays / effectiveHL);
      return {
        ...r,
        score: clamp01(r.score * factor, r.score * 0.5),
      };
    });

    return decayed.sort((a, b) => b.score - a.score);
  }

  /**
   * Apply lifecycle-aware score adjustment (decay + tier floors).
   *
   * This is intentionally lightweight:
   * - reads tier/access metadata (if any)
   * - multiplies scores by max(tierFloor, decayComposite)
   */
  private applyLifecycleBoost(results: RetrievalResult[]): RetrievalResult[] {
    if (!this.decayEngine) return results;

    const now = Date.now();
    const pairs = results.map(r => {
      const { memory } = getDecayableFromEntry(r.entry);
      return { r, memory };
    });

    const scored = pairs.map(p => ({ memory: p.memory, score: p.r.score }));
    this.decayEngine.applySearchBoost(scored, now);

    // Adaptive blend: at small N, trust base score more; at large N, trust decay more
    const alpha = Math.max(0, 1 - results.length / 200);
    const boosted = pairs.map((p, i) => ({
      ...p.r,
      score: alpha * p.r.score + (1 - alpha) * scored[i].score,
    }));
    return boosted.sort((a, b) => b.score - a.score);
  }

  /**
   * Record access stats (access_count, last_accessed_at) and apply tier
   * promotion/demotion for a small number of top results.
   *
   * Note: this writes back to LanceDB via delete+readd; keep it bounded.
   */
  private async recordAccessAndMaybeTransition(results: RetrievalResult[]): Promise<void> {
    if (!this.decayEngine && !this.tierManager) return;

    const now = Date.now();
    const toUpdate = results.slice(0, 1);

    for (const r of toUpdate) {
      const { memory, meta } = getDecayableFromEntry(r.entry);

      // Update access stats in-memory first
      const nextAccess = memory.accessCount + 1;
      meta.access_count = nextAccess;
      meta.last_accessed_at = now;
      if (meta.created_at === undefined && meta.createdAt === undefined) {
        meta.created_at = memory.createdAt;
      }
      if (meta.tier === undefined) {
        meta.tier = memory.tier;
      }
      if (meta.confidence === undefined) {
        meta.confidence = memory.confidence;
      }

      const updatedMemory: DecayableMemory = {
        ...memory,
        accessCount: nextAccess,
        lastAccessedAt: now,
      };

      // Tier transition (optional)
      if (this.decayEngine && this.tierManager) {
        const ds = this.decayEngine.score(updatedMemory, now);
        const transition = this.tierManager.evaluate(updatedMemory, ds, now);
        if (transition) {
          meta.tier = transition.toTier;
        }
      }

      try {
        await this.store.update(r.entry.id, {
          metadata: JSON.stringify(meta),
        });
      } catch {
        // best-effort: ignore
      }
    }
  }

  /**
   * MMR-inspired diversity filter: greedily select results that are both
   * relevant (high score) and diverse (low similarity to already-selected).
   *
   * Uses cosine similarity between memory vectors. If two memories have
   * cosine similarity > threshold (default 0.92), the lower-scored one
   * is demoted to the end rather than removed entirely.
   *
   * This prevents top-k from being filled with near-identical entries
   * (e.g. 3 similar "SVG style" memories) while keeping them available
   * if the pool is small.
   */
  private applyMMRDiversity(
    results: RetrievalResult[],
    similarityThreshold = 0.85,
  ): RetrievalResult[] {
    if (results.length <= 1) return results;

    const selected: RetrievalResult[] = [];
    const deferred: RetrievalResult[] = [];

    for (const candidate of results) {
      // Check if this candidate is too similar to any already-selected result
      const tooSimilar = selected.some((s) => {
        // Both must have vectors to compare.
        // LanceDB returns Arrow Vector objects (not plain arrays),
        // so use .length directly and Array.from() for conversion.
        const sVec = s.entry.vector;
        const cVec = candidate.entry.vector;
        if (!sVec?.length || !cVec?.length) return false;
        const sArr = Array.from(sVec as Iterable<number>);
        const cArr = Array.from(cVec as Iterable<number>);
        const sim = cosineSimilarity(sArr, cArr);
        return sim > similarityThreshold;
      });

      if (tooSimilar) {
        deferred.push(candidate);
      } else {
        selected.push(candidate);
      }
    }
    // Append deferred results at the end (available but deprioritized)
    return [...selected, ...deferred];
  }

  // Update configuration
  updateConfig(newConfig: Partial<RetrievalConfig>): void {
    this.config = { ...this.config, ...newConfig };
  }

  // Get current configuration
  getConfig(): RetrievalConfig {
    return { ...this.config };
  }

  // Test retrieval system
  async test(query = "test query"): Promise<{
    success: boolean;
    mode: string;
    hasFtsSupport: boolean;
    error?: string;
  }> {
    try {
      const results = await this.retrieve({
        query,
        limit: 1,
      });

      return {
        success: true,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
      };
    } catch (error) {
      return {
        success: false,
        mode: this.config.mode,
        hasFtsSupport: this.store.hasFtsSupport,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ============================================================================
// Factory Function
// ============================================================================

export interface RetrieverLifecycleOptions {
  decayEngine?: DecayEngine;
  tierManager?: TierManager;
}

export function createRetriever(
  store: MemoryStore,
  embedder: Embedder,
  config?: Partial<RetrievalConfig>,
  options?: { decayEngine?: DecayEngine | null },
): MemoryRetriever {
  const fullConfig = { ...DEFAULT_RETRIEVAL_CONFIG, ...config };
  return new MemoryRetriever(store, embedder, fullConfig, options?.decayEngine ?? null);
}

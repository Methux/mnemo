// SPDX-License-Identifier: MIT
/**
 * Semantic Noise Gate
 *
 * Pre-filters memory candidates by checking their embedding similarity against
 * domain-relevant anchor texts. Fragments that are too far from any anchor are
 * rejected as noise before reaching the dedup or store pipeline.
 */

import type { Embedder } from "./embedder.js";
import { appendFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";

// ============================================================================
// Anchor Texts
// ============================================================================

const ANCHOR_TEXTS = [
  "投资决策 估值分析 持仓管理 尽职调查",
  "个人偏好 日常习惯 人际关系 生活方式",
  "技术架构 系统设计 代码实现 工程优化",
] as const;

// ============================================================================
// Cosine Similarity
// ============================================================================

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

// ============================================================================
// Semantic Gate
// ============================================================================

const FILTER_LOG_PATH = join(homedir(), ".mnemo", "data", "store-filtered.log");

export class SemanticGate {
  private anchorEmbeddings: number[][] | null = null;
  private initPromise: Promise<void> | null = null;
  private readonly threshold: number;

  constructor(
    private readonly embedder: Embedder,
    threshold = 0.20,
  ) {
    this.threshold = threshold;
  }

  private async ensureInitialized(): Promise<void> {
    if (this.anchorEmbeddings) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = this.computeAnchors().catch((err) => {
      this.initPromise = null;
      throw err;
    });
    return this.initPromise;
  }

  private async computeAnchors(): Promise<void> {
    const embeddings: number[][] = [];
    for (const text of ANCHOR_TEXTS) {
      const vec = await this.embedder.embed(text);
      embeddings.push(vec);
    }
    this.anchorEmbeddings = embeddings;
  }

  /**
   * Check whether a memory vector passes the semantic gate.
   * Returns true if the memory is relevant enough to persist.
   */
  async shouldPass(vector: number[], text: string): Promise<boolean> {
    try {
      await this.ensureInitialized();
    } catch {
      // If anchor computation fails, pass everything through
      return true;
    }

    if (!this.anchorEmbeddings || this.anchorEmbeddings.length === 0) {
      return true;
    }

    let maxSim = 0;
    for (const anchor of this.anchorEmbeddings) {
      const sim = cosineSimilarity(vector, anchor);
      if (sim > maxSim) maxSim = sim;
    }

    if (maxSim < this.threshold) {
      // Log filtered content
      this.logFiltered(text, maxSim).catch(() => {});
      return false;
    }

    return true;
  }

  private async logFiltered(text: string, maxSim: number): Promise<void> {
    try {
      await mkdir(dirname(FILTER_LOG_PATH), { recursive: true });
      const line = `${new Date().toISOString()} maxSim=${maxSim.toFixed(4)} text=${text.slice(0, 200).replace(/\n/g, " ")}\n`;
      await appendFile(FILTER_LOG_PATH, line, "utf8");
    } catch {
      // Non-critical
    }
  }
}

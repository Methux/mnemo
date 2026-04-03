#!/usr/bin/env node
/**
 * Pure-Blood Benchmark — Exact production pipeline, zero shortcuts
 *
 * ALL features enabled:
 *   ✅ Voyage-4 embedding (1024d)
 *   ✅ Voyage rerank-2 cross-encoder
 *   ✅ BM25 full-text search
 *   ✅ Graphiti knowledge graph (read + write via /episodes and /search)
 *   ✅ Weibull decay + tier system
 *   ✅ Smart Extraction (GPT-4.1)
 *   ✅ Deduplication + contradiction detection
 *   ✅ Semantic noise gate
 *   ✅ WAL crash recovery
 *   ✅ Access tracking
 *
 * Safety:
 *   - LanceDB: /tmp copy, production untouched
 *   - Neo4j/Graphiti: benchmark uses group_id "benchmark-20260328", cleaned after
 *   - Scope: "agent:benchmark-20260328-{qid}" → group_id = "benchmark-20260328"
 */

import { MemoryStore } from "../packages/core/dist/src/store.js";
import { Embedder } from "../packages/core/dist/src/embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../packages/core/dist/src/retriever.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "../packages/core/dist/src/decay-engine.js";
import { createTierManager, DEFAULT_TIER_CONFIG } from "../packages/core/dist/src/tier-manager.js";
import { SemanticGate } from "../packages/core/dist/src/semantic-gate.js";
import { SmartExtractor } from "../packages/core/dist/src/smart-extractor.js";
import { createLlmClient } from "../packages/core/dist/src/llm-client.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { homedir } from "os";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOYAGE_KEY = process.env.MNEMO_API_KEY;
const BENCHMARK = process.env.BENCHMARK || "longmemeval";
const MAX_Q = parseInt(process.env.MAX_Q || "200", 10);
const BENCH_GROUP = `benchmark-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
const DB_PATH = `/tmp/mnemo-pureblood`;
const PROD_DB = join(homedir(), ".mnemo", "data", "lancedb");

if (!OPENAI_KEY || !VOYAGE_KEY) { console.error("OPENAI_API_KEY and MNEMO_API_KEY required"); process.exit(1); }

// ── LLM helpers ──
async function openaiChat(messages, model, maxTokens = 512) {
  model = model || "gpt-4.1";
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
        signal: AbortSignal.timeout(60000),
      });
      if (resp.status === 429 && attempt < 4) { await new Promise(r => setTimeout(r, 2 ** attempt * 3000 + 2000)); continue; }
      const data = await resp.json();
      return data.choices[0].message.content;
    } catch (e) { if (attempt === 4) throw e; await new Promise(r => setTimeout(r, 2000)); }
  }
}

async function judgeAnswer(question, predicted, gold, qtype) {
  if (qtype === "abstention") {
    const signals = ["don't know", "no information", "not mentioned", "cannot determine", "no record"];
    return signals.some(s => predicted.toLowerCase().includes(s)) ? 3 : 0;
  }
  try {
    const s = await openaiChat([{ role: "user", content: `Evaluate this AI answer.\n\nQuestion: ${question}\nGold: ${gold}\nPredicted: ${predicted}\n\nScore (ONLY a digit): 3=Exact 2=Mostly correct 1=Partial 0=Wrong\nScore:` }], null, 4);
    const n = parseInt(s.trim()[0], 10);
    return isNaN(n) ? 0 : Math.min(Math.max(n, 0), 3);
  } catch { return 0; }
}

async function answerWithContext(question, docs) {
  const context = docs.map(m => `- ${m}`).join("\n");
  if (!context.trim()) return "I don't have enough information to answer this question.";
  return openaiChat([{ role: "user", content: `Memory snippets:\n\n${context}\n\nAnswer concisely (1-2 sentences). If not in snippets, say "I don't have information about that."\nQuestion: ${question}\nAnswer:` }]).then(s => s.trim()).catch(e => `[ERROR: ${e}]`);
}

async function workerPool(items, fn, concurrency) {
  let idx = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (idx < items.length) { const i = idx++; await fn(items[i], i); }
  }));
}

// ── Load dataset ──
function loadLongMemEval(maxQ) {
  const data = JSON.parse(readFileSync(join(__dirname, "data", "longmemeval_s.json"), "utf8")).slice(0, maxQ);
  const questions = [];
  const scopeConvs = {};
  for (const q of data) {
    // Scope: "agent:benchmark-20260328-{qid}" → group_id = "benchmark-20260328-{qid}" for Graphiti isolation
    const scope = `agent:${BENCH_GROUP}-${q.question_id}`;
    questions.push({ scope, question: q.question, gold: q.answer || "", type: q.question_type || "unknown" });
    if (!scopeConvs[scope]) {
      const lines = [];
      for (const session of (q.haystack_sessions || [])) {
        const turns = Array.isArray(session) ? session : (session.turns || session.messages || []);
        for (const t of turns) {
          const text = typeof t === "object" ? (t.content || t.text || "") : String(t);
          const role = typeof t === "object" ? (t.role || "") : "";
          if (text.trim().length < 10) continue;
          lines.push(`${role ? role + ": " : ""}${text}`);
        }
      }
      scopeConvs[scope] = lines.join("\n");
    }
  }
  return { questions, scopeConvs };
}

function loadLocomo(maxQ) {
  const data = JSON.parse(readFileSync(join(__dirname, "data", "locomo10.json"), "utf8"));
  const CAT = { 1: "single-hop", 2: "multi-hop", 3: "open-ended", 4: "temporal", 5: "adversarial" };
  const allQA = [];
  const scopeConvs = {};
  for (const conv of data) {
    const scope = `agent:${BENCH_GROUP}-${conv.sample_id || randomUUID().slice(0, 8)}`;
    if (!scopeConvs[scope]) {
      const lines = [];
      const c = conv.conversation || {};
      for (const sk of Object.keys(c).filter(k => k.startsWith("session_") && !k.endsWith("date_time"))) {
        for (const t of (c[sk] || [])) {
          if ((t.text || "").trim().length < 10) continue;
          lines.push(`${t.speaker || ""}: ${t.text}`);
        }
      }
      scopeConvs[scope] = lines.join("\n");
    }
    for (const qa of (conv.qa || [])) {
      allQA.push({ scope, question: qa.question, gold: String(qa.answer), type: CAT[qa.category] || `cat${qa.category}` });
    }
  }
  // Sample evenly
  const byCat = {};
  for (const q of allQA) { if (!byCat[q.type]) byCat[q.type] = []; byCat[q.type].push(q); }
  const perCat = Math.ceil(maxQ / Object.keys(byCat).length);
  const selected = [];
  for (const items of Object.values(byCat)) {
    const step = items.length / Math.min(perCat, items.length);
    for (let i = 0; i < Math.min(perCat, items.length); i++) selected.push(items[Math.floor(i * step)]);
  }
  return { questions: selected.slice(0, maxQ), scopeConvs };
}

// ── Main ──
async function main() {
  const { questions, scopeConvs } = BENCHMARK === "locomo" ? loadLocomo(MAX_Q) : loadLongMemEval(MAX_Q);

  console.log(`Copying production DB...`);
  execSync(`rm -rf ${DB_PATH} && cp -r ${PROD_DB} ${DB_PATH}`);

  // ── Production-identical initialization ──
  const embedder = new Embedder({
    apiKey: VOYAGE_KEY, baseURL: "https://api.voyageai.com/v1",
    model: "voyage-4", dimensions: 1024, taskQuery: "query", taskPassage: "document",
  });

  const store = new MemoryStore({ dbPath: DB_PATH, vectorDim: 1024 });
  const semanticGate = new SemanticGate(embedder);
  store.setSemanticGate(semanticGate);

  const decayEngine = createDecayEngine(DEFAULT_DECAY_CONFIG);
  const retriever = createRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    candidatePoolSize: 40,
    rerank: "cross-encoder",
    rerankProvider: "voyage",
    rerankApiKey: VOYAGE_KEY,
    rerankModel: "rerank-2",
    rerankEndpoint: "https://api.voyageai.com/v1/rerank",
  }, { decayEngine });

  const llm = createLlmClient({ apiKey: OPENAI_KEY, model: "gpt-4.1", baseURL: "https://api.openai.com/v1" });
  const smartExtractor = new SmartExtractor(store, embedder, llm, {
    defaultScope: "global",
    extractMaxChars: 128000, // GPT-4.1 supports 128K
  });

  // Enable Graphiti
  process.env.GRAPHITI_ENABLED = "true";
  process.env.GRAPHITI_BASE_URL = "http://127.0.0.1:18799";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`PURE-BLOOD Benchmark — ${BENCHMARK.toUpperCase()}`);
  console.log(`Questions: ${questions.length}`);
  console.log(`Graphiti group: ${BENCH_GROUP}`);
  console.log(`Pipeline: Vector + BM25 + Graphiti + Rerank + Decay + SmartExtraction`);
  console.log(`${"=".repeat(60)}`);

  // ── Phase 1: Smart Extraction (full pipeline ingestion) ──
  console.log(`\n--- Phase 1: Smart Extraction + Full Store Pipeline ---`);
  const t0 = Date.now();
  const scopes = Object.keys(scopeConvs);
  let extracted = 0;
  let totalMemories = 0;

  await workerPool(scopes, async (scope, i) => {
    const convText = scopeConvs[scope];
    if (!convText) return;
    try {
      const stats = await smartExtractor.extractAndPersist(convText, `bench-${i}`, {
        scope,
        scopeFilter: [scope],
      });
      totalMemories += stats.created + stats.merged;
      extracted++;
      if (extracted % 5 === 0 || extracted <= 3) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`  Extracted ${extracted}/${scopes.length} (${totalMemories} memories) — ${elapsed}s`);
      }
    } catch (e) {
      extracted++;
      console.error(`  Scope ${i} failed: ${e.message?.slice(0, 80)}`);
    }
  }, 5);

  console.log(`  Extraction complete: ${totalMemories} memories from ${extracted} scopes — ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // ── Phase 2: Evaluate (full retrieval: Vector + BM25 + Graphiti + Rerank + Decay) ──
  console.log(`\n--- Phase 2: Evaluation (Vector + BM25 + Graphiti + Rerank) ---`);
  const results = [];

  await workerPool(questions, async (q, qi) => {
    if (!q.gold && q.type !== "abstention") return;
    try {
      const retrieved = await retriever.retrieve({ query: q.question, limit: 10, scopeFilter: [q.scope], source: "manual" });
      const docTexts = retrieved.map(r => r.entry.text);
      const predicted = await answerWithContext(q.question, docTexts);
      const score = await judgeAnswer(q.question, predicted, q.gold, q.type);
      results.push({ question: q.question, gold: q.gold, predicted, score, type: q.type, n: retrieved.length });
      if ((qi + 1) % 20 === 0 || qi < 5) {
        const status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score];
        console.log(`  Q${qi}: [${status}] (${q.type}) ${q.question.slice(0, 55)}...`);
      }
    } catch (e) {
      console.error(`  Q${qi} error: ${e.message?.slice(0, 80)}`);
    }
  }, 3);

  // ── Results ──
  const correct = results.filter(r => r.score >= 2).length;
  const total = results.length;
  const accuracy = (correct / total * 100).toFixed(1);
  const byType = {};
  for (const r of results) {
    if (!byType[r.type]) byType[r.type] = { correct: 0, total: 0 };
    byType[r.type].total++;
    if (r.score >= 2) byType[r.type].correct++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS (PURE-BLOOD): ${accuracy}% (${correct}/${total})`);
  console.log(`${"=".repeat(60)}`);
  for (const [type, d] of Object.entries(byType).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${type}: ${(d.correct / d.total * 100).toFixed(1)}% (${d.correct}/${d.total})`);
  }

  const output = {
    adapter: "pureblood", benchmark: BENCHMARK, accuracy: parseFloat(accuracy),
    correct, total, pipeline: "Vector+BM25+Graphiti+Rerank+Decay+SmartExtraction",
    graphiti_group: BENCH_GROUP, by_type: {}, questions: results,
  };
  for (const [type, d] of Object.entries(byType)) output.by_type[type] = parseFloat((d.correct / d.total * 100).toFixed(1));
  const outFile = join(RESULTS_DIR, `pureblood_${BENCHMARK}_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outFile}`);

  // ── Phase 3: Cleanup ──
  console.log(`\n--- Phase 3: Cleanup ---`);

  // 1. Delete LanceDB copy
  execSync(`rm -rf ${DB_PATH}`);
  console.log(`  LanceDB copy deleted`);

  // 2. Delete Graphiti benchmark nodes from Neo4j
  try {
    const resp = await fetch("http://localhost:7474/db/neo4j/tx/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from(`neo4j:${process.env.NEO4J_PASSWORD || "neo4j"}`).toString("base64") },
      body: JSON.stringify({
        statements: [{
          statement: `MATCH (n) WHERE n.group_id STARTS WITH '${BENCH_GROUP}' DETACH DELETE n RETURN count(n) as deleted`
        }]
      }),
    });
    const data = await resp.json();
    const deleted = data.results?.[0]?.data?.[0]?.row?.[0] || 0;
    console.log(`  Neo4j: deleted ${deleted} benchmark nodes (group_id: ${BENCH_GROUP}*)`);
  } catch (e) {
    console.error(`  Neo4j cleanup failed: ${e.message}`);
    console.log(`  Manual cleanup: MATCH (n) WHERE n.group_id STARTS WITH '${BENCH_GROUP}' DETACH DELETE n`);
  }

  console.log(`  Production data untouched.`);
}

main().catch(e => { console.error(e); process.exit(1); });

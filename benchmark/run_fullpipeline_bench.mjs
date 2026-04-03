#!/usr/bin/env node
/**
 * Full Pipeline Benchmark — Replicates exact production initialization
 *
 * Uses DB COPY + same config as production plugin:
 *   - Voyage-4 embedding (1024d, query/document tasks)
 *   - Voyage rerank-2 cross-encoder
 *   - Weibull decay + tier system
 *   - Scope isolation (locomo-bench-*)
 *   - Dedup OFF for ingestion speed (benchmark turns don't repeat)
 *
 * Graphiti is NOT included (requires live Neo4j connection to production graph).
 * This tests Vector + BM25 + Rerank (2 of 3 retrieval paths).
 *
 * Safety: runs on /tmp copy, production DB untouched.
 */

import { MemoryStore } from "../packages/core/dist/src/store.js";
import { Embedder } from "../packages/core/dist/src/embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../packages/core/dist/src/retriever.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "../packages/core/dist/src/decay-engine.js";
import { createTierManager, DEFAULT_TIER_CONFIG } from "../packages/core/dist/src/tier-manager.js";
import { SemanticGate } from "../packages/core/dist/src/semantic-gate.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOYAGE_KEY = process.env.MNEMO_API_KEY;
const BENCHMARK = process.env.BENCHMARK || "longmemeval";
const MAX_Q = parseInt(process.env.MAX_Q || "200", 10);
const ADAPTER = process.env.ADAPTER || "pro";

if (!OPENAI_KEY || !VOYAGE_KEY) { console.error("OPENAI_API_KEY and MNEMO_API_KEY required"); process.exit(1); }

// ── Production-identical config ──
const PROD_CONFIG = {
  embedding: {
    apiKey: VOYAGE_KEY,
    baseURL: "https://api.voyageai.com/v1",
    model: "voyage-4",
    dimensions: 1024,
    taskQuery: "query",
    taskPassage: "document",
  },
  retrieval: {
    candidatePoolSize: 40,
    rerank: "cross-encoder",
    rerankProvider: "voyage",
    rerankApiKey: VOYAGE_KEY,
    rerankModel: "rerank-2",
    rerankEndpoint: "https://api.voyageai.com/v1/rerank",
  },
};

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
  const prompt = `Evaluate this AI answer.\n\nQuestion: ${question}\nGold answer: ${gold}\nPredicted: ${predicted}\n\nScore (ONLY a digit):\n3 = Exact / semantically equivalent\n2 = Mostly correct\n1 = Partially correct\n0 = Wrong or "I don't know"\n\nScore:`;
  try { const s = await openaiChat([{ role: "user", content: prompt }], null, 4); const n = parseInt(s.trim()[0], 10); return isNaN(n) ? 0 : Math.min(Math.max(n, 0), 3); } catch { return 0; }
}

async function answerWithContext(question, docs) {
  const context = docs.map(m => `- ${m}`).join("\n");
  if (!context.trim()) return "I don't have enough information to answer this question.";
  return openaiChat([{ role: "user", content: `You have memory snippets from past conversations:\n\n${context}\n\nBased ONLY on the above, answer concisely (1-2 sentences):\nQuestion: ${question}\n\nIf not in the snippets, say "I don't have information about that."\nAnswer:` }]).then(s => s.trim()).catch(e => `[ERROR: ${e}]`);
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
  const scopeTurns = {};
  for (const q of data) {
    const scope = `locomo-bench-${q.question_id}`;
    questions.push({ scope, question: q.question, gold: q.answer || "", type: q.question_type || "unknown" });
    if (!scopeTurns[scope]) {
      scopeTurns[scope] = [];
      for (const session of (q.haystack_sessions || [])) {
        const turns = Array.isArray(session) ? session : (session.turns || session.messages || []);
        for (const t of turns) {
          const text = typeof t === "object" ? (t.content || t.text || "") : String(t);
          const role = typeof t === "object" ? (t.role || "") : "";
          if (text.trim().length < 10) continue;
          scopeTurns[scope].push(`${role ? role + ": " : ""}${text}`);
        }
      }
    }
  }
  return { questions, scopeTurns };
}

function loadLocomo(maxQ) {
  const data = JSON.parse(readFileSync(join(__dirname, "data", "locomo10.json"), "utf8"));
  const CAT = { 1: "single-hop", 2: "multi-hop", 3: "open-ended", 4: "temporal", 5: "adversarial" };
  const allQA = [];
  const scopeTurns = {};
  for (const conv of data) {
    const scope = `locomo-bench-${conv.sample_id || randomUUID().slice(0, 8)}`;
    if (!scopeTurns[scope]) {
      scopeTurns[scope] = [];
      const c = conv.conversation || {};
      for (const sk of Object.keys(c).filter(k => k.startsWith("session_") && !k.endsWith("date_time"))) {
        for (const t of (c[sk] || [])) {
          if ((t.text || "").trim().length < 10) continue;
          scopeTurns[scope].push(`${t.speaker || ""}: ${t.text}`);
        }
      }
    }
    for (const qa of (conv.qa || [])) {
      allQA.push({ scope, question: qa.question, gold: String(qa.answer), type: CAT[qa.category] || `cat${qa.category}` });
    }
  }
  // Sample evenly across categories
  const byCat = {};
  for (const q of allQA) { if (!byCat[q.type]) byCat[q.type] = []; byCat[q.type].push(q); }
  const perCat = Math.ceil(maxQ / Object.keys(byCat).length);
  const selected = [];
  for (const items of Object.values(byCat)) {
    const step = items.length / Math.min(perCat, items.length);
    for (let i = 0; i < Math.min(perCat, items.length); i++) selected.push(items[Math.floor(i * step)]);
  }
  return { questions: selected.slice(0, maxQ), scopeTurns };
}

// ── Main ──
async function main() {
  const { questions, scopeTurns } = BENCHMARK === "locomo" ? loadLocomo(MAX_Q) : loadLongMemEval(MAX_Q);
  const DB_PATH = `/tmp/mnemo-fullpipe-${ADAPTER}`;
  const PROD_DB = join(homedir(), ".mnemo", "data", "lancedb");

  console.log(`Copying production DB...`);
  const { execSync } = await import("child_process");
  execSync(`rm -rf ${DB_PATH} && cp -r ${PROD_DB} ${DB_PATH}`);

  // ── Initialize exactly like production plugin ──
  const embedder = new Embedder({
    apiKey: PROD_CONFIG.embedding.apiKey,
    baseURL: PROD_CONFIG.embedding.baseURL,
    model: PROD_CONFIG.embedding.model,
    dimensions: PROD_CONFIG.embedding.dimensions,
    taskQuery: PROD_CONFIG.embedding.taskQuery,
    taskPassage: PROD_CONFIG.embedding.taskPassage,
  });

  // Ingestion store: dedup off for speed
  const store = new MemoryStore({ dbPath: DB_PATH, vectorDim: 1024, deduplication: false, semanticGate: false });

  // Retrieval: full production config with rerank
  const decayEngine = createDecayEngine(DEFAULT_DECAY_CONFIG);
  const retriever = createRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    ...PROD_CONFIG.retrieval,
  }, { decayEngine });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`Full Pipeline Benchmark — ${ADAPTER.toUpperCase()} — ${BENCHMARK.toUpperCase()}`);
  console.log(`Questions: ${questions.length}, Rerank: Voyage rerank-2`);
  console.log(`DB: ${DB_PATH} (copy of production)`);
  console.log(`${"=".repeat(60)}`);

  // ── Phase 1: Ingest ──
  console.log(`\n--- Phase 1: Ingestion ---`);
  const t0 = Date.now();
  const allTurns = [];
  const benchScopes = new Set();
  for (const [scope, turns] of Object.entries(scopeTurns)) {
    benchScopes.add(scope);
    for (const text of turns) allTurns.push({ text, scope });
  }
  console.log(`  ${allTurns.length} turns from ${benchScopes.size} scopes`);

  // Batch embed
  const BATCH = 10;
  const allVectors = [];
  for (let i = 0; i < allTurns.length; i += BATCH) {
    const batch = allTurns.slice(i, i + BATCH).map(t => t.text);
    try {
      const vectors = await embedder.embedBatchPassage(batch);
      allVectors.push(...vectors);
    } catch (e) {
      console.error(`  Embed failed at ${i}: ${e.message?.slice(0, 80)}`);
      allVectors.push(...batch.map(() => null));
    }
    if (allVectors.length % 500 < BATCH) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (allVectors.length / (Date.now() - t0) * 1000).toFixed(1);
      console.log(`  Embedded ${allVectors.length}/${allTurns.length} — ${elapsed}s — ${rate}/s`);
    }
  }

  // Bulk write
  const { default: lancedb } = await import("@lancedb/lancedb");
  const db = await lancedb.connect(DB_PATH);
  const table = await db.openTable("memories");
  const rows = [];
  for (let i = 0; i < allTurns.length; i++) {
    if (!allVectors[i] || allVectors[i].length === 0) continue;
    rows.push({ id: randomUUID(), text: allTurns[i].text, vector: allVectors[i], category: "fact", importance: 0.7, scope: allTurns[i].scope, timestamp: Date.now(), metadata: "{}" });
  }
  for (let i = 0; i < rows.length; i += 2000) {
    await table.add(rows.slice(i, i + 2000));
  }
  console.log(`  Stored ${rows.length} — ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // ── Phase 2: Evaluate ──
  console.log(`\n--- Phase 2: Evaluation (rerank: voyage rerank-2) ---`);
  const results = [];
  let judged = 0;

  await workerPool(questions, async (q, qi) => {
    if (!q.gold && q.type !== "abstention") return;
    try {
      const retrieved = await retriever.retrieve({ query: q.question, limit: 10, scopeFilter: [q.scope], source: "manual" });
      const docTexts = retrieved.map(r => r.entry.text);
      const predicted = await answerWithContext(q.question, docTexts);
      const score = await judgeAnswer(q.question, predicted, q.gold, q.type);
      results.push({ question: q.question, gold: q.gold, predicted, score, type: q.type, n: retrieved.length });
      judged++;
      if (judged % 20 === 0 || judged <= 3) {
        const status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score];
        console.log(`  Q${qi}: [${status}] (${q.type}) ${q.question.slice(0, 55)}...`);
      }
    } catch (e) {
      console.error(`  Q${qi} failed: ${e.message?.slice(0, 80)}`);
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
  console.log(`RESULTS (${ADAPTER.toUpperCase()}): ${accuracy}% (${correct}/${total})`);
  console.log(`${"=".repeat(60)}`);
  for (const [type, d] of Object.entries(byType).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${type}: ${(d.correct / d.total * 100).toFixed(1)}% (${d.correct}/${d.total})`);
  }

  const output = { adapter: ADAPTER, benchmark: BENCHMARK, accuracy: parseFloat(accuracy), correct, total, rerank: "voyage-rerank-2", by_type: {}, questions: results };
  for (const [type, d] of Object.entries(byType)) output.by_type[type] = parseFloat((d.correct / d.total * 100).toFixed(1));
  const outFile = join(RESULTS_DIR, `fullpipe_${BENCHMARK}_${ADAPTER}_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outFile}`);

  // ── Cleanup ──
  console.log(`\nCleaning up DB copy...`);
  execSync(`rm -rf ${DB_PATH}`);
  console.log(`Done.`);
}

main().catch(e => { console.error(e); process.exit(1); });

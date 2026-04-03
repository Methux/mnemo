#!/usr/bin/env node
/**
 * Production Environment Benchmark
 *
 * Tests against the REAL production LanceDB with Pro modules loaded.
 * Uses isolated scopes (locomo-bench-*) — does NOT touch production data.
 * Cleans up all benchmark data after evaluation.
 *
 * Flow:
 *   1. Ingest LOCOMO data into production DB with "locomo-bench-*" scopes
 *   2. Run recall cycles (triggers Pro access tracking)
 *   3. Evaluate with GPT-4.1 judge
 *   4. Clean up all benchmark scopes
 */

import { MemoryStore } from "../packages/core/dist/src/store.js";
import { Embedder } from "../packages/core/dist/src/embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../packages/core/dist/src/retriever.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "../packages/core/dist/src/decay-engine.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "data", "longmemeval_s.json");
const LOCOMO_FILE = join(__dirname, "data", "locomo10.json");
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOYAGE_KEY = process.env.MNEMO_API_KEY || process.env.VOYAGE_API_KEY;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-4.1";
const MAX_QUESTIONS = parseInt(process.env.MAX_QUESTIONS || "50", 10);
const RECALL_CYCLES = parseInt(process.env.RECALL_CYCLES || "100", 10);
const BENCHMARK = process.env.BENCHMARK || "longmemeval"; // "longmemeval" or "locomo"
// Use a COPY of the production DB — never touch the real one
const PROD_DB = process.env.BENCH_DB || "/tmp/mnemo-prod-copy";

if (!OPENAI_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }
if (!VOYAGE_KEY) { console.error("MNEMO_API_KEY or VOYAGE_API_KEY required"); process.exit(1); }

// ── LLM helpers ──
async function openaiChat(messages, model, maxTokens = 512) {
  model = model || JUDGE_MODEL;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: 0 }),
        signal: AbortSignal.timeout(60000),
      });
      if (resp.status === 429 && attempt < 4) {
        await new Promise(r => setTimeout(r, 2 ** attempt * 3000 + 2000));
        continue;
      }
      const data = await resp.json();
      return data.choices[0].message.content;
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function judge(question, predicted, gold, qtype) {
  if (qtype === "abstention") {
    const signals = ["don't know", "no information", "not mentioned", "cannot determine", "no record"];
    return signals.some(s => predicted.toLowerCase().includes(s)) ? 3 : 0;
  }
  const prompt = `Evaluate this AI answer.\n\nQuestion: ${question}\nGold answer: ${gold}\nPredicted: ${predicted}\n\nScore (ONLY a digit):\n3 = Exact / semantically equivalent\n2 = Mostly correct\n1 = Partially correct\n0 = Wrong or "I don't know"\n\nScore:`;
  try {
    const s = await openaiChat([{ role: "user", content: prompt }], null, 4);
    const n = parseInt(s.trim()[0], 10);
    return isNaN(n) ? 0 : Math.min(Math.max(n, 0), 3);
  } catch { return 0; }
}

async function answerWithContext(question, docs) {
  const context = docs.map(m => `- ${m}`).join("\n");
  if (!context.trim()) return "I don't have enough information to answer this question.";
  const prompt = `You have memory snippets from past conversations:\n\n${context}\n\nBased ONLY on the above, answer concisely (1-2 sentences):\nQuestion: ${question}\n\nIf the information is not in the snippets, say "I don't have information about that."\nAnswer:`;
  return openaiChat([{ role: "user", content: prompt }]).then(s => s.trim()).catch(e => `[ERROR: ${e}]`);
}

// ── Worker pool ──
async function workerPool(items, fn, concurrency) {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) { const i = idx++; await fn(items[i], i); }
  });
  await Promise.all(workers);
}

// ── Main ──
async function main() {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`Production Benchmark — ${BENCHMARK.toUpperCase()}`);
  console.log(`DB: ${PROD_DB}`);
  console.log(`Judge: ${JUDGE_MODEL}, Max Questions: ${MAX_QUESTIONS}`);
  console.log(`Recall Cycles: ${RECALL_CYCLES}`);
  console.log(`${"=".repeat(60)}`);

  // Initialize production store + embedder + retriever
  const embedder = new Embedder({
    apiKey: VOYAGE_KEY,
    baseURL: "https://api.voyageai.com/v1",
    model: "voyage-4",
    dimensions: 1024,
    taskQuery: "query",
    taskPassage: "document",
  });

  // Ingestion store: dedup off for speed (benchmark turns don't repeat)
  // Retrieval uses full Pro pipeline (access tracking, decay, rerank)
  const store = new MemoryStore({ dbPath: PROD_DB, vectorDim: 1024, deduplication: false, semanticGate: false });
  const decayEngine = createDecayEngine(DEFAULT_DECAY_CONFIG);
  const retriever = createRetriever(store, embedder, DEFAULT_RETRIEVAL_CONFIG, { decayEngine });

  // ── Load dataset ──
  let questions, scopeData;

  if (BENCHMARK === "longmemeval") {
    console.log(`\nLoading LongMemEval...`);
    const data = JSON.parse(readFileSync(DATA_FILE, "utf8")).slice(0, MAX_QUESTIONS);
    questions = data.map(q => ({
      id: q.question_id,
      scope: `locomo-bench-${q.question_id}`,
      question: q.question,
      gold: q.answer || "",
      type: q.question_type || "unknown",
      turns: [],
    }));

    // Collect turns per scope
    for (const q of data) {
      const scope = `locomo-bench-${q.question_id}`;
      const qObj = questions.find(x => x.scope === scope);
      for (const session of (q.haystack_sessions || [])) {
        const turns = Array.isArray(session) ? session : (session.turns || session.messages || []);
        for (const turn of turns) {
          const text = typeof turn === "object" ? (turn.content || turn.text || "") : String(turn);
          const role = typeof turn === "object" ? (turn.role || "") : "";
          if (text.trim().length < 10) continue;
          qObj.turns.push(`${role ? role + ": " : ""}${text}`);
        }
      }
    }
    console.log(`  ${questions.length} questions loaded`);
  } else {
    console.error("Only longmemeval supported for now");
    process.exit(1);
  }

  // ── Phase 1: Ingest with batch embed ──
  console.log(`\n--- Phase 1: Ingestion (batch embed) ---`);
  const t0 = Date.now();
  const benchScopes = new Set();
  let totalStored = 0;

  // Collect all turns
  const allTurns = [];
  for (const q of questions) {
    benchScopes.add(q.scope);
    for (const text of q.turns) {
      allTurns.push({ text, scope: q.scope });
    }
  }
  console.log(`  ${allTurns.length} turns to embed`);

  // Batch embed all texts (10 per API call)
  const BATCH = 10;
  const allVectors = [];
  for (let i = 0; i < allTurns.length; i += BATCH) {
    const batch = allTurns.slice(i, i + BATCH).map(t => t.text);
    try {
      const vectors = await embedder.embedBatchPassage(batch);
      allVectors.push(...vectors);
    } catch (e) {
      console.error(`  Embed batch failed at ${i}: ${e.message?.slice(0, 80)}`);
      allVectors.push(...batch.map(() => null));
    }
    if (allVectors.length % 500 < BATCH) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (allVectors.length / (Date.now() - t0) * 1000).toFixed(1);
      console.log(`  Embedded ${allVectors.length}/${allTurns.length} — ${elapsed}s — ${rate}/s`);
    }
  }
  console.log(`  Embedding done: ${allVectors.filter(v => v && v.length > 0).length}/${allTurns.length}`);

  // Bulk write to LanceDB table (skip store.store() overhead)
  const { default: lancedb } = await import("@lancedb/lancedb");
  const { randomUUID } = await import("node:crypto");
  const db = await lancedb.connect(PROD_DB);
  const table = await db.openTable("memories");

  const rows = [];
  for (let i = 0; i < allTurns.length; i++) {
    if (!allVectors[i] || allVectors[i].length === 0) continue;
    rows.push({
      id: randomUUID(),
      text: allTurns[i].text,
      vector: allVectors[i],
      category: "fact",
      importance: 0.7,
      scope: allTurns[i].scope,
      timestamp: Date.now(),
      metadata: "{}",
    });
  }

  const WRITE_BATCH = 2000;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    await table.add(rows.slice(i, i + WRITE_BATCH));
    totalStored += Math.min(WRITE_BATCH, rows.length - i);
    console.log(`  Written ${totalStored}/${rows.length} to DB`);
  }
  console.log(`  Ingestion complete: ${totalStored} stored — ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // ── Phase 2: Recall cycles ──
  console.log(`\n--- Phase 2: ${RECALL_CYCLES} recall cycles ---`);
  const t1 = Date.now();
  for (let c = 0; c < RECALL_CYCLES; c++) {
    const q = questions[c % questions.length];
    try {
      await retriever.retrieve({
        query: q.question,
        limit: 10,
        scopeFilter: [q.scope],
        source: "manual",
      });
    } catch {}
    if ((c + 1) % 50 === 0) {
      console.log(`  Cycle ${c + 1}/${RECALL_CYCLES} — ${((Date.now() - t1) / 1000).toFixed(0)}s`);
    }
  }
  console.log(`  Recall cycles complete — ${((Date.now() - t1) / 1000).toFixed(0)}s`);

  // ── Phase 3: Evaluate ──
  console.log(`\n--- Phase 3: Evaluation ---`);
  const results = [];

  // Low concurrency to avoid contention with other processes
  await workerPool(questions, async (q, qi) => {
    if (!q.gold && q.type !== "abstention") return;

    const retrieved = await retriever.retrieve({
      query: q.question,
      limit: 10,
      scopeFilter: [q.scope],
      source: "manual",
    });
    const docTexts = retrieved.map(r => r.entry.text);
    const predicted = await answerWithContext(q.question, docTexts);
    const score = await judge(q.question, predicted, q.gold, q.type);

    results.push({
      id: q.id, type: q.type, question: q.question,
      gold: q.gold, predicted, score, n_retrieved: retrieved.length,
    });

    const status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score];
    if ((qi + 1) % 10 === 0 || qi < 3) {
      console.log(`  Q${qi}: [${status}] (${q.type}) ${q.question.slice(0, 55)}...`);
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
  console.log(`RESULTS (Production): ${accuracy}% (${correct}/${total})`);
  console.log(`${"=".repeat(60)}`);
  for (const [type, data] of Object.entries(byType)) {
    console.log(`  ${type}: ${(data.correct / data.total * 100).toFixed(1)}% (${data.correct}/${data.total})`);
  }

  // Save results
  const output = {
    adapter: "mnemo-bench",
    benchmark: BENCHMARK,
    db: PROD_DB,
    accuracy: parseFloat(accuracy),
    correct, total,
    recall_cycles: RECALL_CYCLES,
    by_type: {},
    questions: results,
  };
  for (const [type, data] of Object.entries(byType)) {
    output.by_type[type] = parseFloat((data.correct / data.total * 100).toFixed(1));
  }
  const outFile = join(RESULTS_DIR, `production_${BENCHMARK}_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outFile}`);

  // ── Phase 4: Cleanup benchmark data ──
  console.log(`\n--- Phase 4: Cleanup ---`);
  let deleted = 0;
  let skipped = 0;
  for (const scope of benchScopes) {
    try {
      const entries = await store.list([scope], undefined, 10000, 0);
      for (const entry of entries) {
        // SAFETY: only delete entries that actually belong to this benchmark scope
        if (entry.scope !== scope) {
          skipped++;
          continue;
        }
        try {
          await store.delete(entry.id);
          deleted++;
        } catch (e) {
          console.error(`  Failed to delete ${entry.id}: ${e.message}`);
        }
      }
    } catch (e) {
      console.error(`  Cleanup failed for scope ${scope}: ${e.message}`);
    }
  }
  if (skipped > 0) console.log(`  Skipped ${skipped} non-benchmark entries (safety guard)`);
  console.log(`  Cleaned up ${deleted} benchmark entries from ${benchScopes.size} scopes`);
  console.log(`  Production data untouched.`);
}

main().catch(e => { console.error(e); process.exit(1); });

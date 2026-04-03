#!/usr/bin/env node
/**
 * LOCOMO Benchmark on Production DB Copy
 * 10 conversations, ~2000 QA pairs, batch embed + full retrieval
 */

import { MemoryStore } from "../packages/core/dist/src/store.js";
import { Embedder } from "../packages/core/dist/src/embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../packages/core/dist/src/retriever.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "../packages/core/dist/src/decay-engine.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "data", "locomo10.json");
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOYAGE_KEY = process.env.MNEMO_API_KEY || process.env.VOYAGE_API_KEY;
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-4.1";
const DB_PATH = process.env.BENCH_DB || "/tmp/mnemo-locomo-bench";
const MAX_QA = parseInt(process.env.MAX_QA || "200", 10);
const ADAPTER = process.env.ADAPTER || "pro";

if (!OPENAI_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }
if (!VOYAGE_KEY) { console.error("MNEMO_API_KEY or VOYAGE_API_KEY required"); process.exit(1); }

// LOCOMO categories
const CAT_NAMES = { 1: "single-hop", 2: "multi-hop", 3: "open-ended", 4: "temporal", 5: "adversarial" };

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

async function judgeAnswer(question, predicted, gold) {
  const prompt = `Evaluate this AI answer.

Question: ${question}
Gold answer: ${gold}
Predicted: ${predicted}

Score (respond with ONLY a digit):
3 = Exact / semantically equivalent
2 = Mostly correct
1 = Partially correct
0 = Wrong or "I don't know"

Score:`;
  try {
    const s = await openaiChat([{ role: "user", content: prompt }], null, 4);
    const n = parseInt(s.trim()[0], 10);
    return isNaN(n) ? 0 : Math.min(Math.max(n, 0), 3);
  } catch { return 0; }
}

async function answerWithContext(question, docs) {
  const context = docs.map(m => `- ${m}`).join("\n");
  if (!context.trim()) return "I don't have enough information to answer this question.";
  const prompt = `You have memory snippets from past conversations:

${context}

Based ONLY on the above, answer concisely (1-2 sentences):
Question: ${question}

If the information is not in the snippets, say "I don't have information about that."
Answer:`;
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
  console.log(`Loading LOCOMO...`);
  const data = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  console.log(`  ${data.length} conversations`);

  // Collect QA pairs (up to MAX_QA)
  const allQA = [];
  for (const conv of data) {
    const scope = `locomo-bench-${conv.sample_id || randomUUID().slice(0, 8)}`;
    for (const qa of (conv.qa || [])) {
      allQA.push({
        scope,
        question: qa.question,
        gold: String(qa.answer),
        category: qa.category,
        conversation: conv.conversation,
      });
    }
  }

  // Sample MAX_QA questions evenly across categories
  const selected = [];
  const byCat = {};
  for (const qa of allQA) {
    const cat = qa.category;
    if (!byCat[cat]) byCat[cat] = [];
    byCat[cat].push(qa);
  }
  const perCat = Math.ceil(MAX_QA / Object.keys(byCat).length);
  for (const [cat, items] of Object.entries(byCat)) {
    const step = items.length / Math.min(perCat, items.length);
    for (let i = 0; i < Math.min(perCat, items.length); i++) {
      selected.push(items[Math.floor(i * step)]);
    }
  }
  const questions = selected.slice(0, MAX_QA);
  console.log(`  ${questions.length} QA pairs selected (${Object.keys(byCat).map(c => `cat${c}:${byCat[c].length}`).join(", ")})`);

  const embedder = new Embedder({
    apiKey: VOYAGE_KEY,
    baseURL: "https://api.voyageai.com/v1",
    model: "voyage-4",
    dimensions: 1024,
    taskQuery: "query",
    taskPassage: "document",
  });

  const store = new MemoryStore({ dbPath: DB_PATH, vectorDim: 1024, deduplication: false, semanticGate: false });
  const decayEngine = createDecayEngine(DEFAULT_DECAY_CONFIG);
  const retriever = createRetriever(store, embedder, DEFAULT_RETRIEVAL_CONFIG, { decayEngine });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`LOCOMO Benchmark — ${ADAPTER.toUpperCase()} (Production DB)`);
  console.log(`Judge: ${JUDGE_MODEL}, Questions: ${questions.length}`);
  console.log(`DB: ${DB_PATH}`);
  console.log(`${"=".repeat(60)}`);

  // ── Phase 1: Ingest conversations ──
  console.log(`\n--- Phase 1: Ingestion ---`);
  const t0 = Date.now();
  const benchScopes = new Set();
  const ingestedScopes = new Set();

  // Collect all turns
  const allTurns = [];
  for (const q of questions) {
    if (ingestedScopes.has(q.scope)) continue;
    benchScopes.add(q.scope);
    const conv = q.conversation || {};
    // LOCOMO conversations are dicts with session_1, session_2, etc.
    const sessionKeys = Object.keys(conv).filter(k => k.startsWith("session_") && !k.endsWith("date_time"));
    for (const sk of sessionKeys) {
      const turns = conv[sk] || [];
      for (const turn of turns) {
        const speaker = turn.speaker || "";
        const text = turn.text || "";
        if (text.trim().length < 10) continue;
        allTurns.push({ text: `${speaker}: ${text}`, scope: q.scope });
      }
    }
    ingestedScopes.add(q.scope);
  }

  console.log(`  ${allTurns.length} turns from ${ingestedScopes.size} conversations`);

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
    if (allVectors.length % 100 < BATCH) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  Embedded ${allVectors.length}/${allTurns.length} — ${elapsed}s`);
    }
  }

  // Bulk write to LanceDB
  const { default: lancedb } = await import("@lancedb/lancedb");
  const db = await lancedb.connect(DB_PATH);
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
  let totalStored = 0;
  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    await table.add(rows.slice(i, i + WRITE_BATCH));
    totalStored += Math.min(WRITE_BATCH, rows.length - i);
  }
  console.log(`  Stored ${totalStored} turns — ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // ── Phase 2: Evaluate ──
  console.log(`\n--- Phase 2: Evaluation ---`);
  const results = [];

  await workerPool(questions, async (q, qi) => {
    const retrieved = await retriever.retrieve({
      query: q.question,
      limit: 10,
      scopeFilter: [q.scope],
      source: "manual",
    });
    const docTexts = retrieved.map(r => r.entry.text);
    const predicted = await answerWithContext(q.question, docTexts);
    const score = await judgeAnswer(q.question, predicted, q.gold);

    results.push({
      question: q.question, gold: q.gold, predicted, score,
      category: q.category, n_retrieved: retrieved.length,
    });

    const status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score];
    if ((qi + 1) % 20 === 0 || qi < 5) {
      console.log(`  Q${qi}: [${status}] (${CAT_NAMES[q.category] || q.category}) ${q.question.slice(0, 55)}...`);
    }
  }, 3);

  // ── Results ──
  const correct = results.filter(r => r.score >= 2).length;
  const total = results.length;
  const accuracy = (correct / total * 100).toFixed(1);

  const byCatResult = {};
  for (const r of results) {
    const name = CAT_NAMES[r.category] || `cat${r.category}`;
    if (!byCatResult[name]) byCatResult[name] = { correct: 0, total: 0 };
    byCatResult[name].total++;
    if (r.score >= 2) byCatResult[name].correct++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS (${ADAPTER.toUpperCase()}): ${accuracy}% (${correct}/${total})`);
  console.log(`${"=".repeat(60)}`);
  for (const [name, d] of Object.entries(byCatResult).sort((a, b) => a[0].localeCompare(b[0]))) {
    console.log(`  ${name}: ${(d.correct / d.total * 100).toFixed(1)}% (${d.correct}/${d.total})`);
  }

  // Save
  const output = {
    adapter: ADAPTER, benchmark: "LOCOMO", accuracy: parseFloat(accuracy),
    correct, total, by_category: {}, questions: results,
  };
  for (const [name, d] of Object.entries(byCatResult)) {
    output.by_category[name] = parseFloat((d.correct / d.total * 100).toFixed(1));
  }
  const outFile = join(RESULTS_DIR, `locomo_${ADAPTER}_prod_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outFile}`);

  // ── Cleanup ──
  console.log(`\n--- Cleanup ---`);
  let deleted = 0;
  for (const scope of benchScopes) {
    try {
      const entries = await store.list([scope], undefined, 10000, 0);
      for (const entry of entries) {
        if (entry.scope !== scope) continue;
        try { await store.delete(entry.id); deleted++; } catch {}
      }
    } catch (e) {
      console.error(`  Cleanup failed for ${scope}: ${e.message}`);
    }
  }
  console.log(`  Cleaned ${deleted} benchmark entries`);
}

main().catch(e => { console.error(e); process.exit(1); });

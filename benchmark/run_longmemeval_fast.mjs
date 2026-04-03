#!/usr/bin/env node
/**
 * LongMemEval Benchmark — Fast version with batch embedding
 * Uses @mnemoai/core SDK directly + batch embed for speed
 */

import { createMnemo } from "../packages/core/dist/src/mnemo.js";
import { Embedder } from "../packages/core/dist/src/embedder.js";
import { MemoryStore } from "../packages/core/dist/src/store.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "data", "longmemeval_s.json");
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOYAGE_KEY = process.env.MNEMO_API_KEY || process.env.VOYAGE_API_KEY;
const JUDGE_MODEL = process.env.LONGMEMEVAL_JUDGE_MODEL || "gpt-4.1";
const MAX_QUESTIONS = parseInt(process.env.MAX_QUESTIONS || "50", 10);
const BATCH_SIZE = parseInt(process.env.BATCH_SIZE || "50", 10);
const EVAL_CONCURRENCY = parseInt(process.env.EVAL_CONCURRENCY || "10", 10);

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

function judge(question, predicted, gold, qtype) {
  if (qtype === "abstention") {
    const signals = ["don't know", "no information", "not mentioned", "cannot determine",
      "no record", "not available", "unclear", "no evidence"];
    const lower = predicted.toLowerCase();
    return signals.some(s => lower.includes(s)) ? 3 : 0;
  }
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
  return openaiChat([{ role: "user", content: prompt }], null, 4).then(s => {
    const n = parseInt(s.trim()[0], 10);
    return isNaN(n) ? 0 : Math.min(Math.max(n, 0), 3);
  }).catch(() => 0);
}

async function answerWithContext(question, docs) {
  const context = docs.map(m => `- ${m}`).join("\n");
  if (!context.trim()) return "I don't have enough information to answer this question.";
  const prompt = `You have memory snippets from past conversations:

${context}

Based ONLY on the above, answer concisely (1-2 sentences):
Question: ${question}

Instructions:
- If the information is not in the snippets, say "I don't have information about that."
- Extract specific details like names, dates, locations from the context.
- Combine information from multiple snippets when needed.
Answer:`;
  return openaiChat([{ role: "user", content: prompt }]).then(s => s.trim()).catch(e => `[ERROR: ${e}]`);
}

// ── Parallel helper ──
async function parallelMap(items, fn, concurrency) {
  const results = new Array(items.length);
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

// ── Main ──

async function main() {
  console.log(`Loading ${DATA_FILE}...`);
  const allData = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  const questions = allData.slice(0, MAX_QUESTIONS);
  console.log(`Loaded ${questions.length} questions`);

  // mnemo instance for recall (created after ingestion so it sees the data)
  let mnemo;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`LongMemEval Benchmark — mnemo-core (batch embed)`);
  console.log(`Judge: ${JUDGE_MODEL}, Questions: ${questions.length}, Batch: ${BATCH_SIZE}`);
  console.log(`${"=".repeat(60)}`);

  // Phase 1: Collect ALL turns (no sampling)
  console.log(`\n--- Phase 1: Ingestion (batch embed, size=${BATCH_SIZE}) ---`);
  const t0 = Date.now();
  const allTurns = []; // { text, scope }
  const seenScopes = new Set();

  for (const q of questions) {
    const qid = q.question_id;
    const scope = `lme-${qid}`;
    if (seenScopes.has(scope)) continue;
    const sessions = q.haystack_sessions || [];
    if (!sessions.length) continue;

    for (const session of sessions) {
      const turns = Array.isArray(session) ? session : (session.turns || session.messages || []);
      for (const turn of turns) {
        let text, role;
        if (typeof turn === "object") {
          role = turn.role || "";
          text = turn.content || turn.text || "";
        } else if (typeof turn === "string") {
          text = turn; role = "";
        } else continue;
        if (!text || text.trim().length < 10) continue;
        const prefix = role ? `${role}: ` : "";
        allTurns.push({ text: `${prefix}${text}`, scope });
      }
    }
    seenScopes.add(scope);
  }

  console.log(`  ${allTurns.length} turns across ${seenScopes.size} scopes (full, no sampling)`);

  // Phase 1a: Batch embed all texts (50 texts per API call → ~500 calls total)
  const embedder = new Embedder({
    apiKey: VOYAGE_KEY,
    baseURL: "https://api.voyageai.com/v1",
    model: "voyage-4",
    dimensions: 1024,
    taskPassage: "document",
    taskQuery: "query",
  });

  const EMBED_BATCH = 50;  // texts per Voyage API call
  const allVectors = new Array(allTurns.length);
  let embedded = 0;
  let embedFailed = 0;

  for (let i = 0; i < allTurns.length; i += EMBED_BATCH) {
    const batchTexts = allTurns.slice(i, i + EMBED_BATCH).map(t => t.text);
    try {
      const vectors = await embedder.embedBatchPassage(batchTexts);
      for (let j = 0; j < vectors.length; j++) {
        allVectors[i + j] = vectors[j];
      }
      embedded += batchTexts.length;
    } catch (e) {
      // Retry once
      try {
        await new Promise(r => setTimeout(r, 2000));
        const vectors = await embedder.embedBatchPassage(batchTexts);
        for (let j = 0; j < vectors.length; j++) {
          allVectors[i + j] = vectors[j];
        }
        embedded += batchTexts.length;
      } catch {
        embedFailed += batchTexts.length;
        for (let j = 0; j < batchTexts.length; j++) {
          allVectors[i + j] = null;
        }
      }
    }
    if (embedded % 1000 < EMBED_BATCH) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      const rate = (embedded / (Date.now() - t0) * 1000).toFixed(1);
      console.log(`  Embedded ${embedded}/${allTurns.length} (${(embedded*100/allTurns.length).toFixed(1)}%) — ${elapsed}s — ${rate}/s`);
    }
  }
  console.log(`  Embedding done: ${embedded} ok, ${embedFailed} failed`);

  // Phase 1b: Bulk write to LanceDB (skip dedup/noise gate for speed)
  const { default: lancedb } = await import("@lancedb/lancedb");
  const { randomUUID } = await import("node:crypto");
  const db = await lancedb.connect("/tmp/mnemo-benchmark-fast");

  // Build all rows
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

  console.log(`  Writing ${rows.length} rows to LanceDB...`);
  const WRITE_BATCH = 5000;
  let stored = 0;
  let failed = 0;

  for (let i = 0; i < rows.length; i += WRITE_BATCH) {
    const batch = rows.slice(i, i + WRITE_BATCH);
    try {
      if (i === 0) {
        // Create table with first batch
        await db.createTable("memories", batch, { mode: "overwrite" });
      } else {
        const table = await db.openTable("memories");
        await table.add(batch);
      }
      stored += batch.length;
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  Written ${stored}/${rows.length} — ${elapsed}s`);
    } catch (e) {
      console.error(`  Write failed at ${i}: ${e.message}`);
      failed += batch.length;
    }
  }

  const ingestTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Ingestion complete: ${stored} stored, ${failed} failed, ${ingestTime}s`);

  // Create mnemo instance for recall
  mnemo = await createMnemo({
    dbPath: "/tmp/mnemo-benchmark-fast",
    embedding: {
      apiKey: VOYAGE_KEY,
      baseURL: "https://api.voyageai.com/v1",
      model: "voyage-4",
      dimensions: 1024,
      taskQuery: "query",
      taskPassage: "document",
    },
  });

  // Phase 2: Evaluate
  console.log(`\n--- Phase 2: Evaluation (${EVAL_CONCURRENCY} concurrent) ---`);
  const CATEGORY_NAMES = {
    "single-session-user": "Single (User)", "single-session-assistant": "Single (Assistant)",
    "single-session-preference": "Single (Preference)", "multi-session": "Multi-Session",
    "knowledge-update": "Knowledge Update", "temporal-reasoning": "Temporal", "abstention": "Abstention",
  };

  const results = [];

  await parallelMap(questions, async (q, qi) => {
    const qid = q.question_id;
    const scope = `lme-${qid}`;
    const question = q.question;
    const gold = q.answer || "";
    const qtype = q.question_type || "unknown";
    if (!gold && qtype !== "abstention") return;

    const docs = await mnemo.recall(question, { limit: 10, scopeFilter: [scope] });
    const docTexts = docs.map(r => r.text);
    const predicted = await answerWithContext(question, docTexts);
    const score = await judge(question, predicted, gold, qtype);

    results.push({ question_id: qid, question_type: qtype, question, gold, predicted, score, n_retrieved: docs.length });

    const status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score];
    if ((qi + 1) % 10 === 0 || qi < 3) {
      console.log(`  Q${qi}: [${status}] (${qtype}) ${question.slice(0, 60)}...`);
    }
  }, EVAL_CONCURRENCY);

  // Results
  if (!results.length) { console.log("No results!"); return; }
  const correct = results.filter(r => r.score >= 2).length;
  const total = results.length;
  const accuracy = (correct / total * 100).toFixed(1);

  const byType = {};
  for (const r of results) {
    if (!byType[r.question_type]) byType[r.question_type] = { correct: 0, total: 0 };
    byType[r.question_type].total++;
    if (r.score >= 2) byType[r.question_type].correct++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS: ${accuracy}% accuracy (${correct}/${total})`);
  console.log(`${"=".repeat(60)}`);
  for (const [type, data] of Object.entries(byType)) {
    const name = CATEGORY_NAMES[type] || type;
    const pct = (data.correct / data.total * 100).toFixed(1);
    console.log(`  ${name}: ${pct}% (${data.correct}/${data.total})`);
  }

  const output = {
    adapter: "mnemo-core-direct",
    benchmark: "LongMemEval",
    accuracy: parseFloat(accuracy),
    correct, total, by_type: {},
    questions: results.map(r => ({
      qid: r.question_id, type: r.question_type, q: r.question,
      gold: r.gold, pred: r.predicted, score: r.score, n: r.n_retrieved,
    })),
  };
  for (const [type, data] of Object.entries(byType)) {
    output.by_type[type] = parseFloat((data.correct / data.total * 100).toFixed(1));
  }

  const outFile = join(RESULTS_DIR, `longmemeval_mnemo-core_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outFile}`);

  await mnemo.close();
}

main().catch(e => { console.error(e); process.exit(1); });

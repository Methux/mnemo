#!/usr/bin/env node
/**
 * 30-Day Longterm Benchmark Runner
 *
 * Simulates 30 days of usage, then evaluates recall accuracy.
 * Designed to showcase Pro's access tracking + self-improvement advantage.
 *
 * Usage:
 *   ADAPTER=core node run_benchmark.mjs   # Test Core
 *   ADAPTER=pro  node run_benchmark.mjs   # Test Pro
 */

import { createMnemo } from "../../packages/core/dist/src/mnemo.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "dataset.json");
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOYAGE_KEY = process.env.MNEMO_API_KEY || process.env.VOYAGE_API_KEY;
const ADAPTER = process.env.ADAPTER || "core";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-4.1";

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

async function judge(question, predicted, gold) {
  const lower = predicted.toLowerCase();
  const abstainSignals = ["don't know", "no information", "not mentioned", "cannot determine", "no record"];
  const isAbstain = abstainSignals.some(s => lower.includes(s));

  // If gold answer is "I don't know" type
  if (gold.toLowerCase().includes("don't know") || gold.toLowerCase().includes("no information")) {
    return isAbstain ? 3 : 0;
  }

  const prompt = `Evaluate this AI answer.

Question: ${question}
Gold answer: ${gold}
Predicted: ${predicted}

Score (respond with ONLY a digit):
3 = Exact / semantically equivalent
2 = Mostly correct
1 = Partially correct
0 = Wrong or "I don't know" when answer exists

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
  const prompt = `You have memory snippets about a user named Alex:

${context}

Based ONLY on the above, answer concisely (1-2 sentences):
Question: ${question}

Instructions:
- If the memories contain conflicting info, use the MOST RECENT one.
- If the information is not in the snippets, say "I don't have information about that."
- Be specific — include names, numbers, dates from the context.
Answer:`;
  return openaiChat([{ role: "user", content: prompt }]).then(s => s.trim()).catch(e => `[ERROR: ${e}]`);
}

// ── Worker pool ──
async function workerPool(items, fn, concurrency) {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// ── Main ──

async function main() {
  console.log(`Loading dataset...`);
  const dataset = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  console.log(`  ${dataset.days.length} days, ${dataset.questions.length} questions`);

  const dbPath = `/tmp/mnemo-longterm-${ADAPTER}`;

  const mnemo = await createMnemo({
    dbPath,
    embedding: {
      apiKey: VOYAGE_KEY,
      baseURL: "https://api.voyageai.com/v1",
      model: "voyage-4",
      dimensions: 1024,
      taskQuery: "query",
      taskPassage: "document",
    },
  });

  console.log(`\n${"=".repeat(60)}`);
  console.log(`30-Day Longterm Benchmark — ${ADAPTER.toUpperCase()}`);
  console.log(`Judge: ${JUDGE_MODEL}`);
  console.log(`${"=".repeat(60)}`);

  // ============================================================
  // Phase 1: Simulate 30 days of usage
  // ============================================================
  console.log(`\n--- Phase 1: Simulating 30 days ---`);
  const t0 = Date.now();
  let totalStored = 0;
  let totalRecalls = 0;

  for (const day of dataset.days) {
    const dayNum = day.day;
    const conversations = day.conversations || [];

    for (const conv of conversations) {
      const turns = conv.turns || [];
      // Store each turn as a memory
      for (const turn of turns) {
        if (!turn.content || turn.content.trim().length < 10) continue;
        try {
          await mnemo.store({
            text: `${turn.role}: ${turn.content}`,
            category: "fact",
            scope: "alex",
          });
          totalStored++;
        } catch {}
      }
    }

    // Simulate recall queries from the dataset (Phase 2 recall_queries)
    if (dataset.recall_queries) {
      for (const rq of dataset.recall_queries) {
        if (rq.day === dayNum) {
          try {
            await mnemo.recall(rq.query, { limit: 5, scopeFilter: ["alex"] });
            totalRecalls++;
          } catch {}
        }
      }
    }

    // Also do periodic "maintenance" recalls — simulate real usage
    // Every 3 days, recall key facts (this is what triggers access tracking in Pro)
    if (dayNum % 3 === 0) {
      const maintenanceQueries = [
        "What is Alex's name and job?",
        "What are Alex's hobbies?",
        "What is Alex's daily routine?",
        "Who are Alex's family members?",
        "What are Alex's food preferences?",
      ];
      for (const q of maintenanceQueries) {
        try {
          await mnemo.recall(q, { limit: 5, scopeFilter: ["alex"] });
          totalRecalls++;
        } catch {}
      }
    }

    if (dayNum % 5 === 0 || dayNum <= 3) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
      console.log(`  Day ${dayNum}/30 — ${totalStored} stored, ${totalRecalls} recalls — ${elapsed}s`);
    }
  }

  const simTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Simulation complete: ${totalStored} stored, ${totalRecalls} recalls, ${simTime}s`);

  // ============================================================
  // Phase 2: Evaluate
  // ============================================================
  console.log(`\n--- Phase 2: Evaluation (${dataset.questions.length} questions) ---`);
  const results = [];

  await workerPool(dataset.questions, async (q, qi) => {
    const question = q.question;
    const gold = q.gold_answer;
    const category = q.category;

    const docs = await mnemo.recall(question, { limit: 10, scopeFilter: ["alex"] });
    const docTexts = docs.map(r => r.text);
    const predicted = await answerWithContext(question, docTexts);
    const score = await judge(question, predicted, gold);

    results.push({
      id: q.id,
      category,
      question,
      gold,
      predicted,
      score,
      n_retrieved: docs.length,
      difficulty: q.difficulty,
    });

    const status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score];
    if ((qi + 1) % 20 === 0 || qi < 5) {
      console.log(`  Q${qi}: [${status}] (${category}) ${question.slice(0, 55)}...`);
    }
  }, 10);

  // ============================================================
  // Results
  // ============================================================
  const correct = results.filter(r => r.score >= 2).length;
  const total = results.length;
  const accuracy = (correct / total * 100).toFixed(1);

  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { correct: 0, total: 0 };
    byCategory[r.category].total++;
    if (r.score >= 2) byCategory[r.category].correct++;
  }

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS (${ADAPTER.toUpperCase()}): ${accuracy}% accuracy (${correct}/${total})`);
  console.log(`${"=".repeat(60)}`);
  for (const [cat, data] of Object.entries(byCategory).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = (data.correct / data.total * 100).toFixed(1);
    console.log(`  ${cat}: ${pct}% (${data.correct}/${data.total})`);
  }

  // Save
  const output = {
    adapter: ADAPTER,
    benchmark: "30-Day Longterm",
    accuracy: parseFloat(accuracy),
    correct, total,
    total_stored: totalStored,
    total_recalls: totalRecalls,
    simulation_time_s: parseFloat(simTime),
    by_category: {},
    questions: results,
  };
  for (const [cat, data] of Object.entries(byCategory)) {
    output.by_category[cat] = parseFloat((data.correct / data.total * 100).toFixed(1));
  }

  const outFile = join(RESULTS_DIR, `longterm_${ADAPTER}_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outFile}`);
  await mnemo.close();
}

main().catch(e => { console.error(e); process.exit(1); });

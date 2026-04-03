#!/usr/bin/env node
/**
 * MQoT Benchmark Runner — Core (no Pro features)
 *
 * Core pipeline: SmartExtraction + Vector + BM25 (no rerank, no Graphiti, no decay)
 * Same dataset, same evaluation, same scorer as Pro benchmark.
 */

import { MemoryStore } from "../../packages/core/dist/src/store.js";
import { Embedder } from "../../packages/core/dist/src/embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../packages/core/dist/src/retriever.js";
import { SemanticGate } from "../../packages/core/dist/src/semantic-gate.js";
import { SmartExtractor } from "../../packages/core/dist/src/smart-extractor.js";
import { createLlmClient } from "../../packages/core/dist/src/llm-client.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "dataset_v2.json");
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOYAGE_KEY = process.env.MNEMO_API_KEY;
const BENCH_GROUP = `mqot-core-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
const DB_PATH = `/tmp/mnemo-mqot-core`;
const PROD_DB = join(homedir(), ".mnemo", "data", "lancedb");

if (!OPENAI_KEY || !VOYAGE_KEY) { console.error("OPENAI_API_KEY and MNEMO_API_KEY required"); process.exit(1); }

// ── LLM ──
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

async function judgeAnswer(question, predicted, gold, category, oldAnswer) {
  if (category === "forgetting") {
    const lower = predicted.toLowerCase();
    const abstains = ["don't know", "no information", "not mentioned", "cannot determine", "no record", "don't have"];
    if (abstains.some(s => lower.includes(s))) return 2;
  }

  if (category === "contradiction" && oldAnswer) {
    try {
      const s = await openaiChat([{ role: "user", content:
        `A memory system was given facts that CHANGED over time.\n` +
        `Old fact: ${oldAnswer}\nNew/correct fact: ${gold}\n\n` +
        `Question: ${question}\nPredicted answer: ${predicted}\n\n` +
        `Score rules:\n` +
        `3 = Answer matches the NEW/correct fact exactly\n` +
        `2 = Answer is mostly correct, uses new fact but imprecise\n` +
        `1 = Answer is vague or partially correct\n` +
        `0 = Answer uses the OLD/outdated fact, or says "I don't know", or is wrong\n\n` +
        `Reply with ONLY a single digit (0-3):` }], null, 4);
      const n = parseInt(s.trim()[0], 10);
      return isNaN(n) ? 0 : Math.min(Math.max(n, 0), 3);
    } catch { return 0; }
  }

  try {
    const s = await openaiChat([{ role: "user", content:
      `You are a LENIENT evaluator for a memory system. ` +
      `The system retrieved facts from memory to answer a question.\n\n` +
      `Question: ${question}\n` +
      `Gold answer: ${gold}\n` +
      `Predicted answer: ${predicted}\n\n` +
      `Scoring rules:\n` +
      `3 = Predicted contains the key fact from gold (exact or paraphrased)\n` +
      `2 = Predicted is mostly correct — captures the main idea but misses minor details or adds extra info\n` +
      `1 = Predicted is partially relevant but misses the core fact\n` +
      `0 = Predicted is wrong, contradicts gold, or says "I don't know / no information"\n\n` +
      `IMPORTANT: If the predicted answer CONTAINS the gold answer's key fact (even with extra details), score 3.\n` +
      `Example: Gold="DynaLoop, a tech startup" Predicted="Jordan's biggest client is DynaLoop, which is a tech startup" → Score 3\n` +
      `Example: Gold="Powell's Books in Portland" Predicted="Jordan's favorite bookstore is Powell's Books" → Score 3\n` +
      `Example: Gold="Vegan options" Predicted="Jordan enjoys vegan cuisine and quinoa bowls" → Score 3\n\n` +
      `Reply with ONLY a single digit (0-3):` }], null, 4);
    const n = parseInt(s.trim()[0], 10);
    return isNaN(n) ? 0 : Math.min(Math.max(n, 0), 3);
  } catch { return 0; }
}

async function answerWithContext(question, docs) {
  const context = docs.map(m => `- ${m}`).join("\n");
  if (!context.trim()) return "I don't have enough information to answer this question.";
  return openaiChat([{ role: "user", content: `Memory snippets about Jordan:\n\n${context}\n\nAnswer concisely (1-2 sentences) about JORDAN. Use the MOST RECENT info if there are conflicts.\nIf not in snippets, say "I don't have information about that."\nQuestion: ${question}\nAnswer:` }]).then(s => s.trim()).catch(e => `[ERROR: ${e}]`);
}

async function workerPool(items, fn, concurrency) {
  let idx = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (idx < items.length) { const i = idx++; await fn(items[i], i); }
  }));
}

// ── Main ──
async function main() {
  console.log(`Loading MQoT dataset...`);
  const dataset = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  console.log(`  ${dataset.conversations.length} conversations, ${dataset.questions.length} questions`);

  // Copy production DB
  console.log(`\nCopying production DB...`);
  execSync(`rm -rf ${DB_PATH} && cp -r ${PROD_DB} ${DB_PATH}`);

  // ── Core initialization (NO rerank, NO Graphiti, NO decay, NO LLM contradiction) ──
  const embedder = new Embedder({
    apiKey: VOYAGE_KEY, baseURL: "https://api.voyageai.com/v1",
    model: "voyage-4", dimensions: 1024, taskQuery: "query", taskPassage: "document",
  });

  const store = new MemoryStore({ dbPath: DB_PATH, vectorDim: 1024 });
  const semanticGate = new SemanticGate(embedder);
  store.setSemanticGate(semanticGate);
  // NOTE: No store.setLlmClient() — Core has no LLM contradiction detection

  // Core retriever: no rerank, no decay engine
  const retriever = createRetriever(store, embedder, {
    ...DEFAULT_RETRIEVAL_CONFIG,
    candidatePoolSize: 30,
    // No rerank config — Core uses vector+BM25 only
  });

  const llm = createLlmClient({ apiKey: OPENAI_KEY, model: "gpt-4.1", baseURL: "https://api.openai.com/v1" });
  const scope = `agent:${BENCH_GROUP}`;
  const smartExtractor = new SmartExtractor(store, embedder, llm, {
    defaultScope: scope,
    extractMaxChars: 128000,
  });

  // NOTE: No Graphiti enabled for Core

  console.log(`\n${"=".repeat(60)}`);
  console.log(`MQoT Benchmark — CORE`);
  console.log(`Pipeline: SmartExtract + Vector + BM25 (no rerank, no Graphiti, no decay)`);
  console.log(`Scope: ${scope}`);
  console.log(`${"=".repeat(60)}`);

  // ── Phase 1: Ingest ──
  console.log(`\n--- Phase 1: Smart Extraction (chronological) ---`);
  const t0 = Date.now();
  let totalMemories = 0;

  const convs = [...dataset.conversations].sort((a, b) => a.day - b.day);
  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i];
    const text = conv.turns.map(t => `${t.role}: ${t.content}`).join("\n");
    try {
      const stats = await smartExtractor.extractAndPersist(text, `day-${conv.day}`, {
        scope,
        scopeFilter: [scope],
      });
      totalMemories += stats.created + stats.merged;
      if ((i + 1) % 5 === 0 || i < 3) {
        console.log(`  Day ${conv.day}: ${stats.created} created, ${stats.merged} merged (total: ${totalMemories}) — ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    } catch (e) {
      console.error(`  Day ${conv.day} failed: ${e.message?.slice(0, 80)}`);
    }
  }
  console.log(`  Extraction complete: ${totalMemories} memories — ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // NOTE: No Phase 2 recall cycles — Core has no access tracking / decay

  // ── Phase 2 (Core): Evaluate ──
  console.log(`\n--- Phase 2: Evaluation ---`);
  const results = [];

  await workerPool(dataset.questions, async (q, qi) => {
    try {
      const retrieved = await retriever.retrieve({ query: q.question, limit: 10, scopeFilter: [scope], source: "manual" });
      const docTexts = retrieved.map(r => {
        let text = (r.detail || r.entry.text).slice(0, 300);
        try {
          const meta = JSON.parse(r.entry.metadata || "{}");
          const session = meta.source_session || "";
          if (session) text = `[${session}] ${text}`;
        } catch {}
        return text;
      });
      const predicted = await answerWithContext(q.question, docTexts);
      const score = await judgeAnswer(q.question, predicted, q.gold_answer, q.category, q.old_answer || null);

      results.push({
        id: q.id, category: q.category, question: q.question,
        gold: q.gold_answer, old_answer: q.old_answer || null,
        predicted, score, n: retrieved.length, difficulty: q.difficulty,
      });

      if ((qi + 1) % 10 === 0 || qi < 3) {
        const status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score];
        console.log(`  Q${qi}: [${status}] (${q.category}) ${q.question.slice(0, 55)}...`);
      }
    } catch (e) {
      console.error(`  Q${qi} error: ${e.message?.slice(0, 80)}`);
    }
  }, 3);

  // ── Results ──
  const byCategory = {};
  for (const r of results) {
    if (!byCategory[r.category]) byCategory[r.category] = { correct: 0, total: 0, scores: [] };
    byCategory[r.category].total++;
    byCategory[r.category].scores.push(r.score);
    if (r.score >= 2) byCategory[r.category].correct++;
  }

  const totalCorrect = results.filter(r => r.score >= 2).length;
  const totalQ = results.length;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`MQoT RESULTS (CORE)`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\n  Overall: ${(totalCorrect / totalQ * 100).toFixed(1)}% (${totalCorrect}/${totalQ})\n`);

  for (const [cat, d] of Object.entries(byCategory).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = (d.correct / d.total * 100).toFixed(1);
    const avgScore = (d.scores.reduce((a, b) => a + b, 0) / d.scores.length).toFixed(2);
    let desc;
    switch (cat) {
      case "retention": desc = "Important facts remembered"; break;
      case "forgetting": desc = "Trivial facts appropriately faded"; break;
      case "contradiction": desc = "Updated facts use new value"; break;
      case "precision": desc = "Specific details accurate"; break;
      default: desc = cat;
    }
    console.log(`  ${cat} (${desc})`);
    console.log(`    ${pct}% (${d.correct}/${d.total}) — avg score: ${avgScore}/3`);
  }

  // Save
  const output = {
    benchmark: "MQoT",
    version: "1.0",
    pipeline: "Core: SmartExtract+Vector+BM25",
    total_memories: totalMemories,
    recall_cycles: 0,
    accuracy: parseFloat((totalCorrect / totalQ * 100).toFixed(1)),
    by_category: {},
    questions: results,
  };
  for (const [cat, d] of Object.entries(byCategory)) {
    output.by_category[cat] = {
      accuracy: parseFloat((d.correct / d.total * 100).toFixed(1)),
      avg_score: parseFloat((d.scores.reduce((a, b) => a + b, 0) / d.scores.length).toFixed(2)),
      correct: d.correct, total: d.total,
    };
  }
  const outFile = join(RESULTS_DIR, `mqot_core_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outFile}`);

  // Cleanup
  console.log(`\n--- Cleanup ---`);
  execSync(`rm -rf ${DB_PATH}`);
  console.log(`  LanceDB copy deleted. Done.`);
}

main().catch(e => { console.error(e); process.exit(1); });

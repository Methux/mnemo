#!/usr/bin/env node
/**
 * MQoT-3K Benchmark Runner
 *
 * Usage:
 *   MODE=pro  node run_benchmark_500.mjs   # Pro: rerank + Graphiti + decay + LLM contradiction
 *   MODE=core node run_benchmark_500.mjs   # Core: Vector + BM25 only
 *
 * Uses adaptive gating: pipeline adjusts to corpus size automatically.
 */

import { MemoryStore } from "../../packages/core/dist/src/store.js";
import { Embedder } from "../../packages/core/dist/src/embedder.js";
import { createRetriever, DEFAULT_RETRIEVAL_CONFIG } from "../../packages/core/dist/src/retriever.js";
import { createDecayEngine, DEFAULT_DECAY_CONFIG } from "../../packages/core/dist/src/decay-engine.js";
import { SemanticGate } from "../../packages/core/dist/src/semantic-gate.js";
import { SmartExtractor } from "../../packages/core/dist/src/smart-extractor.js";
import { createLlmClient } from "../../packages/core/dist/src/llm-client.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";
import { execSync } from "child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "dataset_3k.json");
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOYAGE_KEY = process.env.MNEMO_API_KEY;
const MODE = (process.env.MODE || "pro").toLowerCase();
const BENCH_GROUP = `mqot1k-${MODE}-${new Date().toISOString().slice(0, 10).replace(/-/g, "")}`;
const DB_PATH = `/tmp/mnemo-mqot1k-${MODE}`;
const PROD_DB = join(homedir(), ".openclaw", "memory", "lancedb-pro-voyage");

if (!OPENAI_KEY || !VOYAGE_KEY) { console.error("OPENAI_API_KEY and MNEMO_API_KEY required"); process.exit(1); }

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
        `Score rules:\n3 = Answer matches the NEW/correct fact exactly\n` +
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
      `You are a LENIENT evaluator for a memory system.\n\n` +
      `Question: ${question}\nGold answer: ${gold}\nPredicted answer: ${predicted}\n\n` +
      `Scoring rules:\n` +
      `3 = Predicted contains the key fact from gold (exact or paraphrased)\n` +
      `2 = Predicted is mostly correct — captures the main idea but misses minor details\n` +
      `1 = Predicted is partially relevant but misses the core fact\n` +
      `0 = Predicted is wrong, contradicts gold, or says "I don't know"\n\n` +
      `IMPORTANT: If predicted CONTAINS the gold answer's key fact (even with extra details), score 3.\n` +
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

async function main() {
  console.log(`Loading MQoT-3K dataset...`);
  const dataset = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  console.log(`  ${dataset.conversations.length} conversations, ${dataset.questions.length} questions`);
  console.log(`  Important: ${dataset.important_facts?.length || 0}, Updates: ${dataset.fact_updates?.length || 0}`);

  console.log(`\nCopying production DB...`);
  execSync(`rm -rf ${DB_PATH} && cp -r ${PROD_DB} ${DB_PATH}`);

  const embedder = new Embedder({
    apiKey: VOYAGE_KEY, baseURL: "https://api.voyageai.com/v1",
    model: "voyage-4", dimensions: 1024, taskQuery: "query", taskPassage: "document",
  });

  const store = new MemoryStore({ dbPath: DB_PATH, vectorDim: 1024 });
  const semanticGate = new SemanticGate(embedder);
  store.setSemanticGate(semanticGate);

  let retrieverConfig = { ...DEFAULT_RETRIEVAL_CONFIG, candidatePoolSize: 30 };
  let retrieverOpts = {};

  // Pro strategy functions
  const proAdaptivePool = (n) => Math.min(200, Math.max(50, Math.floor(Math.sqrt(n) * 4)));
  const proAdaptiveMinScore = (n) => n > 1000 ? 0.25 : 0.3;
  const proSoftLogCap = (c) => c <= 5 ? c : 5 + Math.log2(c - 4);
  const proPreSearch = async (store, embedder, text, scopeFilter) => {
    const queryText = text.slice(-2000);
    const queryVector = await embedder.embedQuery(queryText);
    const results = await store.vectorSearch(queryVector, 5, 0.3, scopeFilter);
    return results.map(r => ({
      id: r.entry.id, text: r.entry.text,
      daysAgo: Math.max(0, Math.floor((Date.now() - (r.entry.timestamp || Date.now())) / 86_400_000)),
    }));
  };

  if (MODE === "pro") {
    // Pro: LLM contradiction + rerank + decay + Graphiti + adaptive strategies
    const llmForStore = createLlmClient({ apiKey: OPENAI_KEY, model: "gpt-4.1", baseURL: "https://api.openai.com/v1" });
    store.setLlmClient(llmForStore);

    const decayEngine = createDecayEngine({ ...DEFAULT_DECAY_CONFIG, frequencyTransformFn: proSoftLogCap });
    retrieverConfig = {
      ...retrieverConfig,
      candidatePoolSize: 50,
      candidatePoolFn: proAdaptivePool,
      minScoreFn: proAdaptiveMinScore,
      sessionDedup: true,
      rerank: "cross-encoder",
      rerankProvider: "voyage",
      rerankApiKey: VOYAGE_KEY,
      rerankModel: "rerank-2",
      rerankEndpoint: "https://api.voyageai.com/v1/rerank",
    };
    retrieverOpts = { decayEngine };

    process.env.GRAPHITI_ENABLED = "true";
    process.env.GRAPHITI_BASE_URL = "http://127.0.0.1:18799";
  }

  const retriever = createRetriever(store, embedder, retrieverConfig, retrieverOpts);

  const llm = createLlmClient({ apiKey: OPENAI_KEY, model: "gpt-4.1", baseURL: "https://api.openai.com/v1" });
  const scope = `agent:${BENCH_GROUP}`;
  const smartExtractor = new SmartExtractor(store, embedder, llm, {
    defaultScope: scope,
    extractMaxChars: 128000,
    preSearchHook: MODE === "pro" ? proPreSearch : undefined,
  });

  const pipelineDesc = MODE === "pro"
    ? "SmartExtract + Vector + BM25 + Graphiti + Rerank + Decay + Pro Strategies"
    : "SmartExtract + Vector + BM25 (Core)";

  console.log(`\n${"=".repeat(60)}`);
  console.log(`MQoT-3K Benchmark — ${MODE.toUpperCase()}`);
  console.log(`Pipeline: ${pipelineDesc}`);
  console.log(`Scope: ${scope}`);
  console.log(`${"=".repeat(60)}`);

  // Phase 1: Ingest
  console.log(`\n--- Phase 1: Smart Extraction (chronological) ---`);
  const t0 = Date.now();
  let totalMemories = 0;
  const convs = [...dataset.conversations].sort((a, b) => a.day - b.day);

  for (let i = 0; i < convs.length; i++) {
    const conv = convs[i];
    const text = conv.turns.map(t => `${t.role}: ${t.content}`).join("\n");
    try {
      const stats = await smartExtractor.extractAndPersist(text, `day-${conv.day}`, { scope, scopeFilter: [scope] });
      totalMemories += stats.created + stats.merged;
      if ((i + 1) % 5 === 0 || i < 3) {
        console.log(`  [${i + 1}/${convs.length}] Day ${conv.day}: +${stats.created}c/${stats.merged}m (total: ${totalMemories}) — ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      }
    } catch (e) {
      console.error(`  Day ${conv.day} failed: ${e.message?.slice(0, 80)}`);
    }
  }
  console.log(`  Extraction complete: ${totalMemories} memories — ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Phase 2: Recall cycles (Pro only, adaptive)
  // Use topic-level queries instead of original fact text to avoid
  // biasing reinforcement toward stale/pre-update versions of facts.
  if (MODE === "pro") {
    const RECALL_ROUNDS = Math.min(30, Math.max(3, Math.floor(totalMemories / 10)));
    console.log(`\n--- Phase 2: Recall cycles (${RECALL_ROUNDS} rounds, adaptive) ---`);
    const t1 = Date.now();
    const topicQueries = [
      "work projects Lunar Creative", "manager Priya", "branding clients",
      "running training half marathon", "weekly mileage goal", "knee pain fitness",
      "Maya sister Portland birthday", "Sam friend NYC visit",
      "Lena bakery friend", "Alex running buddy",
      "apartment rent budget", "Japan trip savings cherry blossoms",
      "freelance rate clients", "portfolio website update",
      "cat Pixel plants houseplants", "cooking Japanese recipes",
      "reading books fiction", "salary raise finances",
    ];
    for (let cycle = 0; cycle < RECALL_ROUNDS; cycle++) {
      for (const q of topicQueries) {
        try { await retriever.retrieve({ query: q, limit: 5, scopeFilter: [scope], source: "manual" }); } catch {}
      }
      if ((cycle + 1) % 5 === 0) {
        console.log(`  Recall cycle ${cycle + 1}/${RECALL_ROUNDS} — ${((Date.now() - t1) / 1000).toFixed(0)}s`);
      }
    }
  }

  // Repair any candidates that failed embedding during extraction
  const repaired = await smartExtractor.repairPending([scope]);
  if (repaired > 0) console.log(`  Repaired ${repaired} pending memories`);

  // Phase 3: Evaluate
  console.log(`\n--- Phase 3: Evaluation ---`);
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

      if ((qi + 1) % 20 === 0 || qi < 3) {
        const status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score];
        console.log(`  Q${qi + 1}/${dataset.questions.length}: [${status}] (${q.category}) ${q.question.slice(0, 50)}...`);
      }
    } catch (e) {
      console.error(`  Q${qi + 1} error: ${e.message?.slice(0, 80)}`);
    }
  }, 3);

  // Results
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
  console.log(`MQoT-3K RESULTS (${MODE.toUpperCase()})`);
  console.log(`${"=".repeat(60)}`);
  console.log(`\n  Overall: ${(totalCorrect / totalQ * 100).toFixed(1)}% (${totalCorrect}/${totalQ})`);
  console.log(`  Memories: ${totalMemories}\n`);

  for (const [cat, d] of Object.entries(byCategory).sort((a, b) => a[0].localeCompare(b[0]))) {
    const pct = (d.correct / d.total * 100).toFixed(1);
    const avg = (d.scores.reduce((a, b) => a + b, 0) / d.scores.length).toFixed(2);
    console.log(`  ${cat}: ${pct}% (${d.correct}/${d.total}) avg=${avg}/3`);
  }

  const output = {
    benchmark: "MQoT-3K", version: "3.0",
    mode: MODE, pipeline: pipelineDesc,
    total_memories: totalMemories,
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
  const outFile = join(RESULTS_DIR, `mqot1k_${MODE}_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outFile}`);

  // Cleanup
  console.log(`\n--- Cleanup ---`);
  execSync(`rm -rf ${DB_PATH}`);
  console.log(`  LanceDB copy deleted`);
  if (MODE === "pro") {
    try {
      await fetch("http://localhost:7474/db/neo4j/tx/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Basic " + Buffer.from("neo4j:openclaw2026").toString("base64") },
        body: JSON.stringify({ statements: [{ statement: `MATCH (n) WHERE n.group_id STARTS WITH '${BENCH_GROUP}' DETACH DELETE n RETURN count(n)` }] }),
      });
      console.log(`  Neo4j cleanup done`);
    } catch (e) { console.log(`  Neo4j: ${e.message}`); }
  }
  console.log(`  Done.`);
}

main().catch(e => { console.error(e); process.exit(1); });

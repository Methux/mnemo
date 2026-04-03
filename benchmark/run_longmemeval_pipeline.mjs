#!/usr/bin/env node
/**
 * LongMemEval Benchmark — Full Mnemo Pipeline
 * SmartExtractor (LLM) → Embed → Store → Full Retrieval (Vector+BM25+Rerank+Decay)
 */

import { createMnemo } from "../packages/core/dist/src/mnemo.js";
import { SmartExtractor } from "../packages/core/dist/src/smart-extractor.js";
import { createLlmClient } from "../packages/core/dist/src/llm-client.js";
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
const EXTRACT_MODEL = process.env.EXTRACT_MODEL || "gpt-4.1-mini";
const MAX_QUESTIONS = parseInt(process.env.MAX_QUESTIONS || "50", 10);
const EXTRACT_CONCURRENCY = parseInt(process.env.EXTRACT_CONCURRENCY || "10", 10);
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

// ── Parallel worker pool ──
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
  console.log(`Loading ${DATA_FILE}...`);
  const allData = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  const questions = allData.slice(0, MAX_QUESTIONS);
  console.log(`Loaded ${questions.length} questions`);

  // Create Mnemo instance (full pipeline)
  const mnemo = await createMnemo({
    dbPath: "/tmp/mnemo-benchmark-pipeline",
    embedding: {
      apiKey: VOYAGE_KEY,
      baseURL: "https://api.voyageai.com/v1",
      model: "voyage-4",
      dimensions: 1024,
      taskQuery: "query",
      taskPassage: "document",
    },
  });

  // Access internal store and embedder for SmartExtractor
  const mnemoInternal = mnemo._internals || mnemo;

  console.log(`\n${"=".repeat(60)}`);
  console.log(`LongMemEval Benchmark — Mnemo Full Pipeline`);
  console.log(`Extraction: ${EXTRACT_MODEL} (${EXTRACT_CONCURRENCY} concurrent)`);
  console.log(`Judge: ${JUDGE_MODEL}, Questions: ${questions.length}`);
  console.log(`${"=".repeat(60)}`);

  // Phase 1: Build conversations per scope
  console.log(`\n--- Phase 1: Smart Extraction (${EXTRACT_CONCURRENCY} concurrent) ---`);
  const t0 = Date.now();
  const scopeConversations = []; // { scope, text }

  const seenScopes = new Set();
  for (const q of questions) {
    const qid = q.question_id;
    const scope = `lme-${qid}`;
    if (seenScopes.has(scope)) continue;
    const sessions = q.haystack_sessions || [];
    if (!sessions.length) continue;

    // Build full conversation text
    const lines = [];
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
        lines.push(`${prefix}${text}`);
      }
    }
    scopeConversations.push({ scope, text: lines.join("\n") });
    seenScopes.add(scope);
  }

  console.log(`  ${scopeConversations.length} conversations to extract`);

  // Extract using SmartExtractor with concurrent LLM calls
  let extracted = 0;
  let totalMemories = 0;

  await workerPool(scopeConversations, async (conv, i) => {
    try {
      // Each scope gets its own extraction via mnemo.store after LLM extraction
      // We'll call OpenAI directly for extraction, then store via mnemo
      const memories = await extractMemories(conv.text, conv.scope);

      // Store each extracted memory
      for (const mem of memories) {
        try {
          await mnemo.store({
            text: mem.text,
            category: mem.category,
            importance: mem.importance || 0.7,
            scope: conv.scope,
          });
          totalMemories++;
        } catch {}
      }

      extracted++;
      if (extracted % 5 === 0 || extracted <= 3) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        console.log(`  Extracted ${extracted}/${scopeConversations.length} scopes (${totalMemories} memories) — ${elapsed}s`);
      }
    } catch (e) {
      extracted++;
      console.error(`  Scope ${conv.scope} failed: ${e.message?.slice(0, 80)}`);
    }
  }, EXTRACT_CONCURRENCY);

  const extractTime = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`  Extraction complete: ${totalMemories} memories from ${extracted} scopes, ${extractTime}s`);

  // Phase 2: Evaluate with full retrieval
  console.log(`\n--- Phase 2: Evaluation (${EVAL_CONCURRENCY} concurrent) ---`);
  const CATEGORY_NAMES = {
    "single-session-user": "Single (User)", "single-session-assistant": "Single (Assistant)",
    "single-session-preference": "Single (Preference)", "multi-session": "Multi-Session",
    "knowledge-update": "Knowledge Update", "temporal-reasoning": "Temporal", "abstention": "Abstention",
  };

  const results = [];

  await workerPool(questions, async (q, qi) => {
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
    adapter: "mnemo-full-pipeline",
    benchmark: "LongMemEval",
    accuracy: parseFloat(accuracy),
    correct, total, by_type: {},
    config: { extractModel: EXTRACT_MODEL, judgeModel: JUDGE_MODEL, extractConcurrency: EXTRACT_CONCURRENCY },
    questions: results.map(r => ({
      qid: r.question_id, type: r.question_type, q: r.question,
      gold: r.gold, pred: r.predicted, score: r.score, n: r.n_retrieved,
    })),
  };
  for (const [type, data] of Object.entries(byType)) {
    output.by_type[type] = parseFloat((data.correct / data.total * 100).toFixed(1));
  }

  const outFile = join(RESULTS_DIR, `longmemeval_mnemo-pipeline_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`\nSaved to ${outFile}`);
  await mnemo.close();
}

// ── LLM-based memory extraction (same prompt as SmartExtractor) ──

async function extractMemories(conversationText, scope) {
  // GPT-4.1 supports 128K context — send full conversation, one API call per scope
  const prompt = `You are a memory extraction system. Analyze this entire conversation and extract the most important facts as structured memories.

Rules:
- Extract ONLY specific, answerable facts: names, numbers, dates, places, preferences, decisions
- Each memory should be a standalone fact that could answer a future question
- Maximum 30 memories total — be highly selective
- Combine related facts into single memories when possible

For each memory, output:
- category: one of "episodic", "semantic", "preference", "procedural", "relationship", "reflection"
- abstract: 1-line summary
- content: the specific fact with all details (names, numbers, etc.)

Conversation:
${conversationText}

Respond with ONLY valid JSON:
{"memories": [{"category": "...", "abstract": "...", "content": "..."}, ...]}`;

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: EXTRACT_MODEL,
          messages: [{ role: "user", content: prompt }],
          max_tokens: 4000,
          temperature: 0,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(120000),
      });

      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      if (!resp.ok) return [];

      const data = await resp.json();
      const content = data.choices[0]?.message?.content;
      if (!content) return [];

      const parsed = JSON.parse(content);
      if (!parsed.memories || !Array.isArray(parsed.memories)) return [];

      return parsed.memories
        .filter(m => m.abstract && m.abstract.length > 5)
        .map(m => ({
          text: m.content || m.abstract,
          category: normalizeCategory(m.category) || "fact",
          importance: 0.7,
        }));
    } catch (e) {
      if (attempt === 2) return [];
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return [];
}

function normalizeCategory(cat) {
  const map = {
    episodic: "fact", semantic: "fact", preference: "preference",
    procedural: "fact", relationship: "entity", reflection: "reflection",
    fact: "fact", decision: "decision", entity: "entity",
  };
  return map[(cat || "").toLowerCase()] || "fact";
}

main().catch(e => { console.error(e); process.exit(1); });

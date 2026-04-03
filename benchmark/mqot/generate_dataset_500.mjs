#!/usr/bin/env node
/**
 * MQoT-500 Dataset Generator — Large-scale benchmark
 *
 * Designed to test where Pro's features (rerank, decay, Graphiti) earn their keep:
 * - 50 conversations over 180 days → ~150-200 extracted memories
 * - 120 important facts with topic clustering
 * - 40 fact updates (some multi-step: A→B→C)
 * - Noise memories that test precision at scale
 * - 200 evaluation questions
 *
 * Generated in 3 batches to stay within token limits.
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(__dirname, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

async function llm(prompt, maxTokens = 16000) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4.1", messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens, temperature: 0.7, response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(300000),
      });
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
      const data = await resp.json();
      return JSON.parse(data.choices[0].message.content);
    } catch (e) { if (attempt === 4) throw e; await new Promise(r => setTimeout(r, 3000)); }
  }
}

const CHARACTER = `Jordan, 29-year-old graphic designer in Seattle.
Works at Lunar Creative (manager: Priya). Sister Maya is a nurse in Portland.
Has friends: Lena (bakery owner), Sam (college friend in NYC), Alex (running buddy).
Hobbies: running, houseplants, cooking, reading. Has a cat named Pixel.
Freelance clients on the side. Saving for Japan trip.`;

const TOPIC_CLUSTERS = [
  "work (Lunar Creative, clients, projects, salary, promotions, coworkers)",
  "running & fitness (training, races, gear, injuries, goals)",
  "family & friends (Maya, Sam, Lena, Alex, visits, gifts, celebrations)",
  "home & lifestyle (apartment, houseplants, cooking, cat Pixel, furniture)",
  "travel & goals (Japan trip, Portland visits, career goals, finances)",
  "freelance (yoga studio, bakery, tech clients, portfolio, rates)",
];

async function generateConversationBatch(batchNum, dayStart, dayEnd, numConvs, existingFacts) {
  const factsContext = existingFacts.length > 0
    ? `\nPreviously established facts (reference but don't repeat verbatim):\n${existingFacts.map(f => `- ${f}`).join("\n")}\n`
    : "";

  return llm(`Generate conversations for testing an AI memory system at scale.

Character: ${CHARACTER}
${factsContext}
Create ${numConvs} conversations between Jordan and an AI assistant, days ${dayStart}-${dayEnd} (180-day span).
Each conversation: 8-12 turns, natural flow.

TOPIC CLUSTERS (spread conversations across these):
${TOPIC_CLUSTERS.map((t, i) => `${i + 1}. ${t}`).join("\n")}

RULES:
1. IMPORTANT FACTS (~40 per batch): Specific, repeated across conversations, emotionally weighted.
   Include names, numbers, dates, places. Each should appear in 2-3 conversations.

2. FACT UPDATES (~13 per batch): EXPLICIT changes with before/after.
   Use: "switched to", "changed from", "no longer", "used to...but now", "I stopped", "upgraded to"
   ${batchNum >= 2 ? "Include 3-4 MULTI-STEP updates (fact changed again from batch 1)" : ""}

3. NOISE: Weather, generic small talk, one-off trivial mentions mixed naturally.

4. TOPIC CLUSTERING: Group related facts (e.g., 5+ facts about running that span multiple conversations).
   This tests whether the system can disambiguate between related-but-distinct memories.

Output JSON:
{
  "conversations": [{"day": ${dayStart}, "turns": [{"role": "user", "content": "..."}]}],
  "important_facts": [{"fact": "...", "category": "...", "times_mentioned": 2}],
  "fact_updates": [{"old_fact": "...", "new_fact": "...", "update_language": "switched to", "change_day": ${dayStart + 10}}]
}`, 16000);
}

async function generateQuestions(allFacts, allUpdates, batch) {
  const factsStr = allFacts.map(f => `- ${f.fact} (${f.category})`).join("\n");
  const updateStr = allUpdates.map(f => `- OLD: ${f.old_fact} → NEW: ${f.new_fact} (day ${f.change_day})`).join("\n");

  return llm(`Create ${batch === 3 ? 50 : 50} evaluation questions for an AI memory system.
The system processed 180 days of conversations with "Jordan" (graphic designer, Seattle).

IMPORTANT FACTS:
${factsStr}

FACT UPDATES:
${updateStr}

Generate questions in 4 categories (${batch === 3 ? "13/12/13/12" : "12/13/12/13"} split):

1. **retention**: Questions about important, repeated facts. Gold answer = specific fact.
2. **forgetting**: Questions about things NEVER mentioned or trivial noise. Gold = "I don't know". Include topics that SOUND plausible but were never discussed.
3. **contradiction**: Questions where facts changed. Gold = NEW value. For multi-step changes (A→B→C), gold = C.
   Include "old_answer" field with the outdated value.
4. **precision**: Specific details from important facts (numbers, names, places, dates).
   Only about facts that SHOULD be remembered (repeated, emotional, specific).

IMPORTANT:
- For contradiction: ALWAYS include "old_answer" with the stale/outdated value
- For forgetting: Invent plausible-sounding questions about topics never discussed
- Each question must be answerable from the conversations (or correctly unanswerable for forgetting)

Output JSON:
{
  "questions": [
    {"id": ${(batch - 1) * 50 + 1}, "category": "retention", "question": "...", "gold_answer": "...", "old_answer": null, "difficulty": "medium"}
  ]
}`, 16000);
}

async function main() {
  console.log("=== Generating MQoT-500 Dataset ===\n");

  // Batch 1: Days 1-60
  console.log("Batch 1/3: Days 1-60 (18 conversations)...");
  const batch1 = await generateConversationBatch(1, 1, 60, 18, []);
  console.log(`  Convs: ${batch1.conversations?.length}, Facts: ${batch1.important_facts?.length}, Updates: ${batch1.fact_updates?.length}`);

  const b1Facts = (batch1.important_facts || []).map(f => f.fact);

  // Batch 2: Days 61-120
  console.log("Batch 2/3: Days 61-120 (16 conversations)...");
  const batch2 = await generateConversationBatch(2, 61, 120, 16, b1Facts);
  console.log(`  Convs: ${batch2.conversations?.length}, Facts: ${batch2.important_facts?.length}, Updates: ${batch2.fact_updates?.length}`);

  const b2Facts = [...b1Facts, ...(batch2.important_facts || []).map(f => f.fact)];

  // Batch 3: Days 121-180
  console.log("Batch 3/3: Days 121-180 (16 conversations)...");
  const batch3 = await generateConversationBatch(3, 121, 180, 16, b2Facts);
  console.log(`  Convs: ${batch3.conversations?.length}, Facts: ${batch3.important_facts?.length}, Updates: ${batch3.fact_updates?.length}`);

  // Merge all conversations
  const allConvs = [
    ...(batch1.conversations || []),
    ...(batch2.conversations || []),
    ...(batch3.conversations || []),
  ].sort((a, b) => a.day - b.day);

  const allFacts = [
    ...(batch1.important_facts || []),
    ...(batch2.important_facts || []),
    ...(batch3.important_facts || []),
  ];

  const allUpdates = [
    ...(batch1.fact_updates || []),
    ...(batch2.fact_updates || []),
    ...(batch3.fact_updates || []),
  ];

  console.log(`\nTotal: ${allConvs.length} conversations, ${allFacts.length} facts, ${allUpdates.length} updates`);

  // Generate questions in 4 batches of 50
  console.log("\nGenerating questions (4 batches of 50)...");
  const q1 = await generateQuestions(allFacts.slice(0, 40), allUpdates.slice(0, 13), 1);
  console.log(`  Batch 1: ${q1.questions?.length} questions`);
  const q2 = await generateQuestions(allFacts.slice(20, 60), allUpdates.slice(5, 20), 2);
  console.log(`  Batch 2: ${q2.questions?.length} questions`);
  const q3 = await generateQuestions(allFacts.slice(40, 80), allUpdates.slice(13, 30), 3);
  console.log(`  Batch 3: ${q3.questions?.length} questions`);
  const q4 = await generateQuestions(allFacts.slice(60), allUpdates.slice(20), 4);
  console.log(`  Batch 4: ${q4.questions?.length} questions`);

  const allQuestions = [
    ...(q1.questions || []),
    ...(q2.questions || []),
    ...(q3.questions || []),
    ...(q4.questions || []),
  ];

  // Re-number IDs
  allQuestions.forEach((q, i) => q.id = i + 1);

  const dataset = {
    metadata: {
      name: "MQoT-500 — Large-scale Memory Quality Over Time",
      version: "3.0",
      created: new Date().toISOString(),
      scale: "500+ memories, 180 days, 200 questions",
      philosophy: "Tests intelligent memory at scale: topic disambiguation, temporal reasoning, noise filtering",
    },
    conversations: allConvs,
    important_facts: allFacts,
    fact_updates: allUpdates,
    questions: allQuestions,
  };

  const outFile = join(__dirname, "dataset_500.json");
  writeFileSync(outFile, JSON.stringify(dataset, null, 2));
  console.log(`\nSaved to ${outFile}`);
  console.log(`  Conversations: ${dataset.conversations.length}`);
  console.log(`  Important facts: ${dataset.important_facts.length}`);
  console.log(`  Updates: ${dataset.fact_updates.length}`);
  console.log(`  Questions: ${dataset.questions.length}`);

  // Stats by category
  const cats = {};
  for (const q of allQuestions) {
    cats[q.category] = (cats[q.category] || 0) + 1;
  }
  console.log(`  By category: ${JSON.stringify(cats)}`);
}

main().catch(e => { console.error(e); process.exit(1); });

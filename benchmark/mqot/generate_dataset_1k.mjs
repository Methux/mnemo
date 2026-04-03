#!/usr/bin/env node
/**
 * MQoT-1K Dataset Generator — Large-scale benchmark
 *
 * Target: 150 conversations, 365 days, 500-1000 extracted memories, 400 questions.
 * Generated in 6 conversation batches + 8 question batches.
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
Has friends: Lena (bakery owner), Sam (college friend in NYC), Alex (running buddy), Noor (new coworker starting month 4).
Hobbies: running, houseplants, cooking, reading, photography. Has a cat named Pixel.
Freelance clients on the side. Saving for Japan trip.
Romantic partner: starts dating Taylor (UX designer) around month 5.
Side project: starts a design blog around month 7.`;

const TOPIC_CLUSTERS = [
  "work (Lunar Creative, clients, projects, salary, promotions, coworkers Noor/Casey/Emily, performance review)",
  "running & fitness (training, races, gear, injuries, goals, running group, 10K→half marathon→full marathon progression)",
  "family & friends (Maya, Sam, Lena, Alex, visits, gifts, celebrations, Maya's engagement)",
  "home & lifestyle (apartment, houseplants, cooking, cat Pixel, furniture, neighborhood, lease renewal)",
  "travel & goals (Japan trip, Portland visits, career goals, finances, savings milestones)",
  "freelance (yoga studio, bakery, tech clients, portfolio, rates, new clients over time)",
  "relationships (Taylor, dates, milestones, meeting friends, moving in discussions)",
  "creative & learning (design blog, photography, online courses, books, conferences)",
];

async function generateConversationBatch(batchNum, dayStart, dayEnd, numConvs, existingFacts) {
  const factsContext = existingFacts.length > 0
    ? `\nPreviously established facts (reference but don't repeat verbatim, max 60 shown):\n${existingFacts.slice(-60).map(f => `- ${f}`).join("\n")}\n`
    : "";

  return llm(`Generate conversations for testing an AI memory system at LARGE scale.

Character: ${CHARACTER}
${factsContext}
Create ${numConvs} conversations between Jordan and an AI assistant, days ${dayStart}-${dayEnd} (within a 365-day span).
Each conversation: 8-14 turns, natural flow.

TOPIC CLUSTERS (spread conversations across ALL of these):
${TOPIC_CLUSTERS.map((t, i) => `${i + 1}. ${t}`).join("\n")}

RULES:
1. IMPORTANT FACTS (~30 per batch): Specific, precise details with names, numbers, dates, places.
   Each fact should appear in 2-3 conversations for reinforcement.

2. FACT UPDATES (~10 per batch): EXPLICIT changes with before/after.
   Use: "switched to", "changed from", "no longer", "used to...but now", "I stopped", "upgraded to"
   ${batchNum >= 3 ? "Include 3-4 MULTI-STEP updates (fact changed again from earlier batches)" : ""}

3. NOISE: Weather, generic small talk, one-off trivial mentions mixed naturally (~30% of conversation turns).

4. TOPIC CLUSTERING: Group related facts across conversations. E.g., 5+ facts about running spanning multiple conversations.
   This tests disambiguation between related-but-distinct memories.

5. TEMPORAL DENSITY: Include specific dates ("next Thursday", "on March 15th"), deadlines, and time-relative statements.
   This tests temporal reasoning.

6. ENTITY DENSITY: Mention multiple people by name in the same conversation. Test entity disambiguation.
   E.g., "Alex and I ran, then Sam called, and Lena dropped off pastries."

Output JSON:
{
  "conversations": [{"day": ${dayStart}, "turns": [{"role": "user", "content": "..."}]}],
  "important_facts": [{"fact": "...", "category": "...", "times_mentioned": 2}],
  "fact_updates": [{"old_fact": "...", "new_fact": "...", "update_language": "switched to", "change_day": ${dayStart + 10}}]
}`, 16000);
}

async function generateQuestions(allFacts, allUpdates, batchNum, totalBatches) {
  const questionsPerBatch = 50;
  const factsStr = allFacts.map(f => `- ${f.fact} (${f.category})`).join("\n");
  const updateStr = allUpdates.map(f => `- OLD: ${f.old_fact} → NEW: ${f.new_fact} (day ${f.change_day})`).join("\n");

  const splits = ["13/12/13/12", "12/13/12/13"];
  const split = splits[batchNum % 2];

  return llm(`Create ${questionsPerBatch} evaluation questions for an AI memory system.
The system processed 365 days of conversations with "Jordan" (graphic designer, Seattle).
This is question batch ${batchNum + 1} of ${totalBatches}.

IMPORTANT FACTS (subset for this batch):
${factsStr}

FACT UPDATES (subset for this batch):
${updateStr}

Generate questions in 4 categories (${split} split):

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
- Questions should be DIVERSE — different phrasings, different angles on the same facts
- Do NOT ask the same question twice across batches

Output JSON:
{
  "questions": [
    {"id": ${batchNum * questionsPerBatch + 1}, "category": "retention", "question": "...", "gold_answer": "...", "old_answer": null, "difficulty": "medium"}
  ]
}`, 16000);
}

async function main() {
  console.log("=== Generating MQoT-1K Dataset ===\n");

  const CONV_BATCHES = [
    { num: 1, dayStart: 1,   dayEnd: 60,  convs: 25 },
    { num: 2, dayStart: 61,  dayEnd: 120, convs: 25 },
    { num: 3, dayStart: 121, dayEnd: 180, convs: 25 },
    { num: 4, dayStart: 181, dayEnd: 240, convs: 25 },
    { num: 5, dayStart: 241, dayEnd: 300, convs: 25 },
    { num: 6, dayStart: 301, dayEnd: 365, convs: 25 },
  ];

  let allConvs = [];
  let allFacts = [];
  let allUpdates = [];
  let factTexts = [];

  for (const b of CONV_BATCHES) {
    console.log(`Batch ${b.num}/6: Days ${b.dayStart}-${b.dayEnd} (${b.convs} conversations)...`);
    const result = await generateConversationBatch(b.num, b.dayStart, b.dayEnd, b.convs, factTexts);
    const convs = result.conversations || [];
    const facts = result.important_facts || [];
    const updates = result.fact_updates || [];
    console.log(`  Convs: ${convs.length}, Facts: ${facts.length}, Updates: ${updates.length}`);

    allConvs.push(...convs);
    allFacts.push(...facts);
    allUpdates.push(...updates);
    factTexts.push(...facts.map(f => f.fact));
  }

  allConvs.sort((a, b) => a.day - b.day);
  console.log(`\nTotal: ${allConvs.length} conversations, ${allFacts.length} facts, ${allUpdates.length} updates`);

  // Generate questions in 8 batches of 50
  const Q_BATCHES = 8;
  console.log(`\nGenerating questions (${Q_BATCHES} batches of 50)...`);
  let allQuestions = [];

  for (let i = 0; i < Q_BATCHES; i++) {
    const factSliceSize = Math.ceil(allFacts.length / Q_BATCHES);
    const updateSliceSize = Math.ceil(allUpdates.length / Q_BATCHES);
    const factStart = Math.max(0, i * factSliceSize - 10); // overlap for variety
    const factEnd = Math.min(allFacts.length, (i + 1) * factSliceSize + 10);
    const updateStart = Math.max(0, i * updateSliceSize - 3);
    const updateEnd = Math.min(allUpdates.length, (i + 1) * updateSliceSize + 3);

    const qResult = await generateQuestions(
      allFacts.slice(factStart, factEnd),
      allUpdates.slice(updateStart, updateEnd),
      i,
      Q_BATCHES,
    );
    const qs = qResult.questions || [];
    console.log(`  Batch ${i + 1}: ${qs.length} questions`);
    allQuestions.push(...qs);
  }

  // Re-number IDs
  allQuestions.forEach((q, i) => q.id = i + 1);

  const dataset = {
    metadata: {
      name: "MQoT-1K — Large-scale Memory Quality Over Time",
      version: "4.0",
      created: new Date().toISOString(),
      scale: "1000+ memories, 365 days, 400 questions",
      philosophy: "Tests Pro features at scale: entity disambiguation, temporal reasoning, noise filtering, contradiction tracking",
    },
    conversations: allConvs,
    important_facts: allFacts,
    fact_updates: allUpdates,
    questions: allQuestions,
  };

  const outFile = join(__dirname, "dataset_1k.json");
  writeFileSync(outFile, JSON.stringify(dataset, null, 2));
  console.log(`\nSaved to ${outFile}`);
  console.log(`  Conversations: ${dataset.conversations.length}`);
  console.log(`  Important facts: ${dataset.important_facts.length}`);
  console.log(`  Updates: ${dataset.fact_updates.length}`);
  console.log(`  Questions: ${dataset.questions.length}`);

  const cats = {};
  for (const q of allQuestions) {
    cats[q.category] = (cats[q.category] || 0) + 1;
  }
  console.log(`  By category: ${JSON.stringify(cats)}`);
}

main().catch(e => { console.error(e); process.exit(1); });

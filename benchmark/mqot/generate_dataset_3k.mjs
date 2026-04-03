#!/usr/bin/env node
/**
 * MQoT-3K Dataset Generator — Large-scale benchmark
 *
 * Target: 400 conversations, 730 days (2 years), 2000-3000 extracted memories, 600 questions.
 * Generated in 10 conversation batches + 12 question batches.
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
Has friends: Lena (bakery owner), Sam (college friend in NYC), Alex (running buddy), Noor (coworker since month 4).
Hobbies: running, houseplants, cooking, reading, photography. Has a cat named Pixel.
Freelance clients on the side. Saving for Japan trip.
Romantic partner: starts dating Taylor (UX designer) around month 5, moves in together around month 14.
Side project: starts a design blog around month 7, launches podcast around month 18.
Career: promoted to Lead Designer month 10, starts mentoring junior designer Casey month 12.
Year 2 developments: Japan trip happens month 15, new freelance specialty (brand strategy), considering starting own studio.`;

const TOPIC_CLUSTERS = [
  "work (Lunar Creative, clients, projects, salary, promotions, coworkers Noor/Casey/Emily, reviews, team lead role)",
  "running & fitness (training, races 10K→half→full marathon, gear changes, injuries, running group, coaching Alex)",
  "family & friends (Maya wedding, Sam visits, Lena bakery expansion, Alex moving away, new friends from running group)",
  "home & lifestyle (apartment→moving with Taylor, houseplants expanding, cooking Japanese recipes, cat Pixel adventures)",
  "travel & goals (Japan trip planning→execution→return, Portland visits, career pivot goals, financial milestones)",
  "freelance & business (yoga studio, bakery, tech clients, rate increases $65→$75→$90, portfolio evolution, studio plans)",
  "relationships (Taylor dates→moving in→anniversary, meeting families, adopting a dog, relationship milestones)",
  "creative & learning (design blog→podcast, photography exhibitions, online courses, books, conference speaking)",
  "finances (Japan savings→trip→post-trip, freelance income tracking, raise negotiations, studio startup costs)",
  "health & wellness (running injuries, diet changes, mental health days, meditation, sleep habits, ergonomic setup)",
];

async function generateConversationBatch(batchNum, dayStart, dayEnd, numConvs, existingFacts) {
  const factsContext = existingFacts.length > 0
    ? `\nPreviously established facts (reference but don't repeat verbatim, max 80 shown):\n${existingFacts.slice(-80).map(f => `- ${f}`).join("\n")}\n`
    : "";

  return llm(`Generate conversations for testing an AI memory system at VERY LARGE scale.

Character: ${CHARACTER}
${factsContext}
Create ${numConvs} conversations between Jordan and an AI assistant, days ${dayStart}-${dayEnd} (within a 730-day / 2-year span).
Each conversation: 8-14 turns, natural flow.

TOPIC CLUSTERS (spread conversations across ALL of these):
${TOPIC_CLUSTERS.map((t, i) => `${i + 1}. ${t}`).join("\n")}

RULES:
1. IMPORTANT FACTS (~40 per batch): Specific, precise details with names, numbers, dates, places.
   Each fact should appear in 2-3 conversations for reinforcement.

2. FACT UPDATES (~15 per batch): EXPLICIT changes with before/after.
   Use: "switched to", "changed from", "no longer", "used to...but now", "I stopped", "upgraded to"
   ${batchNum >= 3 ? "Include 5-6 MULTI-STEP updates (fact changed again from earlier batches)" : ""}
   ${batchNum >= 6 ? "Include 3-4 REVERSAL updates (went back to earlier value)" : ""}

3. NOISE: Weather, generic small talk, one-off trivial mentions mixed naturally (~30% of conversation turns).

4. TOPIC CLUSTERING: Group related facts across conversations. E.g., 8+ facts about running spanning multiple conversations.

5. TEMPORAL DENSITY: Include specific dates, deadlines, and time-relative statements.

6. ENTITY DENSITY: Mention multiple people by name in the same conversation.

7. YEAR 2 EVOLUTION: ${batchNum >= 6 ? "Jordan's life has evolved significantly — new job responsibilities, living with Taylor, post-Japan trip reflections, freelance growth. Facts should reflect maturity and change." : "Early/mid period — establishing baseline facts."}

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
The system processed 730 days (2 years) of conversations with "Jordan" (graphic designer, Seattle).
This is question batch ${batchNum + 1} of ${totalBatches}.

IMPORTANT FACTS (subset for this batch):
${factsStr}

FACT UPDATES (subset for this batch):
${updateStr}

Generate questions in 4 categories (${split} split):

1. **retention**: Questions about important, repeated facts. Gold answer = specific fact.
2. **forgetting**: Questions about things NEVER mentioned or trivial noise. Gold = "I don't know".
3. **contradiction**: Questions where facts changed. Gold = NEW value. For multi-step changes (A→B→C), gold = C.
   Include "old_answer" field with the outdated value.
4. **precision**: Specific details from important facts (numbers, names, places, dates).

IMPORTANT:
- For contradiction: ALWAYS include "old_answer" with the stale/outdated value
- For forgetting: Invent plausible-sounding questions about topics never discussed
- Each question must be answerable from the conversations
- Questions should be DIVERSE
- Do NOT ask the same question twice

Output JSON:
{
  "questions": [
    {"id": ${batchNum * questionsPerBatch + 1}, "category": "retention", "question": "...", "gold_answer": "...", "old_answer": null, "difficulty": "medium"}
  ]
}`, 16000);
}

async function main() {
  console.log("=== Generating MQoT-3K Dataset ===\n");

  const CONV_BATCHES = [
    { num: 1,  dayStart: 1,   dayEnd: 73,  convs: 40 },
    { num: 2,  dayStart: 74,  dayEnd: 146, convs: 40 },
    { num: 3,  dayStart: 147, dayEnd: 219, convs: 40 },
    { num: 4,  dayStart: 220, dayEnd: 292, convs: 40 },
    { num: 5,  dayStart: 293, dayEnd: 365, convs: 40 },
    { num: 6,  dayStart: 366, dayEnd: 438, convs: 40 },
    { num: 7,  dayStart: 439, dayEnd: 511, convs: 40 },
    { num: 8,  dayStart: 512, dayEnd: 584, convs: 40 },
    { num: 9,  dayStart: 585, dayEnd: 657, convs: 40 },
    { num: 10, dayStart: 658, dayEnd: 730, convs: 40 },
  ];

  let allConvs = [];
  let allFacts = [];
  let allUpdates = [];
  let factTexts = [];

  for (const b of CONV_BATCHES) {
    console.log(`Batch ${b.num}/10: Days ${b.dayStart}-${b.dayEnd} (${b.convs} conversations)...`);
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

  // Generate questions in 12 batches of 50
  const Q_BATCHES = 12;
  console.log(`\nGenerating questions (${Q_BATCHES} batches of 50)...`);
  let allQuestions = [];

  for (let i = 0; i < Q_BATCHES; i++) {
    const factSliceSize = Math.ceil(allFacts.length / Q_BATCHES);
    const updateSliceSize = Math.ceil(allUpdates.length / Q_BATCHES);
    const factStart = Math.max(0, i * factSliceSize - 10);
    const factEnd = Math.min(allFacts.length, (i + 1) * factSliceSize + 10);
    const updateStart = Math.max(0, i * updateSliceSize - 3);
    const updateEnd = Math.min(allUpdates.length, (i + 1) * updateSliceSize + 3);

    const qResult = await generateQuestions(
      allFacts.slice(factStart, factEnd),
      allUpdates.slice(updateStart, updateEnd),
      i, Q_BATCHES,
    );
    const qs = qResult.questions || [];
    console.log(`  Batch ${i + 1}: ${qs.length} questions`);
    allQuestions.push(...qs);
  }

  allQuestions.forEach((q, i) => { q.id = i + 1; });

  const dataset = {
    version: "3k-v1",
    generated: new Date().toISOString(),
    conversations: allConvs,
    important_facts: allFacts,
    fact_updates: allUpdates,
    questions: allQuestions,
  };

  const outFile = join(__dirname, "dataset_3k.json");
  writeFileSync(outFile, JSON.stringify(dataset, null, 2));
  console.log(`\nSaved to ${outFile}`);
  console.log(`  ${allConvs.length} conversations`);
  console.log(`  ${allFacts.length} facts`);
  console.log(`  ${allUpdates.length} updates`);
  console.log(`  ${allQuestions.length} questions`);
}

main().catch(e => { console.error(e); process.exit(1); });

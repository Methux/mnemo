#!/usr/bin/env node
/**
 * Generate 30-day simulated agent conversation dataset
 *
 * Structure:
 *   - 30 days, ~10 conversations/day, ~5 turns each
 *   - Day 1-10: Establish facts (preferences, background, routines)
 *   - Day 11-20: Repeat queries + knowledge updates (changes preferences, new facts)
 *   - Day 21-30: Complex queries referencing old + updated info
 *   - 100 evaluation questions with gold answers
 */

import { writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

async function llm(prompt, maxTokens = 4000) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4.1",
          messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens,
          temperature: 0.7,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (resp.status === 429) {
        await new Promise(r => setTimeout(r, 3000 * (attempt + 1)));
        continue;
      }
      const data = await resp.json();
      return JSON.parse(data.choices[0].message.content);
    } catch (e) {
      if (attempt === 4) throw e;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
}

async function generatePhase1() {
  console.log("Generating Phase 1: Days 1-10 (establishing facts)...");
  const prompt = `Generate 10 days of conversations between a user and an AI assistant. Each day has 3-5 short conversations (2-4 turns each).

The user is "Alex", a 32-year-old software engineer in San Francisco. Over these 10 days, the conversations should naturally reveal:

Personal facts (at least 20 distinct facts):
- Full name, age, birthday, hometown
- Job title, company name, team, manager's name
- Partner's name, pet's name and breed
- Home address neighborhood, apartment details
- Favorite restaurants (3+), coffee order, dietary preferences
- Hobbies (3+), gym schedule, morning routine
- Car make/model, commute method
- Vacation plans, recent purchases
- Family members (parents, siblings)
- Medical: allergies, doctor's name

Each conversation should feel natural — facts emerge organically, not as a list.

Output JSON:
{
  "days": [
    {
      "day": 1,
      "conversations": [
        {
          "turns": [
            {"role": "user", "content": "..."},
            {"role": "assistant", "content": "..."}
          ]
        }
      ]
    }
  ],
  "facts_established": [
    {"fact": "Alex's birthday is March 15", "day_mentioned": 1, "category": "personal"}
  ]
}`;

  return await llm(prompt, 8000);
}

async function generatePhase2(phase1Facts) {
  console.log("Generating Phase 2: Days 11-20 (updates + repeated access)...");
  const factsStr = phase1Facts.map(f => `- ${f.fact} (day ${f.day_mentioned})`).join("\n");

  const prompt = `Continue the 30-day conversation dataset. Days 11-20.

Previously established facts:
${factsStr}

In this phase, generate conversations where:
1. User ASKS ABOUT previously mentioned facts (triggering recall/access tracking) — at least 10 such queries
2. Some facts CHANGE (knowledge updates):
   - Alex switches from coffee to matcha (was coffee before)
   - Alex gets promoted to Senior Engineer
   - Alex's partner gets a new job
   - Alex starts a new hobby (pottery)
   - Alex moves to a different neighborhood
   - Alex changes gym schedule
3. New facts are introduced (5-10 new ones)

Each day: 3-5 conversations, 2-4 turns each. Make recall queries natural ("Remember when I told you about...?", "What was my...?")

Output JSON:
{
  "days": [
    {
      "day": 11,
      "conversations": [{"turns": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}]
    }
  ],
  "facts_updated": [
    {"old_fact": "Alex drinks coffee", "new_fact": "Alex switched to matcha", "day_updated": 13}
  ],
  "facts_new": [
    {"fact": "Alex started pottery classes", "day_mentioned": 15, "category": "hobby"}
  ],
  "recall_queries": [
    {"query": "What's my partner's name?", "day": 12, "expected_answer": "Sarah"}
  ]
}`;

  return await llm(prompt, 8000);
}

async function generatePhase3(allFacts, updatedFacts) {
  console.log("Generating Phase 3: Days 21-30 (complex queries)...");
  const factsStr = allFacts.map(f => `- ${f.fact}`).join("\n");
  const updatesStr = updatedFacts.map(f => `- OLD: ${f.old_fact} → NEW: ${f.new_fact} (day ${f.day_updated})`).join("\n");

  const prompt = `Continue the 30-day conversation dataset. Days 21-30.

All known facts:
${factsStr}

Knowledge updates:
${updatesStr}

In this phase, generate conversations that:
1. Test CURRENT knowledge (should return updated facts, not old ones)
2. Cross-reference multiple facts ("What restaurant near my new neighborhood do I like?")
3. Temporal reasoning ("What changed since I first mentioned my job?")
4. Some normal daily conversations too

Each day: 3-5 conversations, 2-4 turns each.

Output JSON:
{
  "days": [
    {
      "day": 21,
      "conversations": [{"turns": [{"role": "user", "content": "..."}, {"role": "assistant", "content": "..."}]}]
    }
  ]
}`;

  return await llm(prompt, 8000);
}

async function generateEvalQuestions(allFacts, updatedFacts) {
  console.log("Generating 100 evaluation questions...");
  const factsStr = allFacts.map(f => `- ${f.fact}`).join("\n");
  const updatesStr = updatedFacts.map(f => `- OLD: ${f.old_fact} → NEW: ${f.new_fact}`).join("\n");

  const prompt = `Create 100 evaluation questions for an AI memory system. The system has been given 30 days of conversations with user "Alex".

Known facts:
${factsStr}

Knowledge updates (system should answer with the LATEST info):
${updatesStr}

Generate questions in these categories:
1. **basic_recall** (30 questions): Simple fact retrieval ("What is Alex's birthday?")
2. **updated_knowledge** (20 questions): Facts that changed — correct answer is the NEW value
3. **temporal** (15 questions): Time-related ("When did Alex change jobs?", "What was Alex's hobby before pottery?")
4. **cross_reference** (15 questions): Combining multiple facts ("Does Alex's commute to the new neighborhood take longer?")
5. **frequency** (10 questions): Facts mentioned/accessed multiple times should be stronger
6. **abstention** (10 questions): Questions about things never mentioned — correct answer is "I don't know"

Output JSON:
{
  "questions": [
    {
      "id": 1,
      "category": "basic_recall",
      "question": "What is Alex's birthday?",
      "gold_answer": "March 15",
      "difficulty": "easy"
    }
  ]
}`;

  return await llm(prompt, 8000);
}

async function main() {
  console.log("=== Generating 30-Day Longterm Benchmark Dataset ===\n");

  // Phase 1
  const phase1 = await generatePhase1();
  console.log(`  Phase 1: ${phase1.days?.length || 0} days, ${phase1.facts_established?.length || 0} facts`);

  // Phase 2
  const phase2 = await generatePhase2(phase1.facts_established || []);
  console.log(`  Phase 2: ${phase2.days?.length || 0} days, ${phase2.facts_updated?.length || 0} updates, ${phase2.recall_queries?.length || 0} recall queries`);

  // Phase 3
  const allFacts = [
    ...(phase1.facts_established || []),
    ...(phase2.facts_new || []),
  ];
  const phase3 = await generatePhase3(allFacts, phase2.facts_updated || []);
  console.log(`  Phase 3: ${phase3.days?.length || 0} days`);

  // Eval questions
  const evalData = await generateEvalQuestions(allFacts, phase2.facts_updated || []);
  console.log(`  Eval: ${evalData.questions?.length || 0} questions`);

  // Combine
  const dataset = {
    metadata: {
      name: "Mnemo 30-Day Longterm Benchmark",
      version: "1.0",
      created: new Date().toISOString(),
      user_profile: "Alex, 32, software engineer, San Francisco",
      total_days: 30,
      total_conversations: (phase1.days || []).concat(phase2.days || [], phase3.days || [])
        .reduce((sum, d) => sum + (d.conversations?.length || 0), 0),
    },
    days: [
      ...(phase1.days || []),
      ...(phase2.days || []),
      ...(phase3.days || []),
    ],
    facts_established: phase1.facts_established || [],
    facts_updated: phase2.facts_updated || [],
    facts_new: phase2.facts_new || [],
    recall_queries: phase2.recall_queries || [],
    questions: evalData.questions || [],
  };

  const outFile = join(__dirname, "dataset.json");
  writeFileSync(outFile, JSON.stringify(dataset, null, 2));
  console.log(`\nSaved to ${outFile}`);
  console.log(`  Days: ${dataset.days.length}`);
  console.log(`  Questions: ${dataset.questions.length}`);
  console.log(`  Facts: ${dataset.facts_established.length} established + ${dataset.facts_new.length} new + ${dataset.facts_updated.length} updated`);
}

main().catch(e => { console.error(e); process.exit(1); });

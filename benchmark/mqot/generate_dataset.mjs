#!/usr/bin/env node
/**
 * MQoT (Memory Quality Over Time) Benchmark — Dataset Generator
 *
 * Tests 4 dimensions unique to Mnemo:
 *   1. Retention: Important memories survive, trivial ones don't
 *   2. Forgetting: Weibull decay correctly prioritizes by tier
 *   3. Contradiction: Updated facts replace old ones
 *   4. Precision: Extracted memories are accurate and retrievable
 *
 * Structure:
 *   - 20 conversations across 60 simulated days
 *   - 50 important facts (mentioned multiple times, high emotional salience)
 *   - 50 trivial facts (mentioned once, low importance)
 *   - 20 fact updates (old → new, with clear timestamps)
 *   - 100 evaluation questions (25 per category)
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(__dirname, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

async function llm(prompt, maxTokens = 8000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4.1", messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens, temperature: 0.7, response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(120000),
      });
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
      const data = await resp.json();
      return JSON.parse(data.choices[0].message.content);
    } catch (e) { if (attempt === 2) throw e; await new Promise(r => setTimeout(r, 3000)); }
  }
}

async function main() {
  console.log("=== Generating MQoT Dataset ===\n");

  // Step 1: Generate conversations with embedded facts
  console.log("Generating conversations with important + trivial facts...");
  const convData = await llm(`Generate a dataset for testing AI memory quality over time.

The user is "Jordan", a 29-year-old graphic designer in Seattle.

Create 20 conversations between Jordan and an AI assistant across 60 days. Each conversation is 4-8 turns.

Embed these types of facts naturally:

IMPORTANT FACTS (50): These should be mentioned in multiple conversations, reinforced, emotionally significant.
Examples: family members, job details, health conditions, major life events, strong preferences, recurring activities.

TRIVIAL FACTS (50): Mentioned only once, casually, low emotional weight.
Examples: what Jordan had for lunch one day, a random store visited, a passing comment about weather, a minor purchase.

FACT UPDATES (20): Facts that CHANGE over time with clear before/after:
- Day 1-20: Jordan drinks oat milk lattes → Day 35: switched to black coffee
- Day 5: Jordan's cat is named Pixel → Day 45: adopted a second cat named Glitch
- Day 10: Jordan uses Figma → Day 40: switched to Framer
(Generate 20 such updates with clear day numbers)

Output JSON:
{
  "conversations": [
    {
      "day": 1,
      "turns": [
        {"role": "user", "content": "..."},
        {"role": "assistant", "content": "..."}
      ]
    }
  ],
  "important_facts": [
    {"fact": "Jordan's sister Maya is a nurse in Portland", "first_mentioned_day": 2, "times_mentioned": 4, "category": "family"}
  ],
  "trivial_facts": [
    {"fact": "Jordan had a blueberry scone for breakfast on day 7", "mentioned_day": 7, "category": "trivial"}
  ],
  "fact_updates": [
    {"old_fact": "Jordan drinks oat milk lattes", "new_fact": "Jordan switched to black coffee", "change_day": 35, "category": "preference"}
  ]
}`, 16000);

  console.log(`  Conversations: ${convData.conversations?.length || 0}`);
  console.log(`  Important facts: ${convData.important_facts?.length || 0}`);
  console.log(`  Trivial facts: ${convData.trivial_facts?.length || 0}`);
  console.log(`  Fact updates: ${convData.fact_updates?.length || 0}`);

  // Step 2: Generate evaluation questions
  console.log("\nGenerating evaluation questions...");
  const importantStr = (convData.important_facts || []).map(f => `- ${f.fact}`).join("\n");
  const trivialStr = (convData.trivial_facts || []).map(f => `- ${f.fact}`).join("\n");
  const updateStr = (convData.fact_updates || []).map(f => `- OLD: ${f.old_fact} → NEW: ${f.new_fact} (day ${f.change_day})`).join("\n");

  const evalData = await llm(`Create 100 evaluation questions for testing AI memory quality. The AI has been given 60 days of conversations with user "Jordan".

IMPORTANT FACTS (should be remembered):
${importantStr}

TRIVIAL FACTS (should fade over time):
${trivialStr}

FACT UPDATES (should use NEW value):
${updateStr}

Generate exactly 25 questions per category:

1. **retention** (25): Questions about IMPORTANT facts. Correct answer exists and should be found.

2. **forgetting** (25): Questions about TRIVIAL facts. A good memory system may not remember these (and that's OK). Gold answer is the fact, but scoring considers "I don't know" as partially correct for truly trivial info.

3. **contradiction** (25): Questions where the fact CHANGED. Correct answer is the NEW value. Using the OLD value = wrong.

4. **precision** (25): Questions that require SPECIFIC details from important facts (exact names, numbers, dates). Tests extraction quality.

Output JSON:
{
  "questions": [
    {
      "id": 1,
      "category": "retention",
      "question": "What is Jordan's sister's name?",
      "gold_answer": "Maya",
      "old_answer": null,
      "difficulty": "easy"
    }
  ]
}`, 8000);

  console.log(`  Questions: ${evalData.questions?.length || 0}`);

  // Combine
  const dataset = {
    metadata: {
      name: "MQoT — Memory Quality Over Time",
      version: "1.0",
      created: new Date().toISOString(),
      user: "Jordan, 29, graphic designer, Seattle",
      days: 60,
      description: "Tests 4 dimensions: retention, forgetting, contradiction handling, extraction precision",
    },
    conversations: convData.conversations || [],
    important_facts: convData.important_facts || [],
    trivial_facts: convData.trivial_facts || [],
    fact_updates: convData.fact_updates || [],
    questions: evalData.questions || [],
  };

  const outFile = join(__dirname, "dataset.json");
  writeFileSync(outFile, JSON.stringify(dataset, null, 2));
  console.log(`\nSaved to ${outFile}`);
  console.log(`  Conversations: ${dataset.conversations.length}`);
  console.log(`  Important: ${dataset.important_facts.length}`);
  console.log(`  Trivial: ${dataset.trivial_facts.length}`);
  console.log(`  Updates: ${dataset.fact_updates.length}`);
  console.log(`  Questions: ${dataset.questions.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * MQoT v2 Dataset Generator
 *
 * Aligned with Mnemo's design philosophy: 存得精、忘得对、找得准
 *
 * Key differences from v1:
 *   - Longer conversations (10-15 turns) with natural information density
 *   - Important facts are repeated, emotionally weighted, decision-relevant
 *   - Trivial facts are clearly casual/throwaway
 *   - Fact updates are EXPLICIT ("I changed X to Y", "I no longer do X")
 *   - Precision tests details within IMPORTANT contexts only
 *   - Scoring rewards intelligent filtering, not total recall
 */

import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
mkdirSync(__dirname, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }

async function llm(prompt, maxTokens = 16000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_KEY}` },
        body: JSON.stringify({
          model: "gpt-4.1", messages: [{ role: "user", content: prompt }],
          max_tokens: maxTokens, temperature: 0.7, response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(180000),
      });
      if (resp.status === 429) { await new Promise(r => setTimeout(r, 5000)); continue; }
      const data = await resp.json();
      return JSON.parse(data.choices[0].message.content);
    } catch (e) { if (attempt === 2) throw e; await new Promise(r => setTimeout(r, 3000)); }
  }
}

async function main() {
  console.log("=== Generating MQoT v2 Dataset ===\n");

  console.log("Step 1: Generating conversations...");
  const convData = await llm(`Generate a dataset for testing AI memory systems.

User: "Jordan", 29-year-old graphic designer in Seattle.

Create 15 conversations between Jordan and an AI assistant across 60 days.
Each conversation should be 10-15 turns (longer, more natural than typical benchmarks).

IMPORTANT DESIGN RULES:

1. IMPORTANT FACTS (30 total): These should feel naturally significant:
   - Mentioned in MULTIPLE conversations (2-3 times each)
   - Emotionally weighted ("I'm really excited about...", "This is important to me...")
   - Decision-relevant ("I decided to...", "I'm committed to...")
   - Specific with concrete details (names, numbers, dates, places)
   Examples:
   - "My sister Maya is a nurse in Portland — she just got promoted to head nurse!"
   - "I switched to Framer from Figma for all my design work now, it's so much better"
   - "My annual salary review came in: $95,000, up from $88,000"

2. TRIVIAL NOISE (mixed into conversations naturally):
   - Weather comments, small talk, generic pleasantries
   - One-off mentions ("I had a sandwich today", "the traffic was bad")
   - Generic questions not about Jordan personally
   These should NOT be extracted by a good memory system.

3. FACT UPDATES (15 total): EXPLICIT changes with clear before/after:
   - "I used to drink oat milk lattes, but I switched to black coffee last month"
   - "Remember I said I use Figma? Well, I've completely moved to Framer now"
   - "We got a second cat! Her name is Glitch — Pixel has a new friend"
   Each update MUST use explicit change language (switched, changed, no longer, now instead of, used to).

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
    {
      "fact": "Jordan's sister Maya is a head nurse in Portland",
      "category": "family",
      "times_mentioned": 3,
      "emotional_weight": "high",
      "has_specific_details": true
    }
  ],
  "fact_updates": [
    {
      "old_fact": "Jordan drinks oat milk lattes",
      "new_fact": "Jordan switched to black coffee",
      "update_language": "switched to",
      "change_day": 35
    }
  ]
}`);

  console.log(`  Conversations: ${convData.conversations?.length || 0}`);
  console.log(`  Important facts: ${convData.important_facts?.length || 0}`);
  console.log(`  Fact updates: ${convData.fact_updates?.length || 0}`);

  console.log("\nStep 2: Generating evaluation questions...");
  const factsStr = (convData.important_facts || []).map(f => `- ${f.fact} (${f.category}, mentioned ${f.times_mentioned}x)`).join("\n");
  const updateStr = (convData.fact_updates || []).map(f => `- OLD: ${f.old_fact} → NEW: ${f.new_fact} (day ${f.change_day})`).join("\n");

  const evalData = await llm(`Create 100 evaluation questions for an AI memory system. The system processes 60 days of conversations with "Jordan".

The system is designed to:
- EXTRACT important, specific personal facts
- FORGET trivial noise
- HANDLE contradictions by keeping the latest value
- PRESERVE precise details within important contexts

IMPORTANT FACTS the system SHOULD remember:
${factsStr}

FACT UPDATES (system should use NEW value):
${updateStr}

Generate exactly 25 questions per category:

1. **retention** (25): Questions about IMPORTANT facts that were mentioned multiple times with emotional weight. These SHOULD be remembered. Gold answer is the specific fact.
   Example: "What is Jordan's sister's profession?" → "Head nurse in Portland"

2. **forgetting** (25): Questions about things that were NEVER mentioned, or trivial noise that should NOT be stored. Gold answer is "I don't know" or equivalent. A good system ABSTAINS.
   Examples:
   - "What is Jordan's blood type?" (never mentioned)
   - "What did Jordan eat for lunch on day 12?" (trivial, should not be stored)
   - "What was the weather like when Jordan went hiking?" (noise)

3. **contradiction** (25): Questions where facts CHANGED. Gold answer is the NEW value.
   Example: "What design tool does Jordan use?" → "Framer" (not Figma)

4. **precision** (25): Questions requiring SPECIFIC details from important facts.
   Example: "How much was Jordan's salary increase?" → "From $88,000 to $95,000"
   Only ask about details within facts that SHOULD be extracted (important, repeated, specific).

Output JSON:
{
  "questions": [
    {
      "id": 1,
      "category": "retention",
      "question": "...",
      "gold_answer": "...",
      "old_answer": null,
      "why_testable": "Mentioned 3x with emotional weight"
    }
  ]
}`);

  console.log(`  Questions: ${evalData.questions?.length || 0}`);

  const dataset = {
    metadata: {
      name: "MQoT v2 — Memory Quality Over Time",
      version: "2.0",
      created: new Date().toISOString(),
      philosophy: "Tests intelligent memory: store precisely, forget correctly, find accurately",
      scoring: {
        retention: "Important facts that SHOULD be remembered (repeated, emotional, specific)",
        forgetting: "Noise/unknown that SHOULD be forgotten (abstaining = correct)",
        contradiction: "Updated facts that SHOULD use new value",
        precision: "Specific details within important contexts",
      },
    },
    conversations: convData.conversations || [],
    important_facts: convData.important_facts || [],
    fact_updates: convData.fact_updates || [],
    questions: evalData.questions || [],
  };

  const outFile = join(__dirname, "dataset_v2.json");
  writeFileSync(outFile, JSON.stringify(dataset, null, 2));
  console.log(`\nSaved to ${outFile}`);
  console.log(`  Conversations: ${dataset.conversations.length}`);
  console.log(`  Important facts: ${dataset.important_facts.length}`);
  console.log(`  Updates: ${dataset.fact_updates.length}`);
  console.log(`  Questions: ${dataset.questions.length}`);
}

main().catch(e => { console.error(e); process.exit(1); });

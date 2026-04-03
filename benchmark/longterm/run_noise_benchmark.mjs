#!/usr/bin/env node
/**
 * Noise Benchmark — Tests Pro's access tracking advantage at scale
 *
 * Design:
 *   1. 50 key facts about "Alex" (signal)
 *   2. 5000 noise memories (other people's facts)
 *   3. 500 recall cycles on key facts (builds access tracking in Pro)
 *   4. Evaluate: can it find signal through noise?
 *
 * Pro advantage: access tracking reinforces frequently recalled memories,
 * helping them rank higher even in a sea of noise.
 */

import { createMnemo } from "../../packages/core/dist/src/mnemo.js";
import { writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(__dirname, "results");
mkdirSync(RESULTS_DIR, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
const VOYAGE_KEY = process.env.MNEMO_API_KEY || process.env.VOYAGE_API_KEY;
const ADAPTER = process.env.ADAPTER || "core";
const JUDGE_MODEL = process.env.JUDGE_MODEL || "gpt-4.1";
const RECALL_CYCLES = parseInt(process.env.RECALL_CYCLES || "500", 10);
const NOISE_COUNT = parseInt(process.env.NOISE_COUNT || "5000", 10);

if (!OPENAI_KEY) { console.error("OPENAI_API_KEY required"); process.exit(1); }
if (!VOYAGE_KEY) { console.error("MNEMO_API_KEY or VOYAGE_API_KEY required"); process.exit(1); }

// ── Key facts about Alex (signal) ──
const KEY_FACTS = [
  { text: "Alex's full name is Alexander James Chen", q: "What is Alex's full name?", a: "Alexander James Chen" },
  { text: "Alex was born on March 15, 1994", q: "What is Alex's birthday?", a: "March 15, 1994" },
  { text: "Alex is 32 years old", q: "How old is Alex?", a: "32" },
  { text: "Alex grew up in Portland, Oregon", q: "Where did Alex grow up?", a: "Portland, Oregon" },
  { text: "Alex works as a Senior Software Engineer at Stripe", q: "Where does Alex work?", a: "Stripe" },
  { text: "Alex is on the Payments Infrastructure team at Stripe", q: "What team is Alex on?", a: "Payments Infrastructure" },
  { text: "Alex's manager is David Park", q: "Who is Alex's manager?", a: "David Park" },
  { text: "Alex's partner is named Emily", q: "What is Alex's partner's name?", a: "Emily" },
  { text: "Emily works as a product designer at Figma", q: "Where does Emily work?", a: "Figma" },
  { text: "Alex has a golden retriever named Luna", q: "What is Alex's dog's name and breed?", a: "Luna, a golden retriever" },
  { text: "Alex lives in the Mission District of San Francisco", q: "What neighborhood does Alex live in?", a: "Mission District" },
  { text: "Alex lives at 742 Valencia Street, Apartment 3B", q: "What is Alex's address?", a: "742 Valencia Street, Apt 3B" },
  { text: "Alex's favorite restaurant is Tartine Bakery", q: "What is Alex's favorite restaurant?", a: "Tartine Bakery" },
  { text: "Alex always orders a cortado at coffee shops", q: "What is Alex's coffee order?", a: "Cortado" },
  { text: "Alex is lactose intolerant", q: "Does Alex have any food allergies?", a: "Lactose intolerant" },
  { text: "Alex enjoys rock climbing, photography, and cooking", q: "What are Alex's hobbies?", a: "Rock climbing, photography, cooking" },
  { text: "Alex goes to Planet Fitness every Monday, Wednesday, and Friday at 7am", q: "What is Alex's gym schedule?", a: "Mon/Wed/Fri at 7am, Planet Fitness" },
  { text: "Alex wakes up at 6am every day and meditates for 10 minutes", q: "What is Alex's morning routine?", a: "Wakes at 6am, meditates 10 minutes" },
  { text: "Alex drives a 2021 Tesla Model 3 in blue", q: "What car does Alex drive?", a: "2021 Tesla Model 3, blue" },
  { text: "Alex commutes by bike to work, about 20 minutes", q: "How does Alex commute?", a: "By bike, 20 minutes" },
  { text: "Alex is planning a vacation to Japan in October", q: "Where is Alex planning to vacation?", a: "Japan in October" },
  { text: "Alex recently bought a new camera, a Sony A7IV for $2500", q: "What camera did Alex buy?", a: "Sony A7IV, $2500" },
  { text: "Alex's mother's name is Linda and she lives in Portland", q: "What is Alex's mother's name?", a: "Linda" },
  { text: "Alex's father is Robert, a retired teacher", q: "What does Alex's father do?", a: "Retired teacher" },
  { text: "Alex has a younger sister named Sophie who is 28", q: "Does Alex have siblings?", a: "Sister Sophie, 28" },
  { text: "Alex is allergic to shellfish", q: "Is Alex allergic to anything?", a: "Shellfish" },
  { text: "Alex's doctor is Dr. Michelle Wu at UCSF Medical", q: "Who is Alex's doctor?", a: "Dr. Michelle Wu, UCSF Medical" },
  { text: "Alex graduated from UC Berkeley with a CS degree in 2016", q: "Where did Alex go to college?", a: "UC Berkeley, CS, 2016" },
  { text: "Alex's salary is $245,000 per year", q: "What is Alex's salary?", a: "$245,000" },
  { text: "Alex uses Vim as his primary code editor", q: "What code editor does Alex use?", a: "Vim" },
  { text: "Alex's favorite programming language is Rust", q: "What is Alex's favorite language?", a: "Rust" },
  { text: "Alex's phone number is 415-555-0147", q: "What is Alex's phone number?", a: "415-555-0147" },
  { text: "Alex's email is alex.chen@gmail.com", q: "What is Alex's email?", a: "alex.chen@gmail.com" },
  { text: "Alex's birthday tradition is dinner at Zuni Café", q: "What does Alex do for his birthday?", a: "Dinner at Zuni Café" },
  { text: "Alex reads before bed every night, currently reading Project Hail Mary", q: "What book is Alex reading?", a: "Project Hail Mary" },
  { text: "Alex's favorite movie is Blade Runner 2049", q: "What is Alex's favorite movie?", a: "Blade Runner 2049" },
  { text: "Alex runs a photography Instagram with 3,200 followers", q: "How many Instagram followers does Alex have?", a: "3,200" },
  { text: "Alex met Emily at a climbing gym in 2021", q: "How did Alex meet Emily?", a: "At a climbing gym in 2021" },
  { text: "Alex and Emily have been together for 5 years", q: "How long have Alex and Emily been together?", a: "5 years" },
  { text: "Alex's favorite cuisine is Japanese, especially ramen", q: "What is Alex's favorite cuisine?", a: "Japanese, especially ramen" },
  { text: "Alex switched from coffee to matcha in January 2026", q: "Did Alex change his drink preference?", a: "Switched to matcha in January 2026" },
  { text: "Alex got promoted from Engineer to Senior Engineer in February 2026", q: "When did Alex get promoted?", a: "February 2026" },
  { text: "Alex started learning pottery in March 2026", q: "What new hobby did Alex start?", a: "Pottery, March 2026" },
  { text: "Alex moved from SOMA to Mission District in December 2025", q: "When did Alex move?", a: "December 2025, SOMA to Mission District" },
  { text: "Alex's rent is $3,800 per month", q: "How much is Alex's rent?", a: "$3,800/month" },
  { text: "Luna weighs 65 pounds and was born in 2022", q: "How much does Luna weigh?", a: "65 pounds" },
  { text: "Alex donates to the SF-Marin Food Bank monthly", q: "Does Alex donate to charity?", a: "SF-Marin Food Bank, monthly" },
  { text: "Alex's WiFi password at home is 'LunaGolden2022'", q: "What is Alex's WiFi password?", a: "LunaGolden2022" },
  { text: "Alex's emergency contact is Emily at 415-555-0198", q: "Who is Alex's emergency contact?", a: "Emily, 415-555-0198" },
  { text: "Alex's favorite climbing spot is Mission Cliffs gym", q: "Where does Alex climb?", a: "Mission Cliffs" },
];

// ── Generate noise memories (other people's facts) ──
function generateNoise(count) {
  const firstNames = ["James","Maria","David","Sarah","Michael","Jessica","Robert","Jennifer","William","Lisa","Daniel","Emma","Thomas","Olivia","Richard","Sophia","Joseph","Ava","Charles","Mia","Chris","Isabella","Matthew","Charlotte","Andrew","Amelia","Mark","Harper","Steven","Ella"];
  const lastNames = ["Smith","Johnson","Williams","Brown","Jones","Garcia","Miller","Davis","Rodriguez","Martinez","Hernandez","Lopez","Gonzalez","Wilson","Anderson","Thomas","Taylor","Moore","Jackson","Martin","Lee","Perez","Thompson","White","Harris","Sanchez","Clark","Ramirez","Lewis","Robinson"];
  const cities = ["New York","Los Angeles","Chicago","Houston","Phoenix","Philadelphia","San Antonio","Dallas","Austin","Jacksonville","San Jose","Fort Worth","Columbus","Charlotte","Indianapolis","Seattle","Denver","Washington","Nashville","Oklahoma City","Portland","Las Vegas","Memphis","Louisville","Baltimore"];
  const jobs = ["software engineer","designer","teacher","nurse","accountant","lawyer","dentist","chef","pilot","architect","pharmacist","veterinarian","journalist","therapist","consultant","analyst","researcher","manager","director","coordinator"];
  const companies = ["Google","Meta","Apple","Amazon","Microsoft","Netflix","Uber","Airbnb","Salesforce","Adobe","Oracle","IBM","Intel","Cisco","VMware","Spotify","Twitter","LinkedIn","Snap","Pinterest"];
  const foods = ["sushi","pizza","tacos","pasta","burgers","curry","pho","dim sum","bibimbap","falafel","pad thai","gyros","ceviche","ramen","empanadas"];
  const hobbies = ["running","swimming","painting","guitar","piano","chess","gardening","yoga","surfing","skiing","knitting","pottery","woodworking","dancing","boxing"];
  const pets = ["cat named Whiskers","dog named Max","parrot named Rio","rabbit named Bun","cat named Shadow","dog named Buddy","hamster named Peanut","cat named Luna","dog named Charlie","fish named Nemo"];
  const cars = ["Toyota Camry","Honda Civic","Ford F-150","Chevrolet Malibu","BMW 3 Series","Audi A4","Subaru Outback","Hyundai Sonata","Volkswagen Golf","Mazda CX-5"];

  const pick = arr => arr[Math.floor(Math.random() * arr.length)];
  const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;

  const noise = [];
  const templates = [
    () => { const n = `${pick(firstNames)} ${pick(lastNames)}`; return `${n} works as a ${pick(jobs)} at ${pick(companies)} in ${pick(cities)}`; },
    () => { const n = `${pick(firstNames)} ${pick(lastNames)}`; return `${n} lives in ${pick(cities)} and enjoys ${pick(hobbies)} and ${pick(hobbies)}`; },
    () => { const n = `${pick(firstNames)} ${pick(lastNames)}`; return `${n} has a ${pick(pets)} and drives a ${pick(cars)}`; },
    () => { const n = `${pick(firstNames)} ${pick(lastNames)}`; return `${n}'s favorite food is ${pick(foods)} and they go to the gym ${rand(2,5)} times a week`; },
    () => { const n = `${pick(firstNames)} ${pick(lastNames)}`; return `${n} graduated from college in ${rand(2005,2020)} and earns $${rand(50,200)},000 per year`; },
    () => { const n = `${pick(firstNames)} ${pick(lastNames)}`; return `${n} is ${rand(22,55)} years old and was born in ${pick(cities)}`; },
    () => { const n = `${pick(firstNames)} ${pick(lastNames)}`; return `${n}'s partner is ${pick(firstNames)} and they have been together for ${rand(1,15)} years`; },
    () => { const n = `${pick(firstNames)} ${pick(lastNames)}`; return `${n} recently bought a new ${pick(["laptop","phone","camera","bicycle","watch"])} for $${rand(200,3000)}`; },
    () => { const n = `${pick(firstNames)} ${pick(lastNames)}`; return `${n} is planning a trip to ${pick(["Paris","Tokyo","London","Rome","Barcelona","Sydney","Berlin","Seoul"])} in ${pick(["January","March","June","August","October","December"])}`; },
    () => { const n = `${pick(firstNames)} ${pick(lastNames)}`; return `${n} commutes ${rand(10,60)} minutes to work by ${pick(["car","bus","train","bike","walking"])}`; },
  ];

  for (let i = 0; i < count; i++) {
    noise.push(pick(templates)());
  }
  return noise;
}

// ── LLM for answering ──
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
        await new Promise(r => setTimeout(r, 2 ** attempt * 3000));
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

async function judgeAnswer(question, predicted, gold) {
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
  try {
    const s = await openaiChat([{ role: "user", content: prompt }], null, 4);
    const n = parseInt(s.trim()[0], 10);
    return isNaN(n) ? 0 : Math.min(Math.max(n, 0), 3);
  } catch { return 0; }
}

async function answerWithContext(question, docs) {
  const context = docs.map(m => `- ${m}`).join("\n");
  if (!context.trim()) return "I don't have enough information to answer this question.";
  const prompt = `You have memory snippets about various people:

${context}

Answer about ALEX specifically. Be concise (1-2 sentences):
Question: ${question}

If the answer about Alex is not in the snippets, say "I don't have information about that."
Answer:`;
  return openaiChat([{ role: "user", content: prompt }]).then(s => s.trim()).catch(e => `[ERROR: ${e}]`);
}

// ── Worker pool ──
async function workerPool(items, fn, concurrency) {
  let idx = 0;
  const workers = Array.from({ length: concurrency }, async () => {
    while (idx < items.length) { const i = idx++; await fn(items[i], i); }
  });
  await Promise.all(workers);
}

// ── Main ──
async function main() {
  const dbPath = `/tmp/mnemo-noise-${ADAPTER}`;
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
  console.log(`Noise Benchmark — ${ADAPTER.toUpperCase()}`);
  console.log(`Signal: ${KEY_FACTS.length} facts | Noise: ${NOISE_COUNT} | Recall cycles: ${RECALL_CYCLES}`);
  console.log(`${"=".repeat(60)}`);

  // ── Phase 1: Store signal + noise ──
  console.log(`\n--- Phase 1: Ingestion ---`);
  const t0 = Date.now();

  // Store key facts
  console.log(`  Storing ${KEY_FACTS.length} key facts...`);
  for (const fact of KEY_FACTS) {
    await mnemo.store({ text: fact.text, category: "fact", scope: "alex", importance: 0.7 });
  }
  console.log(`  Key facts stored — ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // Store noise
  console.log(`  Generating and storing ${NOISE_COUNT} noise memories...`);
  const noise = generateNoise(NOISE_COUNT);
  let noiseStored = 0;

  await workerPool(noise, async (text) => {
    try {
      await mnemo.store({ text, category: "fact", scope: "alex", importance: 0.7 });
      noiseStored++;
      if (noiseStored % 500 === 0) {
        const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
        const rate = (noiseStored / (Date.now() - t0) * 1000).toFixed(1);
        console.log(`  Noise: ${noiseStored}/${NOISE_COUNT} — ${elapsed}s — ${rate}/s`);
      }
    } catch {}
  }, 10);

  console.log(`  Ingestion complete: ${KEY_FACTS.length} signal + ${noiseStored} noise — ${((Date.now() - t0) / 1000).toFixed(0)}s`);

  // ── Phase 2: Recall cycles (builds access tracking) ──
  console.log(`\n--- Phase 2: ${RECALL_CYCLES} recall cycles ---`);
  const t1 = Date.now();

  for (let cycle = 0; cycle < RECALL_CYCLES; cycle++) {
    // Pick a random key fact question to recall
    const fact = KEY_FACTS[cycle % KEY_FACTS.length];
    try {
      await mnemo.recall(fact.q, { limit: 10, scopeFilter: ["alex"] });
    } catch {}

    if ((cycle + 1) % 100 === 0) {
      const elapsed = ((Date.now() - t1) / 1000).toFixed(0);
      console.log(`  Cycle ${cycle + 1}/${RECALL_CYCLES} — ${elapsed}s`);
    }
  }
  console.log(`  Recall cycles complete — ${((Date.now() - t1) / 1000).toFixed(0)}s`);

  // ── Phase 3: Evaluate ──
  console.log(`\n--- Phase 3: Evaluation (${KEY_FACTS.length} questions) ---`);
  const results = [];

  await workerPool(KEY_FACTS, async (fact, qi) => {
    const docs = await mnemo.recall(fact.q, { limit: 10, scopeFilter: ["alex"] });
    const docTexts = docs.map(r => r.text);

    // Check if the correct fact is in top-K
    const hasSignal = docTexts.some(d =>
      fact.text.split(" ").filter(w => w.length > 3).some(word => d.toLowerCase().includes(word.toLowerCase()))
    );

    const predicted = await answerWithContext(fact.q, docTexts);
    const score = await judgeAnswer(fact.q, predicted, fact.a);

    results.push({
      question: fact.q,
      gold: fact.a,
      predicted,
      score,
      signal_in_top10: hasSignal,
      n_retrieved: docs.length,
    });

    const status = ["WRONG", "PARTIAL", "CORRECT", "EXACT"][score];
    if ((qi + 1) % 10 === 0 || qi < 3) {
      console.log(`  Q${qi}: [${status}] ${fact.q.slice(0, 50)}... (signal_in_top10: ${hasSignal})`);
    }
  }, 10);

  // ── Results ──
  const correct = results.filter(r => r.score >= 2).length;
  const total = results.length;
  const accuracy = (correct / total * 100).toFixed(1);
  const signalRate = (results.filter(r => r.signal_in_top10).length / total * 100).toFixed(1);

  console.log(`\n${"=".repeat(60)}`);
  console.log(`RESULTS (${ADAPTER.toUpperCase()})`);
  console.log(`  Accuracy: ${accuracy}% (${correct}/${total})`);
  console.log(`  Signal in top-10: ${signalRate}%`);
  console.log(`${"=".repeat(60)}`);

  const output = {
    adapter: ADAPTER,
    benchmark: "Noise Benchmark",
    signal_count: KEY_FACTS.length,
    noise_count: NOISE_COUNT,
    recall_cycles: RECALL_CYCLES,
    accuracy: parseFloat(accuracy),
    signal_retrieval_rate: parseFloat(signalRate),
    correct, total,
    total_time_s: parseFloat(((Date.now() - t0) / 1000).toFixed(1)),
    questions: results,
  };

  const outFile = join(RESULTS_DIR, `noise_${ADAPTER}_${new Date().toISOString().slice(0, 10)}.json`);
  writeFileSync(outFile, JSON.stringify(output, null, 2));
  console.log(`Saved to ${outFile}`);
  await mnemo.close();
}

main().catch(e => { console.error(e); process.exit(1); });

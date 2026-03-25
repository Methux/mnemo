#!/usr/bin/env node
/**
 * mnemo-reembed — Embedding Model Migration Tool
 *
 * When you change embedding models (e.g. voyage-4 → text-embedding-3-large),
 * all existing vectors become incompatible. This tool re-embeds every memory
 * with the new model, preserving all metadata.
 *
 * Usage:
 *   node packages/tools/mnemo-reembed.js --config ~/.mnemo/mnemo.json
 *   node packages/tools/mnemo-reembed.js --config ~/.mnemo/mnemo.json --dry-run
 *   node packages/tools/mnemo-reembed.js --config ~/.mnemo/mnemo.json --batch-size 50
 *
 * What it does:
 *   1. Reads ALL memories from the current database
 *   2. Backs up the entire database (copies db directory)
 *   3. Re-embeds each memory's text using the NEW model from config
 *   4. Overwrites vectors in-place (same IDs, same metadata)
 *   5. Verifies by running a sample search
 *
 * Safety:
 *   - Creates a full backup before any changes
 *   - --dry-run shows what would happen without changing anything
 *   - Supports --resume if interrupted mid-migration
 *   - Validates dimension match before writing
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

// ── ANSI colors ──
const C = {
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", dim: "\x1b[2m", bold: "\x1b[1m", reset: "\x1b[0m",
};

// ── Parse args ──
const args = process.argv.slice(2);
function getArg(name) {
  const idx = args.indexOf(`--${name}`);
  return idx >= 0 && idx + 1 < args.length ? args[idx + 1] : null;
}
const hasFlag = (name) => args.includes(`--${name}`);

const configPath = getArg("config") || path.join(os.homedir(), ".mnemo", "mnemo.json");
const dryRun = hasFlag("dry-run");
const batchSize = parseInt(getArg("batch-size") || "20", 10);
const resumeFrom = getArg("resume") || null;

console.log(`
${C.cyan}${C.bold}╔══════════════════════════════════════════╗
║   Mnemo — Embedding Migration Tool       ║
╚══════════════════════════════════════════╝${C.reset}
`);

// ── Load config ──
let config;
try {
  const raw = fs.readFileSync(configPath, "utf8");
  // Expand env vars
  const expanded = raw.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || "");
  config = JSON.parse(expanded);
} catch (err) {
  console.error(`${C.red}Cannot read config: ${configPath}${C.reset}`);
  console.error(`  ${err.message}`);
  process.exit(1);
}

const embeddingConfig = config.embedding;
if (!embeddingConfig) {
  console.error(`${C.red}No embedding config found in ${configPath}${C.reset}`);
  process.exit(1);
}

const dbPath = config.dbPath?.replace("~", os.homedir()) ||
  path.join(os.homedir(), ".mnemo", "memory-db");

console.log(`${C.dim}Config:    ${configPath}${C.reset}`);
console.log(`${C.dim}Database:  ${dbPath}${C.reset}`);
console.log(`${C.dim}Model:     ${embeddingConfig.model}${C.reset}`);
console.log(`${C.dim}Dimension: ${embeddingConfig.dimensions || "auto"}${C.reset}`);
console.log(`${C.dim}Batch:     ${batchSize}${C.reset}`);
console.log(`${C.dim}Dry run:   ${dryRun}${C.reset}`);
console.log("");

async function main() {
  // ── Step 1: Connect to LanceDB ──
  console.log(`${C.cyan}[1/6]${C.reset} Connecting to database...`);

  let lancedb;
  try {
    lancedb = await import("@lancedb/lancedb");
  } catch {
    // Try alternative path
    const lancedbPath = path.join(dbPath, "..", "node_modules", "@lancedb", "lancedb");
    try {
      lancedb = await import(lancedbPath);
    } catch {
      console.error(`${C.red}Cannot load @lancedb/lancedb. Install it: npm install @lancedb/lancedb${C.reset}`);
      process.exit(1);
    }
  }

  const db = await lancedb.connect(dbPath);
  let table;
  try {
    table = await db.openTable("memories");
  } catch {
    console.error(`${C.red}Table "memories" not found in ${dbPath}${C.reset}`);
    process.exit(1);
  }

  // ── Step 2: Read all memories ──
  console.log(`${C.cyan}[2/6]${C.reset} Reading all memories...`);
  const allRows = await table.query().toArray();
  const total = allRows.length;
  console.log(`  Found ${C.bold}${total}${C.reset} memories`);

  if (total === 0) {
    console.log(`${C.yellow}No memories to migrate.${C.reset}`);
    process.exit(0);
  }

  // Check current dimensions
  const currentDim = allRows[0]?.vector?.length || 0;
  const targetDim = embeddingConfig.dimensions || currentDim;
  console.log(`  Current dimensions: ${currentDim}`);
  console.log(`  Target dimensions:  ${targetDim}`);

  if (currentDim === targetDim) {
    console.log(`${C.yellow}  ⚠ Same dimensions — this will re-embed with the new model but keep the same vector size.${C.reset}`);
  } else {
    console.log(`${C.yellow}  ⚠ Dimension change: ${currentDim} → ${targetDim}. This requires recreating the table.${C.reset}`);
  }

  if (dryRun) {
    console.log(`\n${C.yellow}[DRY RUN] Would re-embed ${total} memories. No changes made.${C.reset}`);

    // Show sample
    console.log(`\n${C.dim}Sample memories:${C.reset}`);
    for (const row of allRows.slice(0, 5)) {
      console.log(`  ${row.id}: ${(row.text || "").slice(0, 80)}...`);
    }
    process.exit(0);
  }

  // ── Step 3: Backup ──
  console.log(`${C.cyan}[3/6]${C.reset} Creating backup...`);
  const backupPath = `${dbPath}-backup-${new Date().toISOString().slice(0, 19).replace(/:/g, "")}`;
  try {
    copyDirSync(dbPath, backupPath);
    console.log(`  Backup saved to: ${C.green}${backupPath}${C.reset}`);
  } catch (err) {
    console.error(`${C.red}Backup failed: ${err.message}${C.reset}`);
    console.error("Aborting migration for safety.");
    process.exit(1);
  }

  // ── Step 4: Setup embedding client ──
  console.log(`${C.cyan}[4/6]${C.reset} Initializing embedding client...`);

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({
    apiKey: embeddingConfig.apiKey,
    baseURL: embeddingConfig.baseURL,
  });

  // Test embedding
  try {
    const testResult = await client.embeddings.create({
      model: embeddingConfig.model,
      input: "test embedding",
      ...(embeddingConfig.dimensions ? { dimensions: embeddingConfig.dimensions } : {}),
    });
    const testDim = testResult.data[0].embedding.length;
    console.log(`  Embedding test passed (dim=${testDim})`);
    if (testDim !== targetDim && targetDim !== currentDim) {
      console.error(`${C.red}Dimension mismatch: model outputs ${testDim} but config says ${targetDim}${C.reset}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`${C.red}Embedding test failed: ${err.message}${C.reset}`);
    process.exit(1);
  }

  // ── Step 5: Re-embed in batches ──
  console.log(`${C.cyan}[5/6]${C.reset} Re-embedding ${total} memories in batches of ${batchSize}...`);

  let processed = 0;
  let failed = 0;
  let skipped = 0;
  const startTime = Date.now();

  // Find resume point
  let startIdx = 0;
  if (resumeFrom) {
    startIdx = allRows.findIndex((r) => r.id === resumeFrom);
    if (startIdx < 0) {
      console.error(`${C.red}Resume ID "${resumeFrom}" not found${C.reset}`);
      process.exit(1);
    }
    console.log(`  Resuming from index ${startIdx} (id: ${resumeFrom})`);
    skipped = startIdx;
  }

  for (let i = startIdx; i < total; i += batchSize) {
    const batch = allRows.slice(i, i + batchSize);
    const texts = batch.map((r) => r.text || "");

    try {
      // Embed batch
      const result = await client.embeddings.create({
        model: embeddingConfig.model,
        input: texts,
        ...(embeddingConfig.dimensions ? { dimensions: embeddingConfig.dimensions } : {}),
        ...(embeddingConfig.taskPassage ? { input_type: embeddingConfig.taskPassage } : {}),
      });

      // Update vectors
      for (let j = 0; j < batch.length; j++) {
        const row = batch[j];
        const newVector = result.data[j].embedding;
        row.vector = newVector;

        // Delete old + insert updated
        await table.delete(`id = '${row.id}'`);
        await table.add([row]);
      }

      processed += batch.length;
    } catch (err) {
      console.error(`  ${C.red}Batch ${i}-${i + batch.length} failed: ${err.message}${C.reset}`);
      console.error(`  ${C.yellow}Resume with: --resume ${batch[0].id}${C.reset}`);
      failed += batch.length;
    }

    // Progress
    const pct = Math.round(((i + batch.length) / total) * 100);
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const rate = (processed / (Date.now() - startTime) * 1000).toFixed(1);
    process.stdout.write(
      `\r  ${C.cyan}${pct}%${C.reset} (${processed}/${total}) ${C.dim}${elapsed}s, ${rate} mem/s${C.reset}   `
    );
  }

  console.log(`\n  Done: ${C.green}${processed} re-embedded${C.reset}, ${failed > 0 ? C.red + failed + " failed" + C.reset : "0 failed"}, ${skipped} skipped`);

  // ── Step 6: Verify ──
  console.log(`${C.cyan}[6/6]${C.reset} Verifying...`);

  const verifyRows = await table.query().limit(1).toArray();
  if (verifyRows.length > 0) {
    const dim = verifyRows[0].vector?.length || 0;
    console.log(`  Vector dimensions: ${dim}`);
    if (dim === targetDim || dim === (embeddingConfig.dimensions || currentDim)) {
      console.log(`  ${C.green}✓ Dimensions match${C.reset}`);
    } else {
      console.log(`  ${C.red}✗ Dimension mismatch!${C.reset}`);
    }
  }

  // Test search
  try {
    const testEmbed = await client.embeddings.create({
      model: embeddingConfig.model,
      input: verifyRows[0]?.text || "test",
      ...(embeddingConfig.dimensions ? { dimensions: embeddingConfig.dimensions } : {}),
    });
    const searchResults = await table
      .vectorSearch(testEmbed.data[0].embedding)
      .distanceType("cosine")
      .limit(3)
      .toArray();
    console.log(`  ${C.green}✓ Vector search working (${searchResults.length} results)${C.reset}`);
  } catch (err) {
    console.log(`  ${C.yellow}⚠ Search test failed: ${err.message}${C.reset}`);
  }

  const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`
${C.green}${C.bold}Migration complete!${C.reset}
  Processed: ${processed} memories
  Time:      ${totalTime}s
  Backup:    ${backupPath}

${C.dim}To rollback: rm -rf "${dbPath}" && mv "${backupPath}" "${dbPath}"${C.reset}
`);
}

// ── Utility: recursive dir copy ──
function copyDirSync(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

main().catch((err) => {
  console.error(`${C.red}Fatal: ${err.message}${C.reset}`);
  process.exit(1);
});

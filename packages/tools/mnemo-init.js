#!/usr/bin/env node
/**
 * mnemo-init.js — Interactive CLI wizard for Mnemo configuration
 * Usage: node packages/tools/mnemo-init.js
 */

const readline = require("node:readline");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

// ─── ANSI Colors ───────────────────────────────────────────────────────────────

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  italic: "\x1b[3m",
  underline: "\x1b[4m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
  bgBlue: "\x1b[44m",
  bgMagenta: "\x1b[45m",
};

// ─── Helpers ───────────────────────────────────────────────────────────────────

function banner() {
  console.log("");
  console.log(
    `  ${C.bgMagenta}${C.white}${C.bold}                                            ${C.reset}`
  );
  console.log(
    `  ${C.bgMagenta}${C.white}${C.bold}   Mnemo v1.1.0 — Memory Framework Setup    ${C.reset}`
  );
  console.log(
    `  ${C.bgMagenta}${C.white}${C.bold}                                            ${C.reset}`
  );
  console.log("");
  console.log(
    `  ${C.dim}Cognitive science-based AI memory framework${C.reset}`
  );
  console.log(
    `  ${C.dim}${"─".repeat(46)}${C.reset}`
  );
  console.log("");
}

function heading(text) {
  console.log(`\n${C.bold}${C.cyan}${text}${C.reset}`);
  console.log(`${C.dim}${"─".repeat(50)}${C.reset}`);
}

function success(text) {
  console.log(`  ${C.green}[OK]${C.reset} ${text}`);
}

function warn(text) {
  console.log(`  ${C.yellow}[!]${C.reset}  ${text}`);
}

function info(text) {
  console.log(`  ${C.blue}[i]${C.reset}  ${text}`);
}

function errorMsg(text) {
  console.log(`  ${C.red}[x]${C.reset}  ${text}`);
}

function label(key, value) {
  console.log(
    `  ${C.cyan}${key.padEnd(26)}${C.reset} ${C.white}${value}${C.reset}`
  );
}

function expandHome(p) {
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function maskKey(key) {
  if (!key) return "(not set)";
  if (key.length <= 8) return "****";
  return key.slice(0, 4) + "****" + key.slice(-4);
}

// ─── Validation ────────────────────────────────────────────────────────────────

function validateVoyageKey(key) {
  if (!key) return "Voyage API key is required.";
  if (!key.startsWith("pa-"))
    return `${C.yellow}Voyage keys typically start with "pa-". Are you sure this is correct?${C.reset}`;
  return null;
}

function validateOpenAIKey(key) {
  if (!key) return null; // optional
  if (!key.startsWith("sk-"))
    return `${C.yellow}OpenAI keys typically start with "sk-". Are you sure this is correct?${C.reset}`;
  return null;
}

function validateAnthropicKey(key) {
  if (!key) return null;
  if (!key.startsWith("sk-ant-"))
    return `${C.yellow}Anthropic keys typically start with "sk-ant-". Are you sure this is correct?${C.reset}`;
  return null;
}

// ─── Readline wrapper ──────────────────────────────────────────────────────────

function createPrompt() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  function ask(question, defaultVal) {
    return new Promise((resolve) => {
      const suffix = defaultVal != null ? ` ${C.dim}(${defaultVal})${C.reset}` : "";
      rl.question(`  ${C.magenta}?${C.reset} ${question}${suffix} `, (answer) => {
        resolve(answer.trim() || (defaultVal != null ? String(defaultVal) : ""));
      });
    });
  }

  function askYesNo(question, defaultVal) {
    const hint = defaultVal ? "Y/n" : "y/N";
    return new Promise((resolve) => {
      rl.question(
        `  ${C.magenta}?${C.reset} ${question} ${C.dim}(${hint})${C.reset} `,
        (answer) => {
          const a = answer.trim().toLowerCase();
          if (a === "") resolve(defaultVal);
          else resolve(a === "y" || a === "yes");
        }
      );
    });
  }

  function askChoice(question, choices, defaultIdx) {
    return new Promise((resolve) => {
      console.log(`  ${C.magenta}?${C.reset} ${question}`);
      choices.forEach((c, i) => {
        const marker = i === defaultIdx ? `${C.green}>${C.reset}` : " ";
        const highlight = i === defaultIdx ? C.green : C.white;
        console.log(`    ${marker} ${highlight}${i + 1}) ${c}${C.reset}`);
      });
      rl.question(`  ${C.dim}  Choose [1-${choices.length}] (${defaultIdx + 1}):${C.reset} `, (answer) => {
        const idx = parseInt(answer.trim(), 10) - 1;
        if (idx >= 0 && idx < choices.length) resolve(idx);
        else resolve(defaultIdx);
      });
    });
  }

  function close() {
    rl.close();
  }

  return { ask, askYesNo, askChoice, close };
}

// ─── Config Builder ────────────────────────────────────────────────────────────

function buildConfig(answers) {
  const config = {
    embedding: {
      provider: "openai-compatible",
      apiKey: "${VOYAGE_API_KEY}",
      baseURL: "https://api.voyageai.com/v1",
      model: "voyage-3-large",
      dimensions: 1024,
      taskQuery: "retrieval.query",
      taskPassage: "retrieval.passage",
    },
    dbPath: answers.dbPath,
    autoCapture: true,
    smartExtraction: !!answers.openaiKey,
    autoRecall: true,
    autoRecallMinLength: 8,
    autoRecallMinRepeated: 3,
    captureAssistant: true,
    enableManagementTools: true,
  };

  // LLM config — only if openai key is provided
  if (answers.openaiKey) {
    const modelMap = {
      "gpt-4.1": { model: "gpt-4.1", baseURL: "https://api.openai.com/v1", keyVar: "${OPENAI_API_KEY}" },
      "gpt-4.1-mini": { model: "gpt-4.1-mini", baseURL: "https://api.openai.com/v1", keyVar: "${OPENAI_API_KEY}" },
      "claude-sonnet-4-6": { model: "claude-sonnet-4-6", baseURL: "https://api.anthropic.com/v1", keyVar: "${ANTHROPIC_API_KEY}" },
    };
    const m = modelMap[answers.llmModel] || modelMap["gpt-4.1-mini"];
    config.llm = {
      model: m.model,
      baseURL: m.baseURL,
      apiKey: m.keyVar,
    };
  }

  // Retrieval
  config.retrieval = {
    candidatePoolSize: 40,
    rerank: answers.rerankModel !== "none" ? "cross-encoder" : "none",
  };
  if (answers.rerankModel !== "none") {
    config.retrieval.rerankProvider = "voyage";
    config.retrieval.rerankApiKey = "${VOYAGE_API_KEY}";
    config.retrieval.rerankModel = answers.rerankModel || "rerank-2";
    config.retrieval.rerankEndpoint = "https://api.voyageai.com/v1/rerank";
  }

  // Decay
  config.decay = {
    recencyHalfLifeDays: answers.decayHalfLife || 30,
    recencyWeight: answers.decayRecencyWeight || 0.4,
    frequencyWeight: answers.decayFrequencyWeight || 0.3,
    intrinsicWeight: answers.decayIntrinsicWeight || 0.3,
  };

  // Tier
  config.tier = {
    coreAccessThreshold: answers.tierCoreAccess || 10,
    coreImportanceThreshold: answers.tierCoreImportance || 0.8,
    peripheralAgeDays: answers.tierPeripheralAge || 60,
  };

  // MD Mirror
  if (answers.mdMirrorEnabled) {
    config.mdMirror = {
      enabled: true,
      dir: answers.mdMirrorDir || "~/.mnemo/mirror",
    };
  } else {
    config.mdMirror = { enabled: false };
  }

  // Session strategy
  config.sessionStrategy = answers.sessionStrategy || "memoryReflection";
  if (config.sessionStrategy === "memoryReflection") {
    config.memoryReflection = {
      storeToLanceDB: true,
      injectMode: "inheritance+derived",
      messageCount: 120,
      thinkLevel: "medium",
    };
  }

  // Graphiti
  if (answers.graphiti) {
    config.graphiti = {
      enabled: true,
      endpoint: "http://localhost:18799",
    };
  }

  // Self-improvement
  if (answers.selfImprovement) {
    config.selfImprovement = {
      enabled: true,
      beforeResetNote: true,
    };
  }

  return config;
}

function buildEnv(answers) {
  const lines = [];
  lines.push("# Mnemo environment variables");
  lines.push(`# Generated by mnemo-init on ${new Date().toISOString()}`);
  lines.push("");
  lines.push(`VOYAGE_API_KEY=${answers.voyageKey}`);
  if (answers.openaiKey) {
    lines.push(`OPENAI_API_KEY=${answers.openaiKey}`);
  }
  if (answers.anthropicKey) {
    lines.push(`ANTHROPIC_API_KEY=${answers.anthropicKey}`);
  }
  lines.push("");
  return lines.join("\n");
}

// ─── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  banner();

  const prompt = createPrompt();

  // ── Mode selection ──
  heading("Setup Mode");
  const modeIdx = await prompt.askChoice(
    "Choose setup mode:",
    [
      "Basic  — 5 quick questions, sensible defaults",
      "Advanced — full control over every option",
    ],
    0
  );
  const advanced = modeIdx === 1;

  const answers = {
    dbPath: "~/.mnemo/memory-db",
    voyageKey: "",
    openaiKey: "",
    anthropicKey: "",
    llmModel: "gpt-4.1-mini",
    rerankModel: "rerank-2",
    decayHalfLife: 30,
    decayRecencyWeight: 0.4,
    decayFrequencyWeight: 0.3,
    decayIntrinsicWeight: 0.3,
    tierCoreAccess: 10,
    tierCoreImportance: 0.8,
    tierPeripheralAge: 60,
    sessionStrategy: "memoryReflection",
    mdMirrorEnabled: false,
    mdMirrorDir: "~/.mnemo/mirror",
    selfImprovement: false,
    graphiti: false,
    savePath: "./mnemo.json",
  };

  // ── Basic questions ──
  heading("Core Configuration");

  // Q1: DB path
  answers.dbPath = await prompt.ask("Where to store memory data?", "~/.mnemo/memory-db");

  // Q2: Voyage key
  let voyageValid = false;
  while (!voyageValid) {
    answers.voyageKey = await prompt.ask("Voyage API key for embeddings:", "");
    const err = validateVoyageKey(answers.voyageKey);
    if (err && !answers.voyageKey) {
      errorMsg(err);
    } else if (err) {
      warn(err);
      const proceed = await prompt.askYesNo("Continue anyway?", false);
      if (proceed) voyageValid = true;
    } else {
      voyageValid = true;
    }
  }

  // Q3: OpenAI key
  answers.openaiKey = await prompt.ask(
    `OpenAI API key for smart extraction ${C.dim}(optional, Enter to skip)${C.reset}:`,
    ""
  );
  if (answers.openaiKey) {
    const err = validateOpenAIKey(answers.openaiKey);
    if (err) {
      warn(err);
      const proceed = await prompt.askYesNo("Continue anyway?", true);
      if (!proceed) answers.openaiKey = "";
    }
  }
  if (!answers.openaiKey) {
    info("Smart extraction disabled (no OpenAI key).");
  }

  // Q4: Graphiti
  answers.graphiti = await prompt.askYesNo("Enable Graphiti knowledge graph?", false);

  // Q5: Save path
  answers.savePath = await prompt.ask("Save config to:", "./mnemo.json");

  // ── Advanced questions ──
  if (advanced) {
    heading("Advanced: API Keys");

    answers.anthropicKey = await prompt.ask(
      `Anthropic API key for hook extractor ${C.dim}(optional)${C.reset}:`,
      ""
    );
    if (answers.anthropicKey) {
      const err = validateAnthropicKey(answers.anthropicKey);
      if (err) {
        warn(err);
      }
    }

    heading("Advanced: LLM Model");

    const llmChoices = ["gpt-4.1", "gpt-4.1-mini", "claude-sonnet-4-6"];
    const llmIdx = await prompt.askChoice("LLM model for extraction:", llmChoices, 1);
    answers.llmModel = llmChoices[llmIdx];

    if (answers.llmModel === "claude-sonnet-4-6" && !answers.anthropicKey) {
      warn("claude-sonnet-4-6 selected but no Anthropic key provided.");
      info("Make sure to set ANTHROPIC_API_KEY in your .env file.");
    }

    heading("Advanced: Retrieval");

    const rerankChoices = ["rerank-2 (Voyage)", "none"];
    const rerankIdx = await prompt.askChoice("Rerank model:", rerankChoices, 0);
    answers.rerankModel = rerankIdx === 0 ? "rerank-2" : "none";

    heading("Advanced: Decay Configuration");

    const halfLifeStr = await prompt.ask("Recency half-life (days):", "30");
    answers.decayHalfLife = parseInt(halfLifeStr, 10) || 30;

    const recencyW = await prompt.ask("Recency weight:", "0.4");
    answers.decayRecencyWeight = parseFloat(recencyW) || 0.4;

    const freqW = await prompt.ask("Frequency weight:", "0.3");
    answers.decayFrequencyWeight = parseFloat(freqW) || 0.3;

    const intrW = await prompt.ask("Intrinsic weight:", "0.3");
    answers.decayIntrinsicWeight = parseFloat(intrW) || 0.3;

    // Validate weights sum
    const wSum = answers.decayRecencyWeight + answers.decayFrequencyWeight + answers.decayIntrinsicWeight;
    if (Math.abs(wSum - 1.0) > 0.01) {
      warn(`Decay weights sum to ${wSum.toFixed(2)} (expected 1.0). Adjusting is recommended.`);
    }

    heading("Advanced: Tier Thresholds");

    const coreAccess = await prompt.ask("Core access threshold:", "10");
    answers.tierCoreAccess = parseInt(coreAccess, 10) || 10;

    const coreImp = await prompt.ask("Core importance threshold:", "0.8");
    answers.tierCoreImportance = parseFloat(coreImp) || 0.8;

    const perAge = await prompt.ask("Peripheral age (days):", "60");
    answers.tierPeripheralAge = parseInt(perAge, 10) || 60;

    heading("Advanced: Session Strategy");

    const stratChoices = ["memoryReflection", "simple"];
    const stratIdx = await prompt.askChoice("Session strategy:", stratChoices, 0);
    answers.sessionStrategy = stratChoices[stratIdx];

    heading("Advanced: MD Mirror");

    answers.mdMirrorEnabled = await prompt.askYesNo("Enable Markdown mirror?", false);
    if (answers.mdMirrorEnabled) {
      answers.mdMirrorDir = await prompt.ask("Mirror directory:", "~/.mnemo/mirror");
    }

    heading("Advanced: Self-Improvement");

    answers.selfImprovement = await prompt.askYesNo("Enable self-improvement?", false);
  } else {
    // Sensible defaults for basic mode
    answers.rerankModel = "rerank-2";
    answers.sessionStrategy = "memoryReflection";
  }

  // ── Summary ──
  heading("Configuration Summary");
  console.log("");
  label("DB Path", answers.dbPath);
  label("Voyage API Key", maskKey(answers.voyageKey));
  label("OpenAI API Key", maskKey(answers.openaiKey));
  if (answers.anthropicKey) {
    label("Anthropic API Key", maskKey(answers.anthropicKey));
  }
  label("Smart Extraction", answers.openaiKey ? "enabled" : "disabled");
  label("LLM Model", answers.llmModel);
  label("Rerank", answers.rerankModel);
  label("Graphiti", answers.graphiti ? "enabled" : "disabled");
  label("Session Strategy", answers.sessionStrategy);
  label("MD Mirror", answers.mdMirrorEnabled ? answers.mdMirrorDir : "disabled");
  label("Self-Improvement", answers.selfImprovement ? "enabled" : "disabled");
  label("Decay Half-Life", `${answers.decayHalfLife} days`);
  label("Weights (R/F/I)", `${answers.decayRecencyWeight}/${answers.decayFrequencyWeight}/${answers.decayIntrinsicWeight}`);
  console.log("");
  label("Config file", answers.savePath);
  label(".env file", path.join(path.dirname(answers.savePath), ".env"));
  console.log("");

  const confirm = await prompt.askYesNo("Save this configuration?", true);
  if (!confirm) {
    console.log(`\n  ${C.yellow}Aborted.${C.reset} No files were written.\n`);
    prompt.close();
    process.exit(0);
  }

  // ── Generate files ──
  heading("Writing Files");

  const config = buildConfig(answers);
  const envContent = buildEnv(answers);

  const configPath = path.resolve(answers.savePath);
  const envPath = path.join(path.dirname(configPath), ".env");

  // Ensure directory exists
  const configDir = path.dirname(configPath);
  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  // Write config
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf8");
  success(`Config written to ${C.underline}${configPath}${C.reset}`);

  // Write .env
  const envExists = fs.existsSync(envPath);
  if (envExists) {
    const overwrite = await prompt.askYesNo(
      `.env already exists at ${envPath}. Overwrite?`,
      false
    );
    if (overwrite) {
      fs.writeFileSync(envPath, envContent, "utf8");
      success(`.env written to ${C.underline}${envPath}${C.reset}`);
    } else {
      warn(`.env not overwritten. Update it manually with your API keys.`);
    }
  } else {
    fs.writeFileSync(envPath, envContent, "utf8");
    success(`.env written to ${C.underline}${envPath}${C.reset}`);
  }

  // Ensure dbPath directory exists
  const dbDir = expandHome(answers.dbPath);
  if (!fs.existsSync(path.dirname(dbDir))) {
    fs.mkdirSync(path.dirname(dbDir), { recursive: true });
    info(`Created directory: ${path.dirname(dbDir)}`);
  }

  // ── Done ──
  console.log("");
  console.log(
    `  ${C.bgMagenta}${C.white}${C.bold}  Setup complete!  ${C.reset}`
  );
  console.log("");
  console.log(`  ${C.dim}Next steps:${C.reset}`);
  console.log(`    1. Review ${C.cyan}${answers.savePath}${C.reset} and ${C.cyan}.env${C.reset}`);
  console.log(`    2. Run ${C.cyan}npm run doctor${C.reset} to verify your setup`);
  console.log(`    3. Start using Mnemo with Claude Code`);
  console.log("");

  prompt.close();
}

main().catch((err) => {
  console.error(`\n${C.red}Fatal error:${C.reset}`, err.message);
  process.exit(1);
});

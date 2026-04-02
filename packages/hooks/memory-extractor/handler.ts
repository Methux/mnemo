/**
 * memory-extractor hook
 * Fires on message:sent AND compact:before.
 * - message:sent: light pass, last 6 messages
 * - compact:before: deep pass, last 200 messages, captures operation details
 * Stores to vector memory via /tools/invoke HTTP API.
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

// ─── Graphiti 时序知识图谱集成 ───────────────────────────────────────────────
// fire-and-forget 写入，不阻塞主流程，失败静默降级

const GRAPHITI_BASE_URL = process.env.GRAPHITI_BASE_URL || "http://127.0.0.1:18799";
const GRAPHITI_ENABLED = (process.env.GRAPHITI_ENABLED || "false") === "true";

/**
 * 把一条 memory text 拆成高密度 episode 列表
 * 规则：
 * 1. 原始文本作为第一条（完整语义）
 * 2. 含数字/版本/百分比/路径的子句单独拆出（提升 Graphiti 事实密度）
 */
function splitIntoEpisodes(text: string): string[] {
  const episodes: string[] = [text]; // 原文始终保留

  // 匹配含数字/版本号/百分比/路径的有意义子句（>= 8 字符）
  const NUMBER_PATTERN = /[^\s。，；：！？、]+(?:\d+[\.\d]*[%亿万条个次秒s]?|v\d+[\.\d]*|\d+\.\d+|\/[a-zA-Z_\-\.]+)[^\s。，；：！？、]*/g;
  const matches = text.match(NUMBER_PATTERN) || [];

  for (const m of matches) {
    const trimmed = m.trim();
    // 去重：不和原文完全一样，且有实质内容
    if (trimmed.length >= 8 && trimmed !== text && !episodes.includes(trimmed)) {
      episodes.push(trimmed);
    }
  }

  return episodes.slice(0, 5); // 最多拆 5 条，避免 OpenAI 调用爆炸
}

/**
 * 异步写入 Graphiti 知识图谱（fire-and-forget）
 * 支持事实密度拆分：含数字的子句单独作为独立 episode
 * 失败不影响 LanceDB 写入流程
 */
async function writeToGraphiti(params: {
  text: string;
  category: string;
  timestamp: number;
  agentId: string;
  entityScope: string | null;
}): Promise<void> {
  if (!GRAPHITI_ENABLED) return;

  const episodes = splitIntoEpisodes(params.text);
  const refTime = new Date(params.timestamp).toISOString();

  for (const episodeText of episodes) {
    try {
      const resp = await fetch(`${GRAPHITI_BASE_URL}/episodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: episodeText,
          group_id: params.agentId,
          reference_time: refTime,
          category: params.category,
          source: `mnemo-${params.agentId}`,
        }),
      });

      if (resp.ok) {
        log(`Graphiti: 已写入 [${params.category}/${params.agentId}]: ${episodeText.slice(0, 60)}`);
      } else {
        log(`Graphiti: 写入失败 HTTP ${resp.status}`);
      }
    } catch (err) {
      log(`Graphiti: 降级跳过 (${err instanceof Error ? err.message : String(err)})`);
    }
  }
}

const log = (msg: string, data?: unknown) => {
  const ts = new Date().toISOString();
  console.log(`[memory-extractor] ${ts} ${msg}`, data ?? "");
};

// ─── Config ────────────────────────────────────────────────────────────────

const GATEWAY_PORT = parseInt(process.env.MNEMO_GATEWAY_PORT ?? process.env.OPENCLAW_GATEWAY_PORT ?? "18789", 10);
const GATEWAY_TOKEN = process.env.MNEMO_GATEWAY_TOKEN ?? process.env.OPENCLAW_GATEWAY_TOKEN ?? "";
const MIN_IMPORTANCE = 0.55;       // 降低阈值，让操作细节（数字/版本号）进入
const DEDUP_THRESHOLD = 0.88;      // recall score above this → skip (duplicate)
const CONFLICT_THRESHOLD = 0.70;   // recall score above this → LLM contradiction check
const SUPERSEDE_THRESHOLD = 0.82;  // legacy threshold (now folded into LLM check)

// ─── Gateway tool invocation ───────────────────────────────────────────────

async function invokeTool(
  tool: string,
  args: Record<string, unknown>,
  sessionKey: string
): Promise<unknown> {
  const resp = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/tools/invoke`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${GATEWAY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ tool, args, sessionKey }),
  });
  if (!resp.ok) throw new Error(`tools/invoke ${tool} → ${resp.status}`);
  const data = (await resp.json()) as { ok: boolean; result?: unknown; error?: unknown };
  if (!data.ok) throw new Error(`tools/invoke ${tool} failed: ${JSON.stringify(data.error)}`);
  return data.result;
}

// ─── Anthropic API key resolution ─────────────────────────────────────────

async function getAnthropicKey(): Promise<string | null> {
  try {
    const profilesPath = path.join(
      os.homedir(),
      ".mnemo/agents/default/agent/auth-profiles.json"
    );
    const raw = await fs.readFile(profilesPath, "utf-8");
    const profiles = JSON.parse(raw) as {
      profiles?: Record<string, { key?: string }>;
    };
    return profiles.profiles?.["anthropic:default"]?.key ?? null;
  } catch {
    return null;
  }
}

// ─── Entity scope tagging ─────────────────────────────────────────────────

interface EntityDef {
  displayName: string;
  scope: string;
  workEntity: boolean;
  keywords: string[];
}

/**
 * 动态加载 entity-map.json（与 prepare-context.js 共享同一份词典）
 * 文件位于 ~/.mnemo/workspace/entity-map.json
 */
function loadEntityMap(): Record<string, EntityDef> {
  try {
    const mapPath = path.join(os.homedir(), ".mnemo/workspace/entity-map.json");
    const raw = require("fs").readFileSync(mapPath, "utf-8");
    return JSON.parse(raw);
  } catch {
    // 兜底：空词典，不影响正常存储流程
    return {};
  }
}

/**
 * 从文本中检测实体，返回 entity scope 字符串
 * 多个实体时取第一个（最主要的）
 * 无实体时返回 null（用默认 scope）
 */
function detectEntityScope(text: string): string | null {
  const entityMap = loadEntityMap();
  for (const def of Object.values(entityMap)) {
    if (def.keywords.some((kw) => text.includes(kw))) {
      return def.scope;
    }
  }
  return null;
}

// ─── Structured extraction via Anthropic ──────────────────────────────────

interface EpisodicContext {
  when?: string;
  where?: string;
  trigger?: string;
}

interface MemoryCandidate {
  text: string;
  category: "decision" | "fact" | "preference" | "entity";
  importance: number;
  reason: string;
  context?: EpisodicContext;
}

interface ExtractionResult {
  memories: MemoryCandidate[];
}

// ─── Conflict Classification (LLM-based) ──────────────────────────────────

interface ConflictResult {
  relation: "contradiction" | "update" | "supplement" | "duplicate" | "unrelated";
  reason: string;
}

async function classifyConflict(
  newText: string,
  existingText: string,
  apiKey: string,
): Promise<ConflictResult> {
  const prompt =
    `Compare these two memory entries and classify their relationship.\n\n` +
    `EXISTING: ${existingText.slice(0, 500)}\n\n` +
    `NEW: ${newText.slice(0, 500)}\n\n` +
    `Classify as ONE of:\n` +
    `- contradiction: NEW directly contradicts EXISTING (e.g. "likes X" vs "doesn't like X", price changed, status reversed)\n` +
    `- update: NEW is a newer version of the same fact (same topic, newer data/numbers/status)\n` +
    `- supplement: NEW adds different details about the same topic (not conflicting, complementary)\n` +
    `- duplicate: NEW says essentially the same thing as EXISTING\n` +
    `- unrelated: different topics, just happen to have similar embeddings\n\n` +
    `Return JSON: {"relation": "...", "reason": "one-line explanation"}`;

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 256,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!resp.ok) {
    throw new Error(`Conflict classification API error ${resp.status}`);
  }

  const data = (await resp.json()) as { content: Array<{ type: string; text?: string }> };
  const text = data.content?.[0]?.text ?? "{}";
  const cleaned = text.replace(/^```json?\n?/, "").replace(/\n?```$/, "").trim();
  const parsed = JSON.parse(cleaned) as ConflictResult;

  if (!parsed.relation || !["contradiction", "update", "supplement", "duplicate", "unrelated"].includes(parsed.relation)) {
    return { relation: "unrelated", reason: "unparseable response" };
  }
  return parsed;
}

async function extractMemories(
  messages: Array<{ role: string; content: string }>,
  apiKey: string
): Promise<MemoryCandidate[]> {
  const tools = [
    {
      name: "store_memories",
      description:
        "Store memorable facts, decisions, preferences, or entities from the conversation. " +
        "Only include genuinely important, reusable information. If nothing is worth storing, call with empty array.",
      input_schema: {
        type: "object",
        properties: {
          memories: {
            type: "array",
            items: {
              type: "object",
              properties: {
                text: {
                  type: "string",
                  description: "The memory to store, self-contained and concise",
                },
                category: {
                  type: "string",
                  enum: ["decision", "fact", "preference", "entity"],
                },
                importance: {
                  type: "number",
                  description: "0.0-1.0, how important/reusable this memory is",
                },
                reason: {
                  type: "string",
                  description: "One-line reason why this is worth storing",
                },
                context: {
                  type: "object",
                  description: "REQUIRED episodic context — makes memory retrievable by situation, not just keyword",
                  properties: {
                    when: { type: "string", description: "When this happened (absolute date/time preferred)" },
                    where: { type: "string", description: "Location or setting" },
                    trigger: { type: "string", description: "REQUIRED: What question/event/topic led to this fact being discussed" },
                    emotion: { type: "string", description: "Emotional salience if any: surprise/warning/important/positive. Example: 'surprise:以为Opus是大头实际Sonnet占70%'" },
                    causal: { type: "string", description: "What this fact led to or caused downstream (optional)" },
                  },
                  required: ["trigger"],
                },
              },
              required: ["text", "category", "importance", "reason"],
            },
          },
        },
        required: ["memories"],
      },
    },
  ];

  const systemPrompt =
    "You are a memory extraction assistant. Analyze the conversation and identify information worth storing long-term.\n\n" +
    "Extract ONLY:\n" +
    "- decision: explicit decisions made (investments, configs, strategies, architecture choices)\n" +
    "- fact: verified data, numbers, procedures, API endpoints, version numbers, counts, file paths, bug fix details\n" +
    "- preference: user preferences or dislikes\n" +
    "- entity: important people, companies, projects with key attributes\n\n" +
    "IMPORTANT: Always capture specific numbers, version strings, counts, and file paths with importance ≥ 0.65.\n" +
    "Examples worth storing: '迁移失败 1 条', 'Graphiti 0.28 移除 center_date', '图谱共 523 Episode 1108 Entity', '修复 bug: 401→400→visibility→超时'.\n\n" +
    "EPISODIC CONTEXT (apply to EVERY memory — this is what makes recall work):\n" +
    "Always fill context.trigger: what question/topic/event caused this fact to come up.\n" +
    "If there was emotional salience (surprise, concern, relief), capture it in context.emotion.\n" +
    "Example: '费用$1,147.62' → trigger:'GTC后成本复盘，查platform.claude.com Cost页', emotion:'surprise:以为Opus是大头实际Sonnet占70%'\n" +
    "Example: 'fix applied' → trigger:'排查memory recall无法命中的问题', causal:'→ 之后准确率从60%降到2%'\n\n" +
    "MANDATORY LIST CAPTURE: When a list of items appears (clients, products, agents, commands, people, countries, brands), ALWAYS store it as ONE memory entry containing ALL items — never split into separate entries, never skip. Examples: 'Clients: AgiBot, BYD, ByteDance, Figure, Fourier, DeepMind' → one entry. '18 agents, 48 commands, 20 skills' → one entry with all numbers.\n\n" +
    "MANDATORY NUMERIC CAPTURE: Any specific amount ($, ¥, %, count, version) mentioned in conversation → ALWAYS store with importance ≥ 0.75. Examples: '$1,147.62 monthly API cost', 'Sonnet 70.3%', '523 Episodes / 1108 Entities', '7G106 台积电6nm'. Never skip numbers.\n\n" +
    "CRITICAL — these easy-to-miss facts must be captured when mentioned (importance ≥ 0.8):\n" +
    "- ORIGIN / HOMETOWN: Where is the user from? Where did they move from? Any mention of home country, hometown, city of origin.\n" +
    "- RELATIONSHIP STATUS: Single, dating, married, divorced, breakup? Even implied ('been on my own', 'since my breakup').\n" +
    "- BOOKS / MEDIA: Specific titles mentioned + when read/watched. Convert relative dates ('last year', '4 years ago') to absolute dates using the conversation timestamp.\n" +
    "- EVENT DATES: Any event with a relative date ('yesterday', 'last week', 'next month') → always store with absolute date calculated from conversation date.\n" +
    "- PETS: Names and types of pets owned.\n" +
    "- FAMILY DETAILS: Children names/ages, spouse, siblings — any specific personal background.\n\n" +
    "Skip: casual chat, already obvious context, temporary states.\n" +
    "Quality + completeness. If nothing is worth storing, return empty array.";

  const resp = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-20250514",
      max_tokens: 1024,
      system: systemPrompt,
      messages,
      tools,
      tool_choice: { type: "any" },
    }),
  });

  if (!resp.ok) {
    const err = await resp.text();
    throw new Error(`Anthropic API error ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = (await resp.json()) as {
    content: Array<{ type: string; input?: ExtractionResult }>;
  };

  for (const block of data.content) {
    if (block.type === "tool_use" && block.input?.memories) {
      return block.input.memories;
    }
  }
  return [];
}

// ─── Active-state snapshot (time-awareness across compaction) ─────────────

const ACTIVE_STATE_PATH = path.join(os.homedir(), ".mnemo/workspace/active-state.json");

interface ActiveStateFrame {
  generatedAt: string;
  userLocation: string;
  activeTasks: string[];
  recentDecisions: string[];
  recentTopics: string[];
  userMood: string;
}

interface ActiveState {
  current: ActiveStateFrame | null;
  previous: ActiveStateFrame | null;
}

async function readActiveState(): Promise<ActiveState> {
  try {
    const raw = await fs.readFile(ACTIVE_STATE_PATH, "utf-8");
    return JSON.parse(raw) as ActiveState;
  } catch {
    return { current: null, previous: null };
  }
}

async function writeActiveStateAtomic(state: ActiveState): Promise<void> {
  const tmp = ACTIVE_STATE_PATH + `.tmp.${Date.now()}`;
  try {
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), "utf-8");
    await fs.rename(tmp, ACTIVE_STATE_PATH);
  } catch (err) {
    // Atomic write failed — clean up tmp, silently degrade
    try { await fs.unlink(tmp); } catch {}
    log(`active-state write failed (degraded): ${err instanceof Error ? err.message : String(err)}`);
  }
}

async function generateActiveStateSnapshot(
  historyText: string,
  apiKey: string
): Promise<ActiveStateFrame | null> {
  try {
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: "Extract a real-time state snapshot from this conversation. Return ONLY valid JSON, no markdown.\n" +
          "Schema: {\"userLocation\":string, \"activeTasks\":[string], \"recentDecisions\":[string], \"recentTopics\":[string], \"userMood\":string}\n" +
          "- userLocation: where the user currently is (or \"unknown\")\n" +
          "- activeTasks: what the user is currently working on (max 5)\n" +
          "- recentDecisions: decisions made in this conversation (max 5)\n" +
          "- recentTopics: main topics discussed (max 5)\n" +
          "- userMood: brief description of user's apparent mood/state",
        messages: [{ role: "user", content: historyText.slice(0, 6000) }],
      }),
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { content: Array<{ type: string; text?: string }> };
    const text = data.content?.find(b => b.type === "text")?.text ?? "";
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return null;
    const parsed = JSON.parse(jsonMatch[0]) as Omit<ActiveStateFrame, "generatedAt">;
    return { ...parsed, generatedAt: new Date().toISOString() };
  } catch {
    return null;
  }
}

// Incremental active-state update triggers (message:sent)
const STATE_CHANGE_TRIGGERS = [
  /(?:到了|在|去了|来到|arrived|landed|at\s+\w+)/i,         // location change
  /(?:开始|启动|新任务|working on|starting|switched to)/i,  // new task
  /(?:决定|确定|定了|decided|agreed|chosen|approved)/i,      // decision
];

async function maybeIncrementalStateUpdate(content: string): Promise<void> {
  const isLocation = STATE_CHANGE_TRIGGERS[0].test(content);
  const isTask     = STATE_CHANGE_TRIGGERS[1].test(content);
  const isDecision = STATE_CHANGE_TRIGGERS[2].test(content);
  if (!isLocation && !isTask && !isDecision) return;

  try {
    const state = await readActiveState();
    if (!state.current) return; // no baseline yet, skip incremental
    const now = new Date().toISOString();
    const snippet = content.slice(0, 80).replace(/\n/g, " ");
    let changed = false;

    if (isLocation) {
      const locMatch = content.match(/(?:到了|在|去了|来到|arrived at|landed in|at)\s*(.{2,20})/i);
      if (locMatch) {
        state.current.userLocation = locMatch[1].trim();
        changed = true;
      }
    }
    if (isTask) {
      if (!state.current.activeTasks.includes(snippet)) {
        state.current.activeTasks = [...state.current.activeTasks.slice(-4), snippet];
        changed = true;
      }
    }
    if (isDecision) {
      if (!state.current.recentDecisions.includes(snippet)) {
        state.current.recentDecisions = [...state.current.recentDecisions.slice(-4), snippet];
        changed = true;
      }
    }

    if (changed) {
      state.current.generatedAt = now;
      await writeActiveStateAtomic(state);
    }
  } catch {}
}

// ─── Main handler ──────────────────────────────────────────────────────────

const handler = async (event: {
  type: string;
  action: string;
  sessionKey: string;
  context: {
    isGroup?: boolean;
    content?: string;
    channelId?: string;
  };
}) => {
  // Accept message:sent and compact:before events
  const isCompactEvent = event.type === "compact" && event.action === "before";
  const isMessageSent = event.type === "message" && event.action === "sent";
  if (!isCompactEvent && !isMessageSent) return;
  if (event.context.isGroup) return;

  // Skip very short replies (acknowledgements, etc.) — only for message:sent
  const content = event.context.content ?? "";
  if (isMessageSent && content.length < 30) return;

  // Incremental active-state update (fire-and-forget, message:sent only)
  if (isMessageSent) {
    void maybeIncrementalStateUpdate(content).catch(() => {});
  }

  // Fire-and-forget: don't block the message send path
  void (async () => {
    try {
      // 1. Get Anthropic API key
      const apiKey = await getAnthropicKey();
      if (!apiKey) {
        log("No Anthropic API key found, skipping");
        return;
      }

      // 2. Read recent conversation history
      const isCompact = isCompactEvent;
      const historyLimit = isCompact ? 200 : 6;
      const extractMode = isCompact ? "deep" : "light";
      log(`Mode: ${extractMode} (limit=${historyLimit}, event=${event.type})`);

      const historyResult = (await invokeTool(
        "sessions_history",
        { limit: historyLimit, includeTools: false, sessionKey: event.sessionKey },
        event.sessionKey
      )) as { content?: Array<{ type: string; text?: string }> };

      const historyText =
        historyResult?.content
          ?.filter((b) => b.type === "text")
          .map((b) => b.text ?? "")
          .join("\n") ?? "";

      if (!historyText || historyText.length < 100) {
        log("History too short, skipping");
        return;
      }

      // 2b. Active-state snapshot (compact:before only, fire-and-forget)
      if (isCompact) {
        void (async () => {
          try {
            const snapshot = await generateActiveStateSnapshot(historyText, apiKey);
            if (snapshot) {
              const prev = await readActiveState();
              await writeActiveStateAtomic({
                current: snapshot,
                previous: prev.current ?? null,
              });
              log("Active-state snapshot generated");
            }
          } catch (err) {
            log(`Active-state snapshot failed (degraded): ${err instanceof Error ? err.message : String(err)}`);
          }
        })();
      }

      // Parse the history text into messages for the extraction prompt
      // sessions_history returns a formatted text block - use it as a single user message
      const messages = [
        {
          role: "user" as const,
          content: isCompact
            ? `This is a FULL conversation before context compaction. Do a DEEP scan and extract ALL important facts, decisions, numbers, versions, counts, file paths, and operation results. Be comprehensive — this is your last chance to capture this conversation before it's compressed.\n\n${historyText.slice(0, 12000)}`
            : `Here is a recent conversation excerpt. Extract any memorable information:\n\n${historyText.slice(0, 3000)}`,
        },
      ];

      // 3. Run structured extraction
      const candidates = await extractMemories(messages, apiKey);
      log(`Extracted ${candidates.length} candidates`);

      if (candidates.length === 0) return;

      // 4. Deduplicate and store
      let stored = 0;
      for (const mem of candidates) {
        const threshold = isCompact ? 0.5 : MIN_IMPORTANCE;
        if (mem.importance < threshold) {
          log(`Skip (low importance ${mem.importance}): ${mem.text.slice(0, 60)}`);
          continue;
        }

        // Check for near-duplicates or conflicting older versions
        const recallResult = (await invokeTool(
          "memory_recall",
          { query: mem.text, limit: 1 },
          event.sessionKey
        )) as {
          content?: Array<{ type: string; text?: string }>;
          memories?: Array<{ id?: string; text?: string; score?: number; importance?: number; category?: string }>;
        };

        // ── 修复：直接从结构化 memories[] 拿 id + score，不再用正则解析文本 ──
        const topMemory = recallResult?.memories?.[0];
        const topId = topMemory?.id ?? null;

        // 兜底：从文本里解析百分比 score（旧格式兼容）
        let score = topMemory?.score ?? 0;
        if (!score) {
          const recallText = recallResult?.content?.[0]?.text ?? "";
          const pctMatch = recallText.match(/\((\d+)%\)/);
          if (pctMatch) score = parseInt(pctMatch[1]) / 100;
        }

        if (score >= DEDUP_THRESHOLD) {
          // 完全重复 → 跳过（插件已内建 access_count+1 和 last_accessed_at 更新）
          log(`Skip (duplicate, score=${score.toFixed(2)}): ${mem.text.slice(0, 60)}`);
          continue;
        }

        if (score >= CONFLICT_THRESHOLD && topId && topMemory?.text) {
          // LLM contradiction check: is this an update, contradiction, or just similar?
          try {
            const conflictCheck = await classifyConflict(
              mem.text,
              topMemory.text,
              apiKey,
            );

            if (conflictCheck.relation === "duplicate") {
              log(`Skip (LLM-duplicate, score=${score.toFixed(2)}): ${mem.text.slice(0, 60)}`);
              continue;
            }

            if (conflictCheck.relation === "contradiction" || conflictCheck.relation === "update") {
              // Demote old memory + expire
              const oldImportance = topMemory?.importance ?? 0.7;
              const demotedImportance = Math.max(0.05, oldImportance * 0.2);
              await invokeTool("memory_update", {
                memoryId: topId,
                importance: demotedImportance,
              }, event.sessionKey);
              log(`${conflictCheck.relation === "contradiction" ? "Contradicted" : "Updated"} (score=${score.toFixed(2)}, imp ${oldImportance}→${demotedImportance.toFixed(2)}): ${conflictCheck.reason.slice(0, 80)}`);
              // Fall through to store the new version
            }

            if (conflictCheck.relation === "supplement") {
              log(`Supplement (score=${score.toFixed(2)}): ${mem.text.slice(0, 60)} — storing alongside`);
              // Fall through to store as new entry (supplementary info)
            }

            // "unrelated" also falls through to store
          } catch (err) {
            // LLM check failed — fallback to score-based supersede
            if (score >= SUPERSEDE_THRESHOLD) {
              const oldImportance = topMemory?.importance ?? 0.7;
              const demotedImportance = Math.max(0.05, oldImportance * 0.3);
              try {
                await invokeTool("memory_update", {
                  memoryId: topId,
                  importance: demotedImportance,
                }, event.sessionKey);
                log(`Superseded-fallback (score=${score.toFixed(2)}): ${mem.text.slice(0, 60)}`);
              } catch {}
            }
          }
        }

        // Detect entity scope — only for agents that have entity detection enabled
        const currentAgentId = event.sessionKey.startsWith("agent:")
          ? event.sessionKey.split(":")[1] ?? "default"
          : "default";
        const entityScopeAgents = (process.env.MNEMO_ENTITY_SCOPE_AGENTS || "default").split(",");
        const useEntityScope = entityScopeAgents.includes(currentAgentId);
        const entityScope = useEntityScope ? detectEntityScope(mem.text) : null;

        // Encode episodic context as PREFIX — emotion/trigger before the fact text
        // so embedding captures the situational dimension, not just the raw fact.
        // Format: [emotion] [场景: trigger] fact_text [→ causal] [时间: when]
        let storeText = mem.text;
        if (mem.context) {
          const ctx = mem.context as {
            when?: string; where?: string; trigger?: string;
            emotion?: string; causal?: string;
          };
          const prefix: string[] = [];
          const suffix: string[] = [];
          if (ctx.emotion) prefix.push(`[${ctx.emotion}]`);
          if (ctx.trigger) prefix.push(`[场景: ${ctx.trigger}]`);
          if (ctx.causal)  suffix.push(`[→ ${ctx.causal}]`);
          if (ctx.when)    suffix.push(`[时间: ${ctx.when}]`);
          if (ctx.where)   suffix.push(`[地点: ${ctx.where}]`);
          const prefixStr = prefix.length > 0 ? prefix.join(" ") + " " : "";
          const suffixStr = suffix.length > 0 ? " " + suffix.join(" ") : "";
          storeText = `${prefixStr}${mem.text}${suffixStr}`;
        }

        const storeArgs: Record<string, unknown> = {
          text: storeText,
          category: mem.category,
          importance: mem.importance,
        };
        if (entityScope) {
          storeArgs.scope = entityScope;
          log(`Entity tag: ${entityScope} for "${mem.text.slice(0, 50)}"`);
        }

        // Store (LanceDB)
        await invokeTool("memory_store", storeArgs, event.sessionKey);
        stored++;
        log(`Stored [${mem.category}${entityScope ? "/" + entityScope : ""}]: ${mem.text.slice(0, 80)}`);

        // Graphiti 双写已移至 store.ts 层面（所有路径统一覆盖），此处不再重复写入
      }

      if (stored > 0) {
        log(`Done: stored ${stored} memories`);
        // 方案C：存完新记忆立刻刷新 session-context.md（零 token，~50ms）
        // sessionKey 格式：agent:{agentId}:{sessionId}，解析 agentId
        const agentId = event.sessionKey.startsWith("agent:")
          ? event.sessionKey.split(":")[1] ?? "default"
          : "default";
        const scriptPath = path.join(os.homedir(), ".mnemo/workspace/prepare-context.js");
        const child = spawn("node", [scriptPath, "--agent", agentId], { detached: true, stdio: "ignore" });
        child.unref();
        log(`Triggered prepare-context.js refresh for agent: ${agentId}`);
      }
    } catch (err) {
      log("Error:", err instanceof Error ? err.message : String(err));
    }
  })();
};

export default handler;

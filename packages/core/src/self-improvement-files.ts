// SPDX-License-Identifier: LicenseRef-Mnemo-Pro
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const DEFAULT_LEARNINGS_TEMPLATE = `# Learnings

Append structured entries:
- LRN-YYYYMMDD-XXX for corrections / best practices / knowledge gaps
- Include summary, details, suggested action, metadata, and status`;

export const DEFAULT_ERRORS_TEMPLATE = `# Errors

Append structured entries:
- ERR-YYYYMMDD-XXX for command/tool/integration failures
- Include symptom, context, probable cause, and prevention`;

const fileWriteQueues = new Map<string, Promise<void>>();

async function withFileWriteQueue<T>(filePath: string, action: () => Promise<T>): Promise<T> {
  const previous = fileWriteQueues.get(filePath) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const lock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const next = previous.then(() => lock);
  fileWriteQueues.set(filePath, next);

  await previous;
  try {
    return await action();
  } finally {
    release?.();
    if (fileWriteQueues.get(filePath) === next) {
      fileWriteQueues.delete(filePath);
    }
  }
}

function todayYmd(): string {
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

async function nextLearningId(filePath: string, prefix: "LRN" | "ERR"): Promise<string> {
  const date = todayYmd();
  let count = 0;
  try {
    const content = await readFile(filePath, "utf-8");
    const matches = content.match(new RegExp(`\\[${prefix}-${date}-\\d{3}\\]`, "g"));
    count = matches?.length ?? 0;
  } catch {
    // ignore
  }
  return `${prefix}-${date}-${String(count + 1).padStart(3, "0")}`;
}

export async function ensureSelfImprovementLearningFiles(baseDir: string): Promise<void> {
  const learningsDir = join(baseDir, ".learnings");
  await mkdir(learningsDir, { recursive: true });

  const ensureFile = async (filePath: string, content: string) => {
    try {
      const existing = await readFile(filePath, "utf-8");
      if (existing.trim().length > 0) return;
    } catch {
      // write default below
    }
    await writeFile(filePath, `${content.trim()}\n`, "utf-8");
  };

  await ensureFile(join(learningsDir, "LEARNINGS.md"), DEFAULT_LEARNINGS_TEMPLATE);
  await ensureFile(join(learningsDir, "ERRORS.md"), DEFAULT_ERRORS_TEMPLATE);
}

export interface AppendSelfImprovementEntryParams {
  baseDir: string;
  type: "learning" | "error";
  summary: string;
  details?: string;
  suggestedAction?: string;
  category?: string;
  area?: string;
  priority?: string;
  status?: string;
  source?: string;
}

// ============================================================================
// Feedback Loop — load learnings for runtime use
// ============================================================================

export interface LearningEntry {
  id: string;
  type: "learning" | "error";
  summary: string;
  details: string;
  suggestedAction: string;
  area: string;
  priority: string;
  status: string;
  loggedAt: string;
}

/**
 * Load all learnings/errors from the .learnings directory.
 * Returns structured entries that can be injected into extraction prompts
 * or used to adjust retrieval behavior.
 */
export async function loadLearnings(baseDir: string): Promise<LearningEntry[]> {
  const learningsDir = join(baseDir, ".learnings");
  const entries: LearningEntry[] = [];

  for (const [type, fileName] of [["learning", "LEARNINGS.md"], ["error", "ERRORS.md"]] as const) {
    let content: string;
    try {
      content = await readFile(join(learningsDir, fileName), "utf-8");
    } catch {
      continue;
    }

    // Parse markdown entries: ## [LRN-YYYYMMDD-XXX] ...
    const sections = content.split(/^## \[/m).slice(1);
    for (const section of sections) {
      const idMatch = section.match(/^([A-Z]+-\d{8}-\d{3})\]/);
      if (!idMatch) continue;

      const id = idMatch[1];
      const extractField = (heading: string): string => {
        const re = new RegExp(`### ${heading}\\s*\\n([\\s\\S]*?)(?=###|---|\$)`, "m");
        const m = section.match(re);
        return m ? m[1].trim() : "";
      };

      const loggedMatch = section.match(/\*\*Logged\*\*:\s*(.+)/);
      const priorityMatch = section.match(/\*\*Priority\*\*:\s*(.+)/);
      const statusMatch = section.match(/\*\*Status\*\*:\s*(.+)/);
      const areaMatch = section.match(/\*\*Area\*\*:\s*(.+)/);

      entries.push({
        id,
        type,
        summary: extractField("Summary"),
        details: extractField("Details"),
        suggestedAction: extractField("Suggested Action"),
        area: areaMatch?.[1]?.trim() || "",
        priority: priorityMatch?.[1]?.trim() || "medium",
        status: statusMatch?.[1]?.trim() || "pending",
        loggedAt: loggedMatch?.[1]?.trim() || "",
      });
    }
  }

  return entries;
}

/**
 * Build a context string from recent learnings that can be injected into
 * LLM extraction prompts. This closes the feedback loop — past mistakes
 * and best practices directly influence future memory extraction.
 *
 * @param baseDir - Base directory containing .learnings/
 * @param maxEntries - Maximum entries to include (most recent first)
 * @returns A formatted string for prompt injection, or empty string if no learnings
 */
export async function buildLearningsContext(
  baseDir: string,
  maxEntries: number = 5,
): Promise<string> {
  const entries = await loadLearnings(baseDir);
  if (entries.length === 0) return "";

  // Filter to actionable entries (not resolved/dismissed)
  const actionable = entries.filter(
    e => e.status !== "resolved" && e.status !== "dismissed" && e.suggestedAction !== "-",
  );

  // Most recent first, limit
  const recent = actionable.slice(-maxEntries).reverse();
  if (recent.length === 0) return "";

  const lines = recent.map(e =>
    `- [${e.id}] ${e.summary}${e.suggestedAction ? ` → Action: ${e.suggestedAction}` : ""}`,
  );

  return [
    "Past learnings (apply these when extracting memories):",
    ...lines,
  ].join("\n");
}

// ============================================================================
// Original append function
// ============================================================================

export async function appendSelfImprovementEntry(params: AppendSelfImprovementEntryParams): Promise<{
  id: string;
  filePath: string;
}> {
  const {
    baseDir,
    type,
    summary,
    details = "",
    suggestedAction = "",
    category = "best_practice",
    area = "config",
    priority = "medium",
    status = "pending",
    source = "mnemo/self_improvement_log",
  } = params;

  await ensureSelfImprovementLearningFiles(baseDir);
  const learningsDir = join(baseDir, ".learnings");
  const fileName = type === "learning" ? "LEARNINGS.md" : "ERRORS.md";
  const filePath = join(learningsDir, fileName);
  const idPrefix = type === "learning" ? "LRN" : "ERR";

  const id = await withFileWriteQueue(filePath, async () => {
    const entryId = await nextLearningId(filePath, idPrefix);
    const nowIso = new Date().toISOString();
    const titleSuffix = type === "learning" ? ` ${category}` : "";
    const entry = [
      `## [${entryId}]${titleSuffix}`,
      "",
      `**Logged**: ${nowIso}`,
      `**Priority**: ${priority}`,
      `**Status**: ${status}`,
      `**Area**: ${area}`,
      "",
      "### Summary",
      summary.trim(),
      "",
      "### Details",
      details.trim() || "-",
      "",
      "### Suggested Action",
      suggestedAction.trim() || "-",
      "",
      "### Metadata",
      `- Source: ${source}`,
      "---",
      "",
    ].join("\n");
    const prev = await readFile(filePath, "utf-8").catch(() => "");
    const separator = prev.trimEnd().length > 0 ? "\n\n" : "";
    await appendFile(filePath, `${separator}${entry}`, "utf-8");
    return entryId;
  });

  return { id, filePath };
}

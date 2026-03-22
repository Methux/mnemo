// SPDX-License-Identifier: LicenseRef-Mnemo-Pro
/**
 * Graphiti Write-Ahead Log (WAL) + Recovery
 *
 * Ensures Graphiti writes survive transient failures by logging pending writes
 * to a JSONL file. On plugin startup, pending entries older than 1 hour are
 * retried automatically.
 */

import { appendFile, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { log } from "./logger.js";

// ============================================================================
// WAL Path
// ============================================================================

const WAL_PATH = join(homedir(), ".openclaw", "memory", "graphiti-wal.jsonl");

// ============================================================================
// WAL Entry Types
// ============================================================================

export interface WalEntry {
  ts: string;
  action: "write";
  text: string;
  scope: string;
  category: string;
  groupId: string;
  importance: number;
  status: "pending" | "committed" | "failed";
  error?: string;
}

// ============================================================================
// WAL Writer
// ============================================================================

async function ensureWalDir(): Promise<void> {
  await mkdir(dirname(WAL_PATH), { recursive: true });
}

export async function walAppend(entry: WalEntry): Promise<void> {
  await ensureWalDir();
  const line = JSON.stringify(entry) + "\n";
  await appendFile(WAL_PATH, line, "utf8");
}

export async function walMarkCommitted(ts: string): Promise<void> {
  const entry: WalEntry = {
    ts,
    action: "write",
    text: "",
    scope: "",
    category: "",
    groupId: "",
    importance: 0,
    status: "committed",
  };
  await ensureWalDir();
  await appendFile(WAL_PATH, JSON.stringify(entry) + "\n", "utf8");
}

export async function walMarkFailed(ts: string, error: string): Promise<void> {
  const entry: WalEntry = {
    ts,
    action: "write",
    text: "",
    scope: "",
    category: "",
    groupId: "",
    importance: 0,
    status: "failed",
    error,
  };
  await ensureWalDir();
  await appendFile(WAL_PATH, JSON.stringify(entry) + "\n", "utf8");
}

// ============================================================================
// WAL Recovery
// ============================================================================

/**
 * Scan the WAL file for entries with status=pending whose ts > 1 hour ago.
 * Retry writing them to Graphiti and mark as committed or failed.
 */
export async function recoverPendingWrites(): Promise<{ recovered: number; failed: number }> {
  if (!existsSync(WAL_PATH)) {
    return { recovered: 0, failed: 0 };
  }

  let raw: string;
  try {
    raw = await readFile(WAL_PATH, "utf8");
  } catch {
    return { recovered: 0, failed: 0 };
  }

  const lines = raw.split("\n").filter((l) => l.trim().length > 0);

  // Build a map of latest status per ts
  const statusMap = new Map<string, WalEntry>();
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as WalEntry;
      // Later entries for the same ts override earlier ones
      const existing = statusMap.get(entry.ts);
      if (!existing || entry.status !== "pending") {
        statusMap.set(entry.ts, entry);
      }
    } catch {
      // Skip malformed lines
    }
  }

  // Find pending entries older than 1 hour
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const pending: WalEntry[] = [];
  for (const entry of statusMap.values()) {
    if (entry.status === "pending") {
      const entryTime = new Date(entry.ts).getTime();
      if (entryTime < oneHourAgo) {
        pending.push(entry);
      }
    }
  }

  if (pending.length === 0) {
    return { recovered: 0, failed: 0 };
  }

  const graphitiBase = process.env.GRAPHITI_BASE_URL || "http://127.0.0.1:18799";
  let recovered = 0;
  let failed = 0;

  for (const entry of pending) {
    try {
      const response = await fetch(`${graphitiBase}/episodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: `[${entry.category}] ${entry.text}`,
          group_id: entry.groupId,
          reference_time: entry.ts,
          source: `lancedb-pro-store-${entry.groupId}`,
          category: entry.category,
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (response.ok) {
        await walMarkCommitted(entry.ts);
        recovered++;
      } else {
        await walMarkFailed(entry.ts, `HTTP ${response.status}`);
        failed++;
      }
    } catch (err) {
      await walMarkFailed(entry.ts, String(err));
      failed++;
    }
  }

  log.info(
    `WAL recovery — recovered=${recovered}, failed=${failed}, total_pending=${pending.length}`,
  );

  return { recovered, failed };
}

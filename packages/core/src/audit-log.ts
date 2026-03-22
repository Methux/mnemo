// SPDX-License-Identifier: LicenseRef-Mnemo-Pro
/**
 * Mnemo Audit Log — GDPR/EU AI Act compliance
 *
 * Records all memory CRUD operations with:
 * - WHO: agent/user identity
 * - WHAT: operation type + affected memory IDs
 * - WHEN: ISO timestamp
 * - WHY: source/trigger (auto-capture, manual, contradiction, etc.)
 *
 * Stored as append-only JSONL file. Supports retention policies.
 */

import { appendFile, mkdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const AUDIT_DIR = join(homedir(), ".mnemo", "audit");
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file, then rotate

export type AuditAction =
  | "create"
  | "update"
  | "delete"
  | "bulk_delete"
  | "expire"
  | "merge"
  | "recall"
  | "export";

export interface AuditEntry {
  timestamp: string;
  action: AuditAction;
  actor: string;          // agent ID, user ID, or "system"
  memoryIds: string[];    // affected memory IDs
  scope?: string;
  reason?: string;        // "auto-capture", "contradiction", "user-request", "decay", etc.
  details?: string;       // additional context (text preview, old→new value, etc.)
  ip?: string;            // for API-based access
}

let _initialized = false;
let _currentFile = "";
let _enabled = true;

/**
 * Initialize the audit log directory.
 */
async function ensureDir(): Promise<void> {
  if (_initialized) return;
  try {
    await mkdir(AUDIT_DIR, { recursive: true });
    _currentFile = getLogFileName();
    _initialized = true;
  } catch {
    _enabled = false;
  }
}

function getLogFileName(): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(AUDIT_DIR, `audit-${date}.jsonl`);
}

/**
 * Append an audit entry. Fire-and-forget — never blocks the main flow.
 */
export async function audit(entry: AuditEntry): Promise<void> {
  if (!_enabled) return;

  try {
    await ensureDir();

    // Rotate file daily
    const expectedFile = getLogFileName();
    if (expectedFile !== _currentFile) {
      _currentFile = expectedFile;
    }

    // Check file size for rotation
    try {
      const stats = await stat(_currentFile);
      if (stats.size > MAX_FILE_SIZE) {
        const rotatedName = _currentFile.replace(".jsonl", `-${Date.now()}.jsonl`);
        _currentFile = rotatedName;
      }
    } catch {
      // File doesn't exist yet, that's fine
    }

    const line = JSON.stringify({
      ...entry,
      timestamp: entry.timestamp || new Date().toISOString(),
    }) + "\n";

    await appendFile(_currentFile, line);
  } catch {
    // Audit log failure should never break the main flow
  }
}

/**
 * Convenience: log a memory creation.
 */
export function auditCreate(
  memoryId: string,
  actor: string,
  scope: string,
  reason: string,
  textPreview?: string,
): void {
  audit({
    timestamp: new Date().toISOString(),
    action: "create",
    actor,
    memoryIds: [memoryId],
    scope,
    reason,
    details: textPreview ? textPreview.slice(0, 200) : undefined,
  }).catch(() => {});
}

/**
 * Convenience: log a memory deletion.
 */
export function auditDelete(
  memoryIds: string[],
  actor: string,
  reason: string,
): void {
  audit({
    timestamp: new Date().toISOString(),
    action: memoryIds.length > 1 ? "bulk_delete" : "delete",
    actor,
    memoryIds,
    reason,
  }).catch(() => {});
}

/**
 * Convenience: log a memory update (e.g., importance change, tier change).
 */
export function auditUpdate(
  memoryId: string,
  actor: string,
  reason: string,
  details?: string,
): void {
  audit({
    timestamp: new Date().toISOString(),
    action: "update",
    actor,
    memoryIds: [memoryId],
    reason,
    details,
  }).catch(() => {});
}

/**
 * Convenience: log a memory expiration (contradiction resolution).
 */
export function auditExpire(
  memoryId: string,
  actor: string,
  reason: string,
  details?: string,
): void {
  audit({
    timestamp: new Date().toISOString(),
    action: "expire",
    actor,
    memoryIds: [memoryId],
    reason,
    details,
  }).catch(() => {});
}

/**
 * Convenience: log a memory recall (for access audit trail).
 */
export function auditRecall(
  memoryIds: string[],
  actor: string,
  query?: string,
): void {
  audit({
    timestamp: new Date().toISOString(),
    action: "recall",
    actor,
    memoryIds,
    reason: "retrieval",
    details: query ? query.slice(0, 200) : undefined,
  }).catch(() => {});
}

/**
 * Read audit log entries for a date range.
 * Useful for compliance exports.
 */
export async function readAuditLog(
  startDate: string,
  endDate: string,
): Promise<AuditEntry[]> {
  await ensureDir();
  const entries: AuditEntry[] = [];

  const start = new Date(startDate);
  const end = new Date(endDate);
  const current = new Date(start);

  while (current <= end) {
    const dateStr = current.toISOString().slice(0, 10);
    const filePath = join(AUDIT_DIR, `audit-${dateStr}.jsonl`);

    try {
      const content = await readFile(filePath, "utf8");
      const lines = content.trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch { /* skip malformed */ }
      }
    } catch {
      // File doesn't exist for this date, skip
    }

    current.setDate(current.getDate() + 1);
  }

  return entries;
}

/**
 * Enable or disable audit logging.
 */
export function setAuditEnabled(enabled: boolean): void {
  _enabled = enabled;
}

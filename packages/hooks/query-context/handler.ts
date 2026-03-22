/**
 * query-context hook
 * Fires on message:received — on the FIRST message of a session,
 * regenerates session-context.md with query-aware vector reranking.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const log = (msg: string) => {
  const ts = new Date().toISOString();
  console.log(`[query-context] ${ts} ${msg}`);
};

const handler = async (event: {
  type: string;
  action: string;
  sessionKey: string;
  context: {
    isGroup?: boolean;
    content?: string;
    from?: string;
  };
}) => {
  if (event.type !== "message" || event.action !== "received") return;
  if (event.context.isGroup) return;

  const content = event.context.content ?? "";
  if (!content || content.length < 5) return;

  // 标志文件：每个 session 只处理第一条消息
  const flagFile = path.join(os.tmpdir(), `qctx-${event.sessionKey.replace(/[:/]/g, "-")}`);
  if (fs.existsSync(flagFile)) return;

  // 写标志文件（先写，避免并发重复触发）
  try {
    fs.writeFileSync(flagFile, Date.now().toString());
  } catch {
    return;
  }

  // 消息太短或是命令，跳过（命令一般以 / 开头）
  if (content.startsWith("/") || content.length < 8) return;

  // 从 sessionKey 解析 agentId（格式：agent:{agentId}:{sessionId}）
  const agentId = event.sessionKey.startsWith("agent:")
    ? event.sessionKey.split(":")[1] ?? "default"
    : "default";

  log(`First message detected for agent:${agentId}, triggering query-aware rerank`);
  log(`Query: "${content.slice(0, 80)}"`);

  // fire-and-forget：异步重新生成 session-context.md
  void (async () => {
    try {
      const scriptPath = path.join(os.homedir(), ".openclaw/workspace/prepare-context.js");
      const child = spawn(
        "node",
        [scriptPath, "--agent", agentId, "--query", content.slice(0, 200)],
        { detached: true, stdio: "ignore" }
      );
      child.unref();
      log(`Spawned prepare-context.js --agent ${agentId} --query "${content.slice(0, 50)}"`);
    } catch (err) {
      log(`Error: ${err instanceof Error ? err.message : String(err)}`);
    }
  })();
};

export default handler;

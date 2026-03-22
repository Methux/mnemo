---
name: query-context
description: "First-message vector rerank: on the first user message of a session, regenerate session-context.md with query-aware ranking via Voyage embeddings"
metadata:
  openclaw:
    emoji: "🎯"
    events: ["message:received"]
    requires:
      config: ["gateway.port"]
---

# query-context

Session 第一条消息触发，用消息文本做向量精排重新生成 session-context.md。

## 行为

1. 检查 `/tmp/qctx-{sessionKey}` 标志文件是否存在
2. 若不存在（第一条消息）：运行 `prepare-context.js --query "消息内容" --agent {agentId}`
3. 创建标志文件，避免后续消息重复触发
4. session-context.md 更新后，下次 `/new` 开启新 session 时精排结果生效

## 说明

- 精排结果对当前 session **不**立即生效（workspace 文件在 session 开始时注入）
- 对**下次** session 生效：下次开对话时拿到的是上次精排过的上下文
- 标志文件 TTL：`/tmp/` 目录重启后自动清理

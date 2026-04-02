---
name: memory-extractor
description: "Post-turn memory extraction: after each agent reply, extract and store memorable info via structured LLM output"
metadata:
  mnemo:
    emoji: "🧠"
    events: ["message:sent", "compact:before"]
    requires:
      config: ["gateway.port"]
---

# memory-extractor

每次 agent 发出回复后自动触发，用结构化输出提取值得长期记忆的内容（decision/fact/preference/entity），
通过 `/tools/invoke` HTTP API 写入向量库。

## 设计原则

- **fire-and-forget**：不阻塞主消息流程
- **Structured Output**：强制 JSON schema，不依赖模型主动判断
- **去重**：先 recall 检查相似度，> 0.88 跳过
- **superseded versioning**：0.82-0.88 区间降权旧条目 (imp×0.3)，存入新版本
- **episodic context**：提取 when/where/trigger 情景标签，编码进 text 后缀
- **active-state.json**：compact:before 时生成状态快照，message:sent 时增量更新
- **轻量**：message:sent 看最近 6 条，compact:before 看最近 200 条，用 haiku-4.5

## 调试

gateway 日志中搜索 `[memory-extractor]` 查看运行情况。

# OpenClaw Memory Architecture v1.1.0

> memory-lancedb-pro · 2026-03-22

---

## 一、架构总览

OpenClaw 的记忆系统采用 **双引擎存储 + 多通道写入 + 10级检索流水线** 架构，目标是让 AI agent 拥有接近人类的长期记忆能力：能自动记住重要信息、准确回忆、遗忘不重要的、随时间巩固核心知识。

```
用户对话
   │
   ▼
┌──────────────────────────────────────────┐
│           写入层（6 通道）                  │
│                                           │
│  实时: Hook(Sonnet4) + Plugin(GPT-4.1)    │
│  定时: L1提炼器(Sonnet) + MD归档(Claude)   │
│  监听: memory-watcher(Haiku)              │
│  手动: memory_store tool                  │
│                                           │
│           ↓ store.ts 统一入口              │
│     ┌─────┴─────┐                         │
│     ▼           ▼                         │
│  LanceDB    Graphiti/Neo4j                │
│  (向量+BM25)  (时序知识图谱)                │
└──────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│         检索层（10 级流水线）               │
│                                           │
│  S0 预处理 → S1 共振门控 → S2 Multi-hop   │
│  → S3 三路并行(Vector+BM25+Graphiti)      │
│  → S4 RRF融合 → S5 初筛 → S6 Rerank      │
│  → S7 Decay → S8 长度归一+硬分线           │
│  → S9 噪音+MMR → S10 会话去重              │
│           ↓                               │
│      Top 3 注入 context                   │
└──────────────────────────────────────────┘
           │
           ▼
┌──────────────────────────────────────────┐
│         生命周期管理                       │
│                                           │
│  Tier分级 · Decay衰减 · Session反思       │
│  Cron维护 · WAL保障 · Scope隔离           │
└──────────────────────────────────────────┘
```

---

## 二、写入层 — 6 通道

### 2.1 Hook memory-extractor（实时轻量）

- **触发**: `message:sent` + `compact:before`
- **模型**: Claude Sonnet 4
- **输入**: light 6msg/3K chars · deep 200msg/12K chars
- **分类**: decision / fact / preference / entity
- **特点**: fire-and-forget · importance 评分 · 去重(recall≥0.88跳过, ≥0.7 supersede) · 情景上下文(when/where/trigger/emotion/causal) · 强制捕获数字/版本(importance≥0.75)

### 2.2 Plugin SmartExtractor（深度结构化）

- **触发**: `agent_end`
- **模型**: GPT-4.1
- **分类**: profile / preferences / entities / events / cases / patterns（6 分类）
- **三层结构**: L0 abstract(索引) → L1 overview(摘要) → L2 content(全文)
- **特点**: captureAssistant=true · noise bank 预过滤 · 提取后 dedup 合并 · fallback regex

### 2.3 L1 记忆提炼器（定时回扫）

- **触发**: cron 30m(default) / 1h(bot3, bot5)
- **模型**: Claude Sonnet 4.6
- **输入**: 最近 2h 对话 (limit=30)
- **作用**: 兜底网——实时提取漏掉的补上 · recall 去重

### 2.4 daily-md-extractor（每日归档）

- **触发**: cron 23:30 · ×3 agent
- **模型**: Claude
- **作用**: daily notes → 补录未入库 facts · 超 7 天 → archive/

### 2.5 memory-watcher（文件变更监听）

- **触发**: fs.watch + 3s 防抖 · 常驻后台进程
- **模型**: Claude Haiku 4.5
- **监听**: USER.md / AGENTS.md / IDENTITY.md / TOOLS.md / MEMORY.md
- **去重**: md5 对比，内容不变不触发

### 2.6 手动 memory_store

- agent 主动调用 · 最精确

### 统一入口 store.ts

所有通道 → Step 1 embedding 去重 → Step 2 LanceDB 写入 → Step 3 Graphiti 双写 (WAL 保障)

---

## 三、存储层 — 双引擎

### LanceDB（向量数据库）

- voyage-3-large 1024d · hybrid (vector + BM25 FTS)
- 10,000 条 · scope 隔离 (6 bot)
- tier: core / working / peripheral
- 每日 JSONL 全量备份 + MD Mirror 镜像

### Graphiti / Neo4j（时序知识图谱）

- Entity → Relation → Entity
- valid_at / expired_at 时效 · degree 中心度 · group_id 隔离
- WAL (Write-Ahead Log) 防丢数据
- 条件: importance ≥ 0.5 且 text ≥ 20 chars

**互补关系**: LanceDB 擅长语义相似度("什么和这个像"), Graphiti 擅长实体关系("A和B什么关系")

---

## 四、检索层 — 10 级流水线

| 阶段 | 名称 | 作用 |
|------|------|------|
| S0 | 预处理 | 清除 metadata 污染 · <8 字符跳过 |
| S1 | 共振门控 | 快速向量探测 top3 · sim≥0.55 或 (≥threshold+imp≥0.7) · 不通过→返回空 · adaptive threshold |
| S2 | Multi-hop 检测 | ≥2 实体→Graphiti 走 /search 不走 /spread |
| S3 | 三路并行检索 | Promise.all: Vector(40) + BM25(40) + Graphiti(spread 3/search 5) · 5s 超时 |
| S4 | RRF 三源融合 | Vector×0.7+BM25×0.3 · BM25≥0.75 保底×0.92 · Graphiti 入场×0.85 · search 0.65/spread 0.45+degreeBoost |
| S5 | 初筛 | minScore < 0.3 丢弃 |
| S6 | Cross-Encoder Rerank | Voyage rerank-2 · 所有结果统一精排 · blend: rerank×0.6+original×0.4 · BM25≥0.75 保底×0.95 · 5s timeout→fallback cosine |
| S7 | Decay + Lifecycle | core 地板 0.9/working 0.7/peripheral 0.5 · 半衰期 30d · reinforcement 0.5 |
| S8 | 长度归一+硬分线 | 锚点 500ch · hardMinScore 0.35 |
| S9 | 噪音+MMR 去重 | 过滤拒绝/元问题/样板 · 最大边际相关性去重 |
| S10 | 会话去重+注入 | 同一记忆 3 轮不重复 · access_count++ → tier 晋升 · **Top 3 注入 context** |

---

## 五、生命周期管理

### Tier 分级

| 级别 | 条件 | 衰减地板 | β |
|------|------|----------|---|
| Core | access≥10 或 imp≥0.8 或 composite≥0.7 | 0.9 | 0.8 |
| Working | access≥3 或 composite≥0.4 | 0.7 | 1.0 |
| Peripheral | composite<0.15 或 age>60d | 0.5 | 1.3 |

### Decay 衰减

```
composite = recency × 0.4 + frequency × 0.3 + intrinsic × 0.3
decay = floor + (1 - floor) × exp(-age / (halfLife × reinforcement))
```

### Cron 维护矩阵

| 任务 | 频率 |
|------|------|
| 夜间深度记忆巩固 | daily |
| 记忆关联整合 | daily 03:00 |
| weekly dedup | weekly |
| 月度健康 review | monthly |

### Session Reflection

memoryReflection · inheritance+derived · 会话间摘要写入 LanceDB

---

## 六、与市面记忆方案对比

### 对比对象

| 方案 | 类型 | 定位 |
|------|------|------|
| **Mem0** | 开源/SaaS | Memory layer for AI apps |
| **Zep** | 开源/商用 | Long-term memory for assistants |
| **Letta (MemGPT)** | 开源 | Memory-augmented agent framework |
| **LangMem** | 开源 (LangChain) | Memory management toolkit |
| **Cognee** | 开源 | Knowledge management + RAG |
| **OpenClaw** | 自研 | 全栈 agent 记忆系统 |

### 评分（满分 10）

| 维度 | Mem0 | Zep | Letta | LangMem | Cognee | **OpenClaw** |
|------|:----:|:---:|:-----:|:-------:|:------:|:------------:|
| 写入通道丰富度 | 4 | 5 | 6 | 3 | 4 | **9** |
| 提取智能度 | 6 | 5 | 7 | 4 | 5 | **9** |
| 检索精度 | 6 | 7 | 5 | 5 | 6 | **9** |
| 知识图谱集成 | 3 | 4 | 2 | 2 | 7 | **8** |
| 记忆生命周期 | 4 | 5 | 7 | 3 | 3 | **9** |
| 多 Agent 隔离 | 5 | 3 | 4 | 3 | 3 | **9** |
| 自动化程度 | 5 | 5 | 6 | 3 | 4 | **9** |
| 可观测性 | 4 | 6 | 5 | 3 | 4 | **7** |
| 易用性 | 8 | 8 | 6 | 7 | 6 | **4** |
| 社区/生态 | 8 | 7 | 7 | 8 | 5 | **2** |
| **综合** | **5.3** | **5.5** | **5.5** | **4.1** | **4.7** | **7.5** |

### 逐维度分析

**写入通道丰富度**
- Mem0: 主要靠 `add()` API 单入口 + 简单 auto-capture → 4
- Letta: 内置 archival/recall + agent 自主管理 → 6
- **OpenClaw**: 6 条独立通道，从实时到定时到文件监听全覆盖 → 9

**提取智能度**
- Mem0: GPT-4 提取但只有单层文本，无结构化分类 → 6
- Letta: agent 自主决定但无多模型多层次 → 7
- **OpenClaw**: 双模型(Sonnet4 + GPT-4.1) · 6分类 · 三层结构 · noise bank · importance · 情景上下文 → 9

**检索精度**
- Zep: hybrid search + MMR + 时序感知 → 7
- Mem0: 向量检索为主，rerank 有限 → 6
- **OpenClaw**: 10级流水线 · 三路并行 · RRF融合 · cross-encoder rerank · 共振门控 · BM25保护地板 → 9

**知识图谱集成**
- Cognee: 原生图谱支持但融合度一般 → 7
- Mem0/Letta: 基本无图谱 → 2-3
- **OpenClaw**: Graphiti/Neo4j 深度双写 + WAL + 检索三路并行 + 跨源rerank + spread/search双模式 + 时序 valid_at/expired_at → 8

**记忆生命周期**
- Letta: archival 分层概念 → 7
- Mem0: 基本没有生命周期 → 4
- **OpenClaw**: tier三级 + 多维decay + access reinforcement + session reflection + cron维护矩阵(巩固/整合/去重/review) → 9

**多 Agent 隔离**
- 大多数: 单agent或简单namespace → 3-5
- **OpenClaw**: 6 bot 独立 scope · agentAccess 精细控制 · 写入/检索均隔离 → 9

**自动化程度**
- **OpenClaw**: 几乎零人工——对话自动提取 · 定时回扫 · 文件监听 · daily归档 · tier自动转换 · decay自动 · session自动反思 · auto-recall自动注入 → 9

**可观测性**
- Zep: 有 dashboard → 6
- **OpenClaw**: retrieval log + management tools + WAL，但缺统一 dashboard → 7

**易用性**
- Mem0/Zep: pip install + 几行代码 → 8
- **OpenClaw**: 自研系统，配置复杂 → 4

**社区/生态**
- Mem0/LangMem: GitHub star 多，社区活跃 → 8
- **OpenClaw**: 私有项目 → 2

### 独特优势

1. **6 通道写入 coverage** — 几乎不可能漏掉有价值的信息
2. **双引擎存储** — LanceDB(语义) + Graphiti(关系/时序)，互补
3. **10 级检索流水线** — 每级有明确职责，可独立调优
4. **完整生命周期** — tier分级 + 多维衰减 + 定时维护，记忆库健康演进
5. **多 Agent scope 隔离** — 6 bot 各自独立又共享全局

### 主要短板

1. **易用性低** — 配置和运维复杂度高
2. **无公开社区** — 无法借助外部贡献
3. **单机架构** — 运行在单台 Mac，无分布式
4. **可观测性** — 缺少统一 dashboard

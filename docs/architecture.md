# OpenClaw Memory Architecture v1.1.0

> mnemo · 2026-03-22

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

- **触发**: cron 30m(default) / 1h(other agents)
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

See [Comparison](/guide/comparison) for feature-by-feature analysis and [LOCOMO Benchmark](/guide/benchmark) for retrieval accuracy data.

### Mnemo Differentiators

1. **6-channel write coverage** — Hook, SmartExtractor, L1 Distiller, daily archiver, file watcher, manual store
2. **Dual-engine storage** — LanceDB (semantic) + Graphiti (relational/temporal)
3. **10-stage retrieval pipeline** — Each stage has a clear responsibility, independently tunable
4. **Complete lifecycle** — Tier system + Weibull decay + access reinforcement + session reflection
5. **Multi-agent scope isolation** — Per-bot namespaces with configurable cross-access

### 主要短板

1. **易用性低** — 配置和运维复杂度高
2. **无公开社区** — 无法借助外部贡献
3. **单机架构** — 运行在单台 Mac，无分布式
4. **可观测性** — 缺少统一 dashboard

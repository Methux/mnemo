// SPDX-License-Identifier: MIT
/**
 * Prompt templates for intelligent memory extraction.
 * Three mandatory prompts:
 * - buildExtractionPrompt: 6-category L0/L1/L2 extraction with few-shot
 * - buildDedupPrompt: CREATE/MERGE/SKIP dedup decision
 * - buildMergePrompt: Memory merge with three-level structure
 */

export function buildExtractionPrompt(
  conversationText: string,
  user: string,
): string {
  return `Analyze the following session context and extract memories worth long-term preservation.

User: ${user}

Target Output Language: auto (detect from recent messages)

## Recent Conversation
${conversationText}

# Memory Extraction Criteria

## What is worth remembering?
- Personalized information: Information specific to this user, not general domain knowledge
- Long-term validity: Information that will still be useful in future sessions
- Specific and clear: Has concrete details, not vague generalizations

## What is NOT worth remembering?
- General knowledge that anyone would know
- Temporary information: One-time questions or conversations
- Vague information: "User has questions about a feature" (no specific details)
- Tool output, error logs, or boilerplate
- Recall queries / meta-questions: "Do you remember X?", "你还记得X吗?", "你知道我喜欢什么吗" — these are retrieval requests, NOT new information to store
- Degraded or incomplete references: If the user mentions something vaguely ("that thing I said"), do NOT invent details or create a hollow memory

# Memory Classification

## Core Decision Logic

| Question | Answer | Category |
|----------|--------|----------|
| Who is the user? | Identity, attributes | profile |
| What does the user prefer? | Preferences, habits | preferences |
| What is this thing? | Person, project, organization | entities |
| What happened? | Decision, milestone | events |
| How was it solved? | Problem + solution | cases |
| What is the process? | Reusable steps | patterns |

## Precise Definition

**profile** - User identity (static attributes). Test: "User is..."
**preferences** - User preferences (tendencies). Test: "User prefers/likes..."
**entities** - Continuously existing nouns. Test: "XXX's state is..."
**events** - Things that happened. Test: "XXX did/completed..."
**cases** - Problem + solution pairs. Test: Contains "problem -> solution"
**patterns** - Reusable processes. Test: Can be used in "similar situations"

## Common Confusion
- "Plan to do X" -> events (action, not entity)
- "Project X status: Y" -> entities (describes entity)
- "User prefers X" -> preferences (not profile)
- "Encountered problem A, used solution B" -> cases (not events)
- "General process for handling certain problems" -> patterns (not cases)

# Three-Level Structure

Each memory contains three levels:

**abstract (L0)**: One-liner index
- Merge types (preferences/entities/profile/patterns): \`[Merge key]: [Description]\`
- Independent types (events/cases): Specific description

**overview (L1)**: Structured Markdown summary with category-specific headings

**content (L2)**: Full narrative with background and details

# Few-shot Examples

## profile
\`\`\`json
{
  "category": "profile",
  "abstract": "User basic info: AI development engineer, 3 years LLM experience",
  "overview": "## Background\\n- Occupation: AI development engineer\\n- Experience: 3 years LLM development\\n- Tech stack: Python, LangChain",
  "content": "User is an AI development engineer with 3 years of LLM application development experience."
}
\`\`\`

## preferences
\`\`\`json
{
  "category": "preferences",
  "abstract": "Python code style: No type hints, concise and direct",
  "overview": "## Preference Domain\\n- Language: Python\\n- Topic: Code style\\n\\n## Details\\n- No type hints\\n- Concise function comments\\n- Direct implementation",
  "content": "User prefers Python code without type hints, with concise function comments."
}
\`\`\`

## cases
\`\`\`json
{
  "category": "cases",
  "abstract": "LanceDB BigInt error -> Use Number() coercion before arithmetic",
  "overview": "## Problem\\nLanceDB 0.26+ returns BigInt for numeric columns\\n\\n## Solution\\nCoerce values with Number(...) before arithmetic",
  "content": "When LanceDB returns BigInt values, wrap them with Number() before doing arithmetic operations."
}
\`\`\`

# Output Format

Return JSON:
{
  "memories": [
    {
      "category": "profile|preferences|entities|events|cases|patterns",
      "abstract": "One-line index",
      "overview": "Structured Markdown summary",
      "content": "Full narrative"
    }
  ]
}

Notes:
- Output language should match the dominant language in the conversation
- Extract ALL specific personal facts: names, numbers, dates, places, preferences, decisions, plans
- Preserve exact details — never generalize a specific value (e.g., keep "$800" not "expensive")
- If facts change or update in the conversation, extract the LATEST value
- If nothing worth recording, return {"memories": []}
- Maximum 10 memories per extraction
- Preferences should be aggregated by topic`;
}

// ============================================================================
// Chinese Extraction Prompt
// ============================================================================

export function buildChineseExtractionPrompt(
  conversationText: string,
  user: string,
): string {
  return `分析以下会话上下文，提取值得长期保存的记忆。

用户: ${user}

## 最近对话
${conversationText}

# 记忆提取标准

## 什么值得记住？
- 个性化信息：专属于该用户的信息，而非通用领域知识
- 长期有效性：在未来会话中仍然有用的信息
- 具体明确：有具体细节，而非模糊的概括

## 什么不值得记住？
- 任何人都知道的常识
- 临时信息：一次性的提问或对话
- 模糊信息："用户对某功能有疑问"（没有具体细节）
- 工具输出、错误日志或模板文字
- 回忆查询/元问题："你还记得X吗？"、"好的"、"收到"、"嗯嗯"——这些是检索请求或应答碎片，不是新信息
- 降级或不完整引用：如果用户模糊提及某事（"之前说的那个"），不要编造细节或创建空洞记忆

# 记忆分类

## 核心判断逻辑

| 问题 | 答案 | 分类 |
|------|------|------|
| 用户是谁？ | 身份、属性 | profile |
| 用户偏好什么？ | 偏好、习惯 | preferences |
| 这个东西是什么？ | 人物、项目、组织 | entities |
| 发生了什么？ | 决策、里程碑 | events |
| 怎么解决的？ | 问题+方案 | cases |
| 流程是什么？ | 可复用步骤 | patterns |

## 精确定义

**profile** - 用户身份（静态属性）。判断标准："用户是..."
**preferences** - 用户偏好（倾向性）。判断标准："用户偏好/喜欢..."
**entities** - 持续存在的名词实体。判断标准："XXX的状态是..."
**events** - 发生过的事件。判断标准："XXX做了/完成了..."
**cases** - 问题+解决方案对。判断标准：包含"问题->方案"
**patterns** - 可复用流程。判断标准：可用于"类似场景"

## 常见混淆
- "计划做X" -> events（行动，非实体）
- "项目X的状态：Y" -> entities（描述实体）
- "用户偏好X" -> preferences（不是 profile）
- "遇到问题A，用了方案B" -> cases（不是 events）
- "处理某类问题的通用流程" -> patterns（不是 cases）

# 三级结构

每条记忆包含三个层级：

**abstract (L0)**：一行索引
- 合并类型（preferences/entities/profile/patterns）：\`[合并键]: [描述]\`
- 独立类型（events/cases）：具体描述

**overview (L1)**：结构化 Markdown 摘要，使用分类特定标题

**content (L2)**：包含背景和细节的完整叙述

# 少样本示例

## profile
\`\`\`json
{
  "category": "profile",
  "abstract": "用户基本信息：AI开发工程师，3年LLM经验",
  "overview": "## 背景\\n- 职业：AI开发工程师\\n- 经验：3年LLM应用开发\\n- 技术栈：Python, LangChain",
  "content": "用户是一名AI开发工程师，有3年LLM应用开发经验。"
}
\`\`\`

## preferences
\`\`\`json
{
  "category": "preferences",
  "abstract": "Python代码风格：不加类型注解，简洁直接",
  "overview": "## 偏好领域\\n- 语言：Python\\n- 主题：代码风格\\n\\n## 详情\\n- 不加类型注解\\n- 简洁的函数注释\\n- 直接实现",
  "content": "用户偏好不带类型注解的Python代码，函数注释要简洁。"
}
\`\`\`

## cases
\`\`\`json
{
  "category": "cases",
  "abstract": "LanceDB BigInt错误 -> 在运算前使用Number()转换",
  "overview": "## 问题\\nLanceDB 0.26+对数值列返回BigInt\\n\\n## 方案\\n在运算前用Number(...)转换",
  "content": "当LanceDB返回BigInt值时，在做算术运算前用Number()包裹。"
}
\`\`\`

# 输出格式

返回 JSON:
{
  "memories": [
    {
      "category": "profile|preferences|entities|events|cases|patterns",
      "abstract": "一行索引",
      "overview": "结构化Markdown摘要",
      "content": "完整叙述"
    }
  ]
}

注意：
- 输出语言应与对话中的主要语言一致
- 提取所有具体的个人事实：名字、数字、日期、地点、偏好、决定、计划
- 保留精确细节——不要将具体值泛化（如保留"$800"而非"很贵"）
- 如果对话中事实有变更，提取最新值
- 如果没有值得记录的内容，返回 {"memories": []}
- 每次提取最多10条记忆
- 偏好应按主题聚合`;
}

export function buildDedupPrompt(
  candidateAbstract: string,
  candidateOverview: string,
  candidateContent: string,
  existingMemories: string,
): string {
  return `Determine how to handle this candidate memory.

**Candidate Memory**:
Abstract: ${candidateAbstract}
Overview: ${candidateOverview}
Content: ${candidateContent}

**Existing Similar Memories**:
${existingMemories}

Please decide:
- SKIP: Candidate memory duplicates existing memories, no need to save. Also SKIP if the candidate contains LESS information than an existing memory on the same topic (information degradation — e.g., candidate says "programming language preference" but existing memory already says "programming language preference: Python, TypeScript")
- CREATE: This is completely new information not covered by any existing memory, should be created
- MERGE: Candidate memory adds genuinely NEW details to an existing memory and should be merged
- SUPPORT: Candidate reinforces/confirms an existing memory in a specific context (e.g. "still prefers tea in the evening")
- CONTEXTUALIZE: Candidate adds a situational nuance to an existing memory (e.g. existing: "likes coffee", candidate: "prefers tea at night" — different context, same topic)
- CONTRADICT: Candidate directly contradicts an existing memory in a specific context (e.g. existing: "runs on weekends", candidate: "stopped running on weekends")

IMPORTANT:
- "events" and "cases" categories are independent records — they do NOT support MERGE/SUPPORT/CONTEXTUALIZE/CONTRADICT. For these categories, only use SKIP or CREATE.
- If the candidate appears to be derived from a recall question (e.g., "Do you remember X?" / "你记得X吗？") and an existing memory already covers topic X with equal or more detail, you MUST choose SKIP.
- A candidate with less information than an existing memory on the same topic should NEVER be CREATED or MERGED — always SKIP.
- For SUPPORT/CONTEXTUALIZE/CONTRADICT, you MUST provide a context_label from this vocabulary: general, morning, evening, night, weekday, weekend, work, leisure, summer, winter, travel.

Return JSON format:
{
  "decision": "skip|create|merge|support|contextualize|contradict",
  "match_index": 1,
  "reason": "Decision reason",
  "context_label": "evening"
}

- If decision is "merge"/"support"/"contextualize"/"contradict", set "match_index" to the number of the existing memory (1-based).
- Only include "context_label" for support/contextualize/contradict decisions.`;
}

export function buildMergePrompt(
  existingAbstract: string,
  existingOverview: string,
  existingContent: string,
  newAbstract: string,
  newOverview: string,
  newContent: string,
  category: string,
): string {
  return `Merge the following memory into a single coherent record with all three levels.

** Category **: ${category}

** Existing Memory:**
    Abstract: ${existingAbstract}
  Overview:
${existingOverview}
  Content:
${existingContent}

** New Information:**
    Abstract: ${newAbstract}
  Overview:
${newOverview}
  Content:
${newContent}

  Requirements:
  - Remove duplicate information
    - Keep the most up - to - date details
      - Maintain a coherent narrative
        - Keep code identifiers / URIs / model names unchanged when they are proper nouns

Return JSON:
  {
    "abstract": "Merged one-line abstract",
      "overview": "Merged structured Markdown overview",
        "content": "Merged full content"
  } `;
}

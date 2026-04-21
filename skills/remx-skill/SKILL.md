---
name: remx-skill
description: RemX 项目记忆管理工具的 OpenClaw Skill 封装。适配 TypeScript CLI（remx-core），提供主动记忆召回/创建/更新能力。
---

# RemX Skill

RemX 是项目的外部记忆系统，通过向量检索 + 拓扑图 + 衰减机制，让 AI 在任意时刻都能快速理解项目上下文。

**本 Skill 基于 TypeScript CLI（remx-core）**，所有记忆操作必须通过 `remx <cmd>` 命令，禁止直接调用源码。

---

## 核心概念

| 概念 | 说明 |
|------|------|
| **memory / 记忆** | 一个文件的唯一记录，含元数据（category/priority/status） + 多个 chunk |
| **chunk** | 按标题层级（H1/H2/H3）切分的语义单元 |
| **path（记忆 ID）** | 文件路径即为记忆 ID，直接用于 `remx retrieve` 和 `remx relate` |
| **chunk_id** | 格式：`{index_scope}::{path}::{chunk_index}`，如 `project::demands/auth.md::0` |
| **decay** | 按 category 所属 decay_group 自动衰减；`tmp` 24h、`demand` 168h、`knowledge` never |
| **语义检索** | `remx retrieve --query` 触发向量检索（ollama bge-m3）|
| **拓扑关系** | 记忆之间的因果/相关性连接，支持 BFS 图遍历扩展召回 |

---

## 衰减默认值（meta.yaml 无显式配置时）

| category | decay function | 说明 |
|----------|---------------|------|
| `tmp` | `ttl` 24h | 临时笔记 |
| `demand` | `stale_after` 168h | 设计决策 |
| `issue` | `stale_after` 720h | 问题/bug |
| `knowledge` | `never` | 知识积累 |
| `principle` | `ttl` 8760h | 原则规范 |

---

## CLI 命令（7个）

所有操作均通过 `remx <cmd>` 执行，详细用法见 `references/remx-cli-commands.md`。

| 命令 | 功能 |
|------|------|
| `remx init` | 初始化数据库（`files`/`chunks`/`remx_lifecycle` 表）|
| `remx index` | 索引单个文件，自动写入 front-matter 指定的 category/status |
| `remx retrieve` | 过滤模式或语义模式检索 |
| `remx gc` | 软删除过期 + 物理清理 deprecated 记忆 |
| `remx stats` | 数据库统计（活跃/废弃记忆数、分类分布）|
| `remx parse` | 验证 meta.yaml 配置 |
| `remx relate` | 拓扑关系管理（nodes/insert/query/graph/delete）|

---

## 主动性规范（Skill 层核心设计）

RemX Skill 的记忆操作由 Agent **主动决策**，无需用户显式提醒。

### 触发分析（每次 Agent 回答前自动执行）

Agent 在生成回答前，先分析当前上下文：

**相关性分析：**
- 讨论是否涉及项目内容（架构、方案、决策、技术术语、文件名、模块名）
- 区分"闲聊"和"项目相关讨论"

**记忆价值分析：**
- 是否输出了新决策、结论、解决方案
- 是否发现了现有记忆的错误或过时内容
- 是否提出了新的待办、问题或想法

**Topic 延续分析：**
- 是否在延续之前的讨论话题
- 是否需要引用已有的记忆内容

### 决策结果

| 决策 | 触发条件 | Agent 行为 |
|------|---------|-----------|
| **RECALL** | 上下文涉及项目相关内容 | 自然引用相关记忆，不额外提示 |
| **CREATE** | 输出了新决策/结论/方案 | 在回答末尾追加 `🆕 新建: <path>` 摘要 |
| **UPDATE** | 发现记忆内容与事实不符 | 在回答末尾追加 `🔄 更新: <path>` 摘要 |
| **NONE** | 无相关记忆操作 | 不显示摘要 |

### 主动触发场景（无需用户提醒）

| 场景 | 自动操作 |
|------|---------|
| 会话开始时 | 检查快到期记忆（`remx gc --dry-run`），提醒用户 |
| 讨论项目架构/方案时 | 自动召回相关记忆，自然融入回答 |
| 输出了技术决策时 | 自动创建 demand 记忆 |
| 发现 bug/问题时 | 自动创建 issue 记忆 |
| 记忆内容与事实不符时 | 自动更新记忆 |
| 讨论中引用了某条记忆 | 自动建立拓扑关系（相关性）|

---

## 输出规范：答案末尾的参考摘要

当有记忆操作时，在 Agent 回答**末尾**追加一行摘要（无操作时省略）：

```
---
📚 召回: path/to/demand-001.md, issues/bug-auth.md
🆕 新建: demands/session-token.md
🔄 更新: demands/auth-module.md
🔗 拓扑: demands/auth-module.md → issues/bug-auth.md (因果关系)
```

**各字段说明：**

| 字段 | 含义 |
|------|------|
| `📚 召回` | 本次回答中引用的记忆路径列表 |
| `🆕 新建` | 本次新建的记忆路径 |
| `🔄 更新` | 本次更新的记忆路径 |
| `🔗 拓扑` | 本次新建的拓扑关系（格式：`A → B (关系类型)`）|

**注意：** 用户始终看到自然的对话；摘要行仅当有操作时出现。

---

## Skill 组件（modules/）

| 组件 | 职责 |
|------|------|
| **MemoryManager** | 核心决策引擎：语义分析 + 自主决策 + 协调各模块 |
| **ContextAssembler** | `remx retrieve` 召回 + 组装 LLM 可用上下文 |
| **DecayWatcher** | 检查衰减阈值，对快到期记忆发出提醒 |
| **MemoryFileManager** | 写 / 更新 / 删除记忆文件，联动 `remx index` |

详细接口文档见各 `modules/*.md` 文件。

---

## 拓扑关系

RemX 通过拓扑关系将相关记忆连接成图，实现上下文感知的图遍历召回。

### 关系类型

| rel_type | 说明 |
|----------|------|
| `因果关系` | A 导致 B |
| `相关性` | A 与 B 相关 |
| `对立性` | A 与 B 对立 |
| `流程顺序性` | A 在 B 之前/之后 |
| `组成性` | A 是 B 的组件 / B 是 A 的整体 |
| `依赖性` | A 依赖 B |

### Context 过滤

relation 的 `context` 字段决定何时可用：
- `NULL`（全局）→ 所有上下文都匹配
- `global` → 全局无条件匹配
- `main_session` → 仅在主会话上下文匹配
- `group_chat` → 仅在群聊上下文匹配

**匹配规则：**
```
relation.context == NULL || relation.context == "global" → 始终匹配
relation.context == current_context → 精确匹配
otherwise → 不匹配
```

### 拓扑增强检索流程

```
1. 语义搜索：remx retrieve --query "认证模块" → 基础结果集
2. 拓扑扩展：对结果中每条记忆执行 BFS 图遍历 → 扩展结果集
3. 合并去重：基础结果 + 拓扑扩展结果合并 → 最终结果
```

---

## 记忆书写规范

详见 `references/memory-writing-guide.md`，核心规则：

- **分块**：每个 chunk 最大 360 字（约 H1-H3 一个章节）
- **标题**：每个 chunk 以 H1/H2/H3 标题开头
- **front-matter**：必须包含 `category`，可选 `priority`/`status`/`type`
- **双向链接**：关联记忆末尾添加 `标题1 <--> 标题2`
- **稀疏链接**：仅严格依赖关系才链接，避免全连接

---

## 快速开始

```bash
# 初始化
remx init --db ./memory.db --meta ./meta.yaml

# 索引记忆文件
remx index demands/auth-module.md --db ./memory.db --meta ./meta.yaml

# 过滤检索
remx retrieve --filter '{"category":"demand","status":"open"}' --db ./memory.db

# 语义搜索
remx retrieve --query "认证模块是怎么实现的" --db ./memory.db --meta ./meta.yaml

# 建立拓扑关系
remx relate insert --db ./memory.db --nodes demands/auth.md,issues/bug-auth.md \
  --rel-type 因果关系 --roles cause,effect --context main_session

# 查看拓扑图
remx relate graph --db ./memory.db --node-id demands/auth.md

# 健康检查
remx stats --db ./memory.db

# GC
remx gc --db ./memory.db --dry-run
remx gc --db ./memory.db --purge
```

---

## 环境配置

在首次使用 remx-skill 前，必须完成环境配置，详见：

- `docs/env-setup.md` — sqlite-vec 安装 + meta.yaml 配置
- `docs/env-check.md` — 环境检测脚本

**必需项：** sqlite-vec（npm 全局包） + 合法 meta.yaml。

---

## 配置

主要配置在 `meta.yaml`，参考 `references/remx-cli-commands.md#衰减策略metayaml-decay_groups` 和 `docs/env-setup.md#meta.yaml-配置`。

关键项：
- `index_scope` — 定义哪些路径算项目记忆
- `decay_groups` — 定义各类记忆的衰减规则
- `chunk.strategy` — `heading`（默认）或 `paragraph`
- `embedder` — 向量嵌入配置（用于语义检索，provider=ollama/model=bge-m3）

---

## 文件结构

```
remx-skill/
├── SKILL.md                          ← 本文件
├── docs/
│   ├── env-setup.md                 ← sqlite-vec 安装 + meta.yaml 配置
│   └── env-check.md                  ← 环境检测脚本
├── modules/
│   ├── memory-manager.md             ← 核心决策引擎
│   ├── context-assembler.md         ← 召回 + 组装
│   ├── memory-file-manager.md        ← 写/更新/删除文件
│   └── decay-watcher.md             ← 衰减检查
├── references/
│   ├── remx-cli-commands.md         ← CLI 命令速查（TypeScript 版本）
│   └── memory-writing-guide.md       ← 记忆书写规范
└── scripts/
    └── skill-integration.ts          ← OpenClaw 集成脚本
```

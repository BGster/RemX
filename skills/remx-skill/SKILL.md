---
name: remx-skill
description: RemX 项目记忆管理工具的 OpenClaw Skill 封装。
---

# RemX Skill

项目记忆管理工具的 OpenClaw Skill 封装。

## 定位

RemX 通过向量检索 + 衰减机制，让 AI 在任意时刻都能快速理解项目上下文。它是**项目的外部记忆系统**，不是代码库的一部分。

## 核心概念

| 概念 | 说明 |
|------|------|
| **memory** | 一个文件的唯一记录，含元数据 + 多个 chunk |
| **chunk** | 按标题层级切分的语义单元，每个 H1/H2/H3 是一个 chunk |
| **content_hash** | chunk 内容的 SHA256 前16位；re-index 时内容不变则跳过 embedding |
| **decay** | 配了 decay_group 的记忆按 TTL/stale_after 自动衰减；never 类永不过期 |
| **语义检索** | `--query` 触发向量检索，按 `cosine_similarity × decay_factor` 排序 |

## 内置衰减默认值

meta.yaml 无显式配置时自动应用：

| category | 默认衰减 | 说明 |
|----------|---------|------|
| tmp | ttl=24h | 临时笔记 |
| demand | stale_after=90d | 设计决策 |
| issue | stale_after=60d | 问题/bug |
| knowledge | never | 知识积累 |
| principle | never | 原则规范 |

## CLI 命令（7个）

| 命令 | 功能 |
|------|------|
| `remx init` | 初始化/重建数据库 |
| `remx index` | 索引单个文件（含 --dedup-threshold 语义去重）|
| `remx retrieve` | 过滤/语义检索（--query --decay-weight）|
| `remx gc` | 软删除过期 + 物理清理 deprecated |
| `remx stats` | 数据库健康统计 |
| `remx parse` | 验证 meta.yaml |
| `remx version` | 输出版本 |

完整用法见 `references/remx-cli-user-guide.md`。

## Skill 组件（modules/）

| 组件 | 职责 |
|------|------|
| **MemoryFileManager** | 写 / 更新 / 删除记忆文件，联动 remx index |
| **ChunkSplitter** | 验证 heading 结构，预览切分结果 |
| **ContextAssembler** | 检索记忆并组装成 LLM 可用的上下文 |
| **DecayWatcher** | 检查衰减阈值，对快到期的记忆发出提醒 |

详细接口文档 → `modules/`

## 记忆书写规范

详见 `references/memory-writing-guide.md`，核心规则：

- **分块**：每个 chunk 最大 360 字（约 H1-H3 一个章节）
- **链接**：关联记忆末尾添加双向链接 `标题1 <--> 标题2`
- **稀疏链接**：仅严格依赖关系才链接，避免全连接
- **中转块**：功能记忆块链接超过 3 条时，通过中转记忆块组织

## 快速开始

```bash
# 初始化
remx init --reset --db ./pm.db --meta ./meta.yaml

# 索引
remx index <file> --db ./pm.db --meta ./meta.yaml

# 检索
remx retrieve --filter '{"category": "demand"}' --db ./pm.db --no-embed

# 语义搜索
remx retrieve --query "认证模块是怎么实现的" --db ./pm.db --meta ./meta.yaml --decay-weight 0.5

# 健康检查
remx stats --db ./pm.db --meta ./meta.yaml
```

## Skill 协作流程

```
用户/Agent 说"记住这个决定"
  → ChunkSplitter.validate() — 检查 heading 结构
  → MemoryFileManager.write() — 写文件 + front-matter + remx index
  → DecayWatcher.check() — 检查衰减，快到期则提醒

用户/Agent 说"我之前关于 X 的决定是什么"
  → ContextAssembler.assemble() — remx retrieve → 组装上下文 → 返回

用户/Agent 说"项目状态怎么样"
  → ContextAssembler.by_filter({category: "demand", status: "open"})
  → DecayWatcher.check() — 报告快过期记忆
```

## 触发时机

| 场景 | 操作 |
|------|------|
| 用户做了技术决策 | 写一条 `demand` 记忆 |
| 发现了一个问题 | 写一条 `issue` 记忆 |
| 临时想法/会议记录 | 写一条 `tmp` 记忆（自动 24h 后衰减）|
| 重要知识积累 | 写一条 `knowledge` 记忆（永不过期）|
| 需要回顾项目上下文 | `ContextAssembler` 检索相关记忆 |
| 每次索引新文件后 | `DecayWatcher` 检查衰减阈值，提醒清理 |

## 配置

主要配置在 `meta.yaml`，参考 `references/remx-cli-user-guide.md#metayaml-配置参考`。

关键项：
- `index_scope` — 定义哪些路径算项目记忆
- `decay_groups` — 定义各类记忆的衰减规则（TTL / stale_after / never）
- `chunk.strategy` — `heading`（默认）或 `paragraph`
- `embedder` — 向量嵌入配置（用于语义检索）

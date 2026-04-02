# RemX Skill

项目记忆管理工具的 OpenClaw Skill 封装。

## 定位

RemX 通过向量检索 + 衰减机制，让 AI 在任意时刻都能快速理解项目上下文。它是**项目的外部记忆系统**，不是代码库的一部分。

## 核心概念

| 概念 | 说明 |
|------|------|
| **memory** | 一个文件的唯一记录，含元数据 + 多个 chunk |
| **chunk** | 按标题层级切分的语义单元，每个 H1/H2/H3 是一个 chunk |
| **decay** | 配了 decay_group 的记忆按 TTL/stale_after 自动衰减 |
| **index_scope** | meta.yaml 中定义的文件范围（项目内 vs 全局）|

## Skill 组件（modules/）

| 组件 | 职责 |
|------|------|
| **MemoryFileManager** | 写 / 更新 / 删除记忆文件，联动 remx index |
| **ChunkSplitter** | 验证 heading 结构，预览切分结果 |
| **ContextAssembler** | 检索记忆并组装成 LLM 可用的上下文 |
| **DecayWatcher** | 检查所有配置的衰减规则，对快到期的记忆发出提醒 |

详细接口文档 → `modules/`

## 备用文档（references/）

| 文档 | 内容 |
|------|------|
| **remx-cli-user-guide.md** | 工具书，CLI 每个命令的完整用法 |
| **memory-writing-guide.md** | 创作指南，如何写出好切割、好检索的记忆文件 |

## 快速开始

**1. 初始化**
```bash
remx init --reset --db ./pm.db --meta ./meta.yaml
```

**2. 写记忆文件**（参考 `references/memory-writing-guide.md`）

**3. 索引**
```bash
remx index <file> --db ./pm.db --meta ./meta.yaml
```

**4. 检索**
```bash
remx retrieve --db ./pm.db --filter '{"category": "demand"}'
```

## Skill 协作流程

```
用户/Agent 说"记住这个决定"
  → ChunkSplitter.validate() — 检查 heading 结构
  → MemoryFileManager.write() — 写文件 + front-matter + remx index
  → DecayWatcher.check() — 检查 TTL，快到期则提醒

用户/Agent 说"我之前关于 X 的决定是什么"
  → ContextAssembler.assemble() — remx retrieve → 组装上下文 → 返回给 Agent
```

## 触发时机

| 场景 | 操作 |
|------|------|
| 用户做了技术决策 | 写一条 `demand` 记忆 |
| 发现了一个问题 | 写一条 `issue` 记忆 |
| 临时想法/会议记录 | 写一条 `tmp` 记忆（会自动 decay）|
| 需要回顾项目上下文 | `ContextAssembler` 检索相关记忆 |
| 每次索引新文件后 | `DecayWatcher` 检查衰减阈值，提醒清理 |

## 配置

主要配置在 `meta.yaml`，参考 `references/remx-cli-user-guide.md#metayaml-配置参考`。

关键项：
- `index_scope` — 定义哪些路径算项目记忆
- `decay_groups` — 定义各类记忆的衰减规则（TTL / stale_after / never）
- `chunk.strategy` — `heading`（默认）或 `paragraph`

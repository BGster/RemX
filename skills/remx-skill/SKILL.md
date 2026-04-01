# RemX Skill

项目记忆管理工具的 OpenClaw Skill 封装。

## 定位

RemX 通过向量检索 + 衰减机制，让 AI 在任意时刻都能快速理解项目上下文。它是**项目的外部记忆系统**，不是代码库的一部分。

## 核心概念

| 概念 | 说明 |
|------|------|
| **memory** | 一个文件的唯一记录，含元数据 + 多个 chunk |
| **chunk** | 按标题层级切分的语义单元，每个 H1/H2/H3 是一个 chunk |
| **decay** | TMP 类记忆有 TTL，过期后 GC 清理 |
| **index_scope** | meta.yaml 中定义的文件范围（项目内 vs 全局）|

## 环境准备

### 环境检测
遇到问题先检测环境 → `skills/remx-skill/docs/env-check.md`

快速检查清单、常见问题及诊断命令输出模板

### 环境安装
首次安装时按系统步骤执行 → `skills/remx-skill/docs/env-setup.md`

涵盖：macOS / Linux / Windows 安装步骤，sqlite-vec 编译问题解决方案

## 文档

### 用户指南
CLI 完整命令参考 → `docs/remx-cli-user-guide.md`

涵盖：`remx init / index / retrieve / gc / parse / version`

### 记忆写作指南
如何编写能被精确切割、语义完整检索的记忆文件 → `docs/memory-writing-guide.md`

## 快速开始

**1. 初始化**
```bash
remx init --reset --db ./pm.db --meta ./meta.yaml
```

**2. 写记忆文件**（参考 `docs/memory-writing-guide.md`）

**3. 索引**
```bash
remx index <file> --db ./pm.db --meta ./meta.yaml --no-embed
```

**4. 检索**
```bash
remx retrieve --db ./pm.db --filter '{"category": "demand"}'
```

## Skill 层职责

当 OpenClaw Agent 需要"记住"什么时，通过 Skill 层操作：

```
用户/Agent 说"记住这个决定"
  → Skill: 写文件 → front-matter → remx index
  → 文件被切分为 chunks → 向量化存储

用户/Agent 说"我之前关于 X 的决定是什么"
  → Skill: remx retrieve --filter 检索
  → 组装上下文 → 返回给 Agent
```

具体职责：
- **MemoryFileManager**: 写/更新/删除记忆文件
- **ChunkSplitter**: 验证文件是否按 heading 层级组织，给出切割建议
- **ContextAssembler**: 检索相关 chunks，组装成完整上下文

## 触发时机

| 场景 | 操作 |
|------|------|
| 用户做了技术决策 | 写一条 `demand` 记忆 |
| 发现了一个问题 | 写一条 `issue` 记忆 |
| 临时想法/会议记录 | 写一条 `tmp` 记忆（会自动 decay）|
| 需要回顾项目上下文 | `remx retrieve` 检索相关记忆 |
| 每次索引新文件后 | 检查 GC 阈值，提醒清理 |

## 配置

主要配置在 `meta.yaml`，参考 `docs/remx-cli-user-guide.md#metayaml-配置参考`。

关键项：
- `index_scope` — 定义哪些路径算项目记忆
- `decay_groups` — 定义各类记忆的衰减规则
- `chunk.strategy` — `heading`（默认）或 `paragraph`

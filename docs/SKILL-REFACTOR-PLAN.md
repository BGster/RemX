# RemX Skill 层重构计划

**项目：** RemX  
**日期：** 2026-04-20  
**状态：** 已执行 ✅ → 全部完成

---

## 背景

remx-core CLI 层已完成 Schema 重构（`files`/`chunks`/`remx_lifecycle`），Skill 层需要同步适配。

**CLI 层主要变更：**
- Schema 从 `memories`/`chunks` 迁移至 `files`/`chunks`/`remx_lifecycle`
- 记忆 ID 从 `DEM-001` 格式改为直接使用文件 `path`
- `status: deprecated` 的 front-matter 会自动触发软删除（`deprecated=1`）
- 所有操作通过 `remx <cmd>` CLI，不直接调用源码

---

## 重构目标

### 规范：Skill 层的主动性

| 维度 | 旧行为 | 新行为 |
|------|--------|--------|
| **召回触发** | 等待用户明确说"召回 X" | Agent 每次回答前主动分析上下文相关性，必要时自动召回 |
| **创建触发** | 用户说"记住..."才创建 | Agent 输出包含新决策/结论/方案时自动创建记忆 |
| **更新触发** | 用户说"更新..."才更新 | Agent 发现记忆与事实不符时自动更新 |
| **衰减提醒** | 被动等待 | 每次会话开始时检查衰减状态，主动提醒 |

### 输出规范：答案末尾的参考摘要

每次 Agent 回答后，在末尾追加一行摘要（无记忆操作时省略）：

```
---
📚 召回: path/to/demand-001.md, issues/bug-auth.md
🆕 新建: demands/session-token.md
🔄 更新: demands/auth-module.md
🔗 拓扑: demands/auth-module.md → issues/bug-auth.md (因果关系)
```

---

## 重构内容

### 架构调整

```
Skill 层（remx-skill/）
├── SKILL.md                    ← 主定义文件（重写）
├── modules/
│   ├── memory-manager.md       ← 新增：语义分析 + 自主决策
│   ├── context-assembler.md    ← 重写：remx retrieve --filter/--query
│   ├── memory-file-manager.md  ← 小修：适配新 delete 流程
│   └── decay-watcher.md        ← 小修：适配 path 作为 ID
├── references/
│   ├── remx-cli-commands.md   ← 新增：CLI 命令速查（TS 版本）
│   └── memory-writing-guide.md ← 修订：front-matter 新规范
└── scripts/
    └── skill-integration.ts    ← 新增：CLI 包装 + formatSummary
```

### 关键变更

| 模块 | 变更 |
|------|------|
| `memory_id` | `DEM-001` 格式 → 直接用文件 `path` 作为 ID |
| 软删除触发 | `remx gc --purge` → front-matter `status: deprecated` + `remx index` |
| 向量检索 | Python embedder → `remx retrieve --query` + ollama bge-m3 |
| 拓扑节点 | `memory_nodes` 同步 → `ensureNode` 同步 |
| delete 流程 | `remx gc --purge --scope` → front-matter 设置 `status: deprecated` 后 `remx index` |

---

## 执行步骤

| 步骤 | 内容 | 产出 | 状态 |
|------|------|------|------|
| 1 | 梳理 Skill 层所有现有文档 | 变更清单 | ✅ |
| 2 | 新增 `references/remx-cli-commands.md` | TypeScript CLI 命令速查 | ✅ |
| 3 | 重写 `SKILL.md`（主动性 + 输出规范）| 新 SKILL.md | ✅ |
| 4 | 新增 `modules/memory-manager.md` | 决策引擎 | ✅ |
| 5 | 重写 `modules/context-assembler.md` | 适配 `remx retrieve` | ✅ |
| 6 | 小修 `modules/decay-watcher.md` | 适配 `remx stats` 输出 | ✅ |
| 7 | 小修 `modules/memory-file-manager.md` | delete 改为 `status: deprecated` | ✅ |
| 8 | 修订 `references/memory-writing-guide.md` | 新 front-matter 规范 | ✅ |
| 9 | 新增 `scripts/skill-integration.ts` | CLI 包装 + formatSummary | ✅ |
| 10 | git commit + push | 推送变更 | ✅ |

---

## 验收标准

1. **主动性**：Skill 触发记忆操作时，用户无需主动提醒
2. **摘要格式**：每次有操作时，答案末尾正确显示 `📚 🆕 🔄 🔗` 格式摘要
3. **CLI 强制**：所有记忆操作通过 `remx` CLI，不直接调用源码
4. **Schema 兼容**：Skill 层正确使用 `path` 作为记忆 ID、`status: deprecated` 触发软删除
5. **衰减提醒**：会话开始时能正确报告快到期记忆

**验收结果：** ✅ 全部满足

---

## Commit 历史

- `22e521e` — skill: refactor remx-skill to TypeScript CLI, add proactive memory management

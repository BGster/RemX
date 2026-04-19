# RemX CLI 架构分析报告

**项目：** RemX  
**日期：** 2026-04-20  
**作者：** Nova  
**状态：** 草稿

---

## 一、问题概述

本次测试（vec0 扩展加载失败）暴露的不只是一个 bug，而是**架构层面代码重复和边界模糊**的系统性问题。同类代码分散在多个文件中，各有各的实现细节，时间久了必然产生不一致。

---

## 二、问题清单

> ⚠️ **v0.3.0 重构状态（2026-04-20）**：以下问题已通过重构修复，文档保留作为历史参考。

### P1 — `getDb()` 重复定义（✅ 已修复）

**v0.3.0 之前涉及文件：**
- `src/runtime/db.ts`
- `src/memory/crud.ts`
- `src/memory/topology.ts`
- `src/memory/recall.ts`
- `src/runtime/triple-store.ts`

**v0.3.0 修复：** 统一抽取到 `src/shared/db.ts`，所有文件改为 `import { getDb, DEFAULT_DB } from "../shared/db"`。

---

### P2 — 拓扑表定义重复（P2）（✅ 已修复）

**v0.3.0 之前涉及文件：** `topology.ts`、`triple-store.ts`、`db.ts`

**v0.3.0 修复：** 拓扑表 DDL 统一移入 `initDb()`。`topology.ts` 重命名为 `graph.ts`。`runtime/` 目录删除，`triple-store.ts` 删除。

---

### P3 — 职责边界模糊（P2）（✅ 已修复）

**v0.3.0 重构后结构：**
```
src/
├── memory/
│   ├── graph.ts     ← 图结构 + 遍历（三表 CRUD）← topology.ts 改名
│   ├── memory.ts    ← CRUD + GC + retrieve（合并自 crud.ts + db.ts）
│   └── recall.ts    ← 召回逻辑
├── core/            ← 纯文本处理层
└── commands/        ← 命令层
```

`runtime/` 目录删除，`triple-store.ts` 删除。

---

### P4 — `initDb` / `initSchema` 职责不清（P2）（✅ 已修复）

**v0.3.0 修复：** `initSchema()` 删除，`initDb()` 统一建所有表（包括拓扑表）。`runtime/` 删除。

---

### P5 — `DEFAULT_DB` 路径重复（P3）（✅ 已修复）

**v0.3.0 修复：** 统一到 `src/shared/db.ts` 导出，`memory/memory.ts`、`memory/graph.ts`、`memory/recall.ts` 均 import 自此处。

---

### P6 — `recall.ts` 的 `semanticRecall` 是空 stub（P3）（✅ 已修复）

**v0.3.0 修复：** `retrieveSemantic()` 保留在 `memory/memory.ts`，`recall.ts` 专注 decay/freshness scoring 和 topology expansion。

---

## 三、根因分析

**为什么会出现这些问题？**

1. **渐进式移植：** 从 Python (`db.py`) 移植到 TypeScript 时按职责拆分，但没人统一 review 全局 import 图，导致每个文件都自己开一个 `getDb()`
2. **没有架构约束：** 没有architectural decision record，没有禁止从同一模块外的文件引用 `better-sqlite3` 的规则
3. **没有强制的一致性检查：** 没有 lint 规则（即使写了也很容易 bypass）

**本质：缺少「数据库连接是单例资源」的概念。** 应该只有一个地方创建 `Database` 实例，所有模块复用。

---

## 四、修复方案

### R1 — 抽取共享 `getDb()` 到 `src/shared/db.ts`（P1）

```
src/shared/db.ts          ← 唯一：getDb()、findVecExtension()、DEFAULT_DB
    ↑
    ├── memory/crud.ts   (删除自己的 getDb)
    ├── memory/topology.ts (删除自己的 getDb)
    ├── memory/recall.ts   (删除自己的 getDb)
    ├── runtime/db.ts      (删除自己的 getDb)
    └── runtime/triple-store.ts (删除自己的 db())
```

**实施步骤：**
1. 创建 `src/shared/db.ts`，包含：
   - `DEFAULT_DB` 常量
   - `findVecExtension()` 函数
   - `getDb()` 函数（统一行为：WAL + foreign_keys + vec0 加载）
2. 5 个文件全部改为 `import { getDb, DEFAULT_DB } from "../shared/db"`
3. 删除各文件自己的 `getDb()` 和 `DEFAULT_DB`

**注意：** `runtime/db.ts` 的 `getDb()` 还要负责初始化 vec0 表（`CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0`）。这是 `initDb()` 的职责，不是 `getDb()` 的。`getDb()` 只负责连接保持。

### R2 — 统一拓扑建表逻辑（P2）

**问题：** `topology.ts` 隐式依赖表存在，`triple-store.ts` 有显式 SQL 定义但从不调用。

**方案：** 将拓扑表 DDL 移到 `runtime/db.ts` 的 `initDb()` 中，与 `files/chunks/remx_lifecycle` 同一处创建。删除 `triple-store.ts` 中的 `TOPOLOGY_TABLES_SQL`（保留 CURD 函数本身）。

```
initDb() 结构：
  1. CREATE TABLE files
  2. CREATE TABLE chunks
  3. CREATE TABLE remx_lifecycle
  4. CREATE VIRTUAL TABLE chunks_vec USING vec0
  5. CREATE TABLE memory_nodes          ← 从 triple-store 移入
  6. CREATE TABLE memory_relations       ← 从 triple-store 移入
  7. CREATE TABLE memory_relation_participants ← 从 triple-store 移入
  8. CREATE INDEX ...
```

`initSchema()` 从 `runtime/triple-store.ts` 中删除，改为从 `runtime/db.ts` 的 `initDb()` 调用。

### R3 — 删除 `recall.ts` 的重复 `getDb()`（P3）

`recall.ts` 自己的 `getDb()` 只被自己用，改成 import 共享的即可。

### R4 — 删除 `triple-store.ts` 的重复 `db()`（P3）

`triple-store.ts` 有一个私有的 `db()`，改用共享 `getDb()`。

### R5 — `semanticRecall` stub 处理（P3）

两个选择：
- **选项 A：** 在 `recall.ts` 里实现真正的语义检索（调用 `retrieveSemantic` from `runtime/db.ts`）
- **选项 B：** 删除 `recall.ts` 的 `semanticRecall`，让外部直接用 `runtime/db.ts` 的 `retrieveSemantic`

**推荐选项 B** — `recall.ts` 的价值在于 decay/freshness scoring 和 topology expansion，不在语义检索。

---

## 五、v0.3.0 重构执行记录

> ✅ **2026-04-20 重构完成**

| 阶段 | 内容 | 状态 |
|------|------|------|
| Phase 0 | 创建 `v0.3.0-refactor` 分支 | ✅ |
| Phase 1 | `topology.ts` → `graph.ts` | ✅ |
| Phase 2 | `crud.ts` + `db.ts` → `memory.ts` | ✅ |
| Phase 3 | 删除 `runtime/triple-store.ts` | ✅ |
| Phase 4 | 删除 `runtime/` 目录 | ✅ |
| Phase 5 | 更新 `recall.ts` imports | ✅ |
| Phase 6 | 更新测试（`topology.test.ts` → `graph.test.ts`，删除 `triple-store.test.ts`）| ✅ |
| Phase 7 | 更新文档（CLI-TEST-PLAN.md、ARCHITECTURE-ANALYSIS.md）| ✅ |
| Phase 8 | `npm run build` + `npm test` 全量验收 | ✅ |

**最终结构：**
```
remx-core/src/
├── memory/
│   ├── graph.ts       ← 图结构 + 遍历（三表 CRUD）
│   ├── memory.ts      ← CRUD + GC + retrieve
│   └── recall.ts      ← 召回逻辑
├── core/              ← 纯文本处理层
├── shared/db.ts        ← 统一 getDb/DEFAULT_DB
└── commands/           ← 命令层
```

**测试结果：** 43 tests, 1 test file（`graph.test.ts`）, 全部通过

---

## 六、优先级建议

| 优先级 | 问题 | 理由 |
|--------|------|------|
| P1 | `getDb()` 不一致 | **正在导致功能失败**，不修完后面都会受影响 |
| P2 | 拓扑建表重复/缺失 | `topology.ts` 依赖隐式建表，极可能在某些场景下失败 |
| P3 | `recall.ts` stub + `DEFAULT_DB` 重复 | 技术债，不直接导致错误 |

**建议立即执行 Phase 1（止血），再推进 Phase 2（共享层）。Phase 3/4 可以放在后续迭代。**

---

## 七、验证方式

修复后执行完整测试套件：
```bash
cd /home/claw/RemX
export REMX_DB=/tmp/remx-skill-test.db
export REMX_META=$(pwd)/remx-core/tests/fixtures/meta.yaml

# 重建数据库
remx init --db "$REMX_DB" --meta "$REMX_META" --reset

# 索引测试记忆
remx index remx-core/tests/fixtures/memories/demand/user-auth-demand.md --db "$REMX_DB" --meta "$REMX_META"
remx index remx-core/tests/fixtures/memories/knowledge/jwt-knowledge.md --db "$REMX_DB" --meta "$REMX_META"
remx index remx-core/tests/fixtures/memories/issue/auth-bug-issue.md --db "$REMX_DB" --meta "$REMX_META"

# 拓扑
remx relate insert --db "$REMX_DB" --nodes "remx-core/tests/fixtures/memories/demand/user-auth-demand.md,remx-core/tests/fixtures/memories/issue/auth-bug-issue.md" --rel-type 因果关系 --roles cause,effect --context main_session

# 全流程验证
remx gc --db "$REMX_DB" --dry-run
remx retrieve --db "$REMX_DB" --meta "$REMX_META" --query "JWT Token"
remx retrieve --db "$REMX_DB" --filter '{"category":"demand"}'
remx stats --db "$REMX_DB"
remx relate query --db "$REMX_DB" --node-id remx-core/tests/fixtures/memories/demand/user-auth-demand.md
```

所有命令退出码为 0 且输出符合预期 = 重构成功。

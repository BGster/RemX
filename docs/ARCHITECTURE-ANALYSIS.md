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

### P1 — `getDb()` 重复定义（已修复）

**涉及文件：**
- `src/runtime/db.ts`（有 vec0 加载）
- `src/memory/crud.ts`（无 vec0 加载）← 刚修
- `src/memory/topology.ts`（无 vec0 加载）
- `src/memory/recall.ts`（无 vec0 加载）
- `src/runtime/triple-store.ts`（独立实现，无 vec0）

**现状：** 共 5 处 `getDb()` 实现，行为不一致。

| 文件 | vec0 加载 | foreign_keys | WAL |
|------|-----------|-------------|-----|
| `runtime/db.ts` | ✅ | ✅ | ✅ |
| `memory/crud.ts` | ✅（刚修）| ✅ | ✅ |
| `memory/topology.ts` | ❌ | ❌ | ✅ |
| `memory/recall.ts` | ❌ | ❌ | ✅ |
| `runtime/triple-store.ts` | ❌ | ❌ | ✅ |

**风险：** 未加载 vec0 的 `getDb()` 调用 `DELETE FROM chunks_vec` 会报错；未开启 `foreign_keys` 的无法依赖外键级联删除。

---

### P2 — 拓扑表定义重复（P2）

**涉及文件：**
- `src/memory/topology.ts`：自己建表（`memory_nodes`、`memory_relations`、`memory_relation_participants`）但不包含 `CREATE TABLE` 语句
- `src/runtime/triple-store.ts`：也有自己的拓扑表定义（`TOPOLOGY_TABLES_SQL`）
- `src/runtime/db.ts` 的 `initDb()`：只建 `files/chunks/remx_lifecycle`，不建拓扑表

**问题：** 拓扑表有两套定义。一套在 `topology.ts` 运行时隐式依赖（通过 INSERT 推断表存在），另一套在 `triple-store.ts` 的 `TOPOLOGY_TABLES_SQL`。`init.ts` 调用 `initSchema()`（来自 triple-store），不调用 `topology.ts` 的初始化。

**实际行为：** `remx init` → `initSchema(triple-store)` → 只建 triple-store 的表。`topology.ts` 的表（如 `memory_nodes`）从未被 `CREATE TABLE`，但系统能工作是因为 `topology.ts` 的 `ensureNode` 做了 `INSERT OR IGNORE`，假设表已存在。

**结论：** `topology.ts` 依赖一个从未显式创建的关系 schema。

---

### P3 — 职责边界模糊（P2）

**具体表现：**

1. **`topology.ts` vs `triple-store.ts` — 谁是拓扑的正确位置？**
   - `topology.ts` 是拓扑逻辑的核心，有 `ensureNode`、`queryRelations`、`insertRelation`
   - `triple-store.ts` 是 CLI 封装，暴露 `insertTriple`、`queryTriples`
   - 但 `topology.ts` 的函数直接操作 DB，**没有调用** triple-store 的 schema init
   - 两者共用同一套表，但谁负责建表？不清楚

2. **`crud.ts` vs `runtime/db.ts` — 谁负责写 memory？**
   - `runtime/db.ts` 有 `upsertVector`（写向量）、`retrieve`（检索）、`gcCollect`（GC）
   - `crud.ts` 有 `upsertMemory`、`upsertChunk`（写文件元数据）
   - `core/index.ts` 两边都调用：`_writeMemoryToDb` 调用 `crud.ts`，语义检索调用 `runtime/db.ts`

3. **`recall.ts` — 孤岛状态**
   - 自己的 `getDb()`，自己的 `DEFAULT_DB_PATH`
   - `semanticRecall()` 目前是 stub（空实现）
   - 没有被任何命令直接调用，测试也测不到它

---

### P4 — `initDb` / `initSchema` 职责不清（P2）

**当前 init 调用链：**
```
remx init
  → runtime/init.ts: initDb()         [runtime/db.ts]  ← 建 files/chunks/remx_lifecycle + chunks_vec
  → runtime/init.ts: initSchema()     [runtime/triple-store.ts] ← 建 memory_nodes/memory_relations/...
```

**问题：**
- `initDb()` 建 RemX 核心表（files/chunks/lifecycle/vec0）
- `initSchema()` 建拓扑表（memory_nodes/memory_relations/...）
- 两个 init 在同一个 command 文件里顺序调用，但 schema 设计上这是两个独立的地方
- **拓扑表从未被 `initDb()` 建**，完全依赖 `initSchema()`，而 `initSchema()` 只在 `remx init` 时被调用

---

### P5 — `DEFAULT_DB` 路径重复（P3）

| 位置 | DEFAULT_DB |
|------|-----------|
| `runtime/db.ts` | `.openclaw/memory/main.sqlite` |
| `memory/crud.ts` | `.openclaw/memory/main.sqlite` |
| `topology.ts` | `.openclaw/memory/main.sqlite` |
| `recall.ts` | `.openclaw/memory/main.sqlite` |
| `triple-store.ts` | `.openclaw/memory/main.sqlite` |

5 处重复。改成统一常量后，改路径只需改一处。

---

### P6 — `recall.ts` 的 `semanticRecall` 是空 stub（P3）

`semanticRecall()` 直接返回空数组，没有任何实现。所有语义检索实际通过 `runtime/db.ts` 的 `retrieveSemantic()`，两者功能重叠。

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

## 五、实施计划

### Phase 1：止血（不改架构，只修 bug）

- [x] P1 fix：`crud.ts` 加载 vec0（已提交）
- [ ] P1 fix：`topology.ts` 加载 vec0 + foreign_keys
- [ ] P1 fix：`recall.ts` 加载 foreign_keys
- [ ] P1 fix：`triple-store.ts` 加载 foreign_keys

### Phase 2：抽取共享层（中等风险，可独立测试）

- [ ] 创建 `src/shared/db.ts`
- [ ] 改造 5 个文件都 import shared/db
- [ ] 验证 `remx init / index / retrieve / gc / relate` 全流程正常

### Phase 3：清理拓扑建表（需要完整测试）

- [ ] 将拓扑表 DDL 移入 `runtime/db.ts`
- [ ] `initDb()` 同时建 RemX 表 + 拓扑表
- [ ] 删除 `TOPOLOGY_TABLES_SQL` 和 `initSchema()`
- [ ] 验证 `remx init` 后拓扑功能正常

### Phase 4：清理死代码

- [ ] 评估 `recall.ts` 定位，删除冗余 semanticRecall 或实现它
- [ ] 统一 `DEFAULT_DB` 路径常量

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

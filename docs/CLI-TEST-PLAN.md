# RemX CLI 测试方案

**项目：** RemX  
**日期：** 2026-04-19 → 2026-04-20  
**状态：** 草稿 → **全部验证通过 ✅**

---

## 背景

remx-core 已通过 vitest 单元测试覆盖核心模块（`triple-store.ts`、`topology.ts`）。本测试方案将这些覆盖映射到 CLI 命令行接口，确保每个 CLI 命令在端到端场景下可正常工作。

**已有单元测试覆盖（vitest）：**
- `graph.test.ts` — Constants / Node CRUD / Relation CRUD / Graph BFS / Context Matching / Topology-Aware Recall (renamed from `topology.test.ts`)

**最新测试结果：43 tests, 1 test file, 全部通过 ✅**

**Schema 重构说明（2026-04-19）：**
remx-core 存储层已从旧 `memories`/`chunks` 表迁移至 OpenClaw 对齐的 `files`/`chunks`/`remx_lifecycle` 模型。相关单元测试不受影响（测试夹具独立初始化）。

---

## 测试 Fixtures（已创建 ✅）

```
tests/fixtures/
├── meta.yaml              ← 标准 embedder + vector + chunk + decay 配置
└── memories/
    ├── demand/
    │   ├── user-auth-demand.md
    │   └── api-design-demand.md
    ├── issue/
    │   └── auth-bug-issue.md
    ├── knowledge/
    │   ├── jwt-knowledge.md
    │   └── oauth2-knowledge.md
    ├── principle/
    │   └── api-versioning-principle.md
    └── tmp/
        └── meeting-notes-tmp.md   ← deprecated 状态（供 gc 测试）
```

**Fixture 验证结果：**
- `remx parse --meta tests/fixtures/meta.yaml` ✅ 解析成功
- `remx init --db /tmp/remx-cli-test-fixture.db --meta tests/fixtures/meta.yaml` ✅ 初始化成功
- `remx stats --db /tmp/remx-cli-test-fixture.db` ✅ 统计输出正常

---

## CLI 命令清单

| 命令 | 说明 |
|------|------|
| `remx init` | 初始化数据库 schema |
| `remx retrieve` | 检索记忆（过滤模式 / 语义模式）|
| `remx relate` | 管理拓扑关系（nodes / insert / delete / query / graph）|
| `remx stats` | 显示记忆统计（分类数量、数据库大小、时间范围）|
| `remx parse` | 加载并验证 meta.yaml |
| `remx gc` | 垃圾回收过期 / 已废弃记忆 |
| `remx index` | 索引记忆 |

---

## 测试用例

### TC-1：`remx init`

**前置条件：** 干净的临时数据库路径 `/tmp/remx-cli-test.db`

**测试步骤：**
```bash
remx init --db /tmp/remx-cli-test.db --meta tests/fixtures/meta.yaml
```

**预期结果：**
- 命令成功退出（exit 0）
- 数据库文件被创建
- 输出包含 `database initialized` 字样

**边界：**
- 重复初始化（不传 `--reset`）不应报错
- 传入 `--reset` 应清空已有表后重建

---

### TC-2：`remx retrieve`（过滤模式）

**前置条件：** 数据库中有若干记忆记录（由 `remx init` 初始化）

**测试步骤：**
```bash
remx retrieve --db /tmp/remx-cli-test.db --filter '{"category":"knowledge"}' --limit 10
```

**预期结果：**
- 返回 JSON 数组
- 每条记录包含 `id`, `category`, `content` 等字段
- 结果数量不超过 `--limit`

**边界：**
- `category` 不存在时返回空数组 `[]`
- 无 `--filter` 时返回全部记录

---

### TC-3：`remx retrieve`（语义模式）

**前置条件：** `meta.yaml` 配置了 embedder

**测试步骤：**
```bash
remx retrieve --db /tmp/remx-cli-test.db --meta tests/fixtures/meta.yaml --query "用户偏好" --limit 5
```

**预期结果：**
- 命令成功返回 JSON
- 输出包含语义相似度分数

**注意：** 语义模式需要 embedder 配置，无配置时应报错退出

---

### TC-4：`remx relate nodes`

**测试步骤：**
```bash
remx relate nodes --db /tmp/remx-cli-test.db
```

**预期结果：**
- 列出所有拓扑节点（JSON 数组）
- 每个节点包含 `id`, `category`, `chunk`

---

### TC-5：`remx relate insert`

**测试步骤：**
```bash
remx relate insert \
  --db /tmp/remx-cli-test.db \
  --nodes "nodeA,nodeB" \
  --rel-type "因果关系" \
  --roles "cause,effect"
```

**预期结果：**
- 成功返回数字 `relId`
- 关系可被 `remx relate query` 查询到

**边界：**
- 无效 `--rel-type` → 报错
- 无效 `--role` → 报错
- 节点数与角色数不匹配 → 报错
- 少于 2 个节点 → 报错

---

### TC-6：`remx relate query`

**前置条件：** 存在已知拓扑关系

**测试步骤：**
```bash
remx relate query --db /tmp/remx-cli-test.db --node-id nodeA
```

**预期结果：**
- 返回与 `nodeA` 相关的所有关系（JSON 数组）
- 每条关系包含 `rel_type`, `participants`, `context`

---

### TC-7：`remx relate graph`

**前置条件：** 存在已知拓扑关系链

**测试步骤：**
```bash
remx relate graph --db /tmp/remx-cli-test.db --node-id nodeA --max-depth 3
```

**预期结果：**
- BFS 遍历返回从 `nodeA` 起 `max-depth` 跳内的所有可达节点
- 每条记录标注 `depth`（距离）

---

### TC-8：`remx relate delete`

**前置条件：** 存在已知 `relId`

**测试步骤：**
```bash
remx relate delete --db /tmp/remx-cli-test.db --rel-id <已知ID>
```

**预期结果：**
- 删除后 `remx relate query` 查不到该关系
- 其他关系不受影响

---

### TC-9：`remx stats`

**测试步骤：**
```bash
remx stats --db /tmp/remx-cli-test.db
```

**预期结果：**
- 输出各分类（knowledge / demand / issue / principle / tmp）的记忆数量
- 显示数据库文件大小
- 显示最早和最晚记忆时间

---

### TC-10：`remx parse`

**前置条件：** 存在有效的 `meta.yaml`

**测试步骤：**
```bash
remx parse --meta tests/fixtures/meta.yaml
```

**预期结果：**
- 输出 JSON 格式的解析结果
- 包含 `embedder`, `vector`, `chunk`, `decay` 等配置

**边界：**
- 无效 / 不存在的 `meta.yaml` → 报错退出

---

### TC-11：`remx gc --dry-run`

**前置条件：** 数据库中有过期记忆

**测试步骤：**
```bash
remx gc --db /tmp/remx-cli-test.db --dry-run
```

**预期结果：**
- 列出将被回收的记忆（不实际删除）
- 显示回收数量统计

---

### TC-12：`remx gc --purge`

**前置条件：** 数据库中有已废弃记忆

**测试步骤：**
```bash
remx gc --db /tmp/remx-cli-test.db --purge --scope-path /tmp/remx-cli-test.db
```

**预期结果：**
- 实际删除标记为 deprecated 的记忆
- 输出回收数量

---

### TC-13：`remx index`

**测试步骤：**
```bash
remx index --db /tmp/remx-cli-test.db --meta tests/fixtures/meta.yaml --path /some/memory/dir
```

**预期结果：**
- 扫描指定目录的记忆文件
- 建立嵌入向量索引
- 输出索引统计（处理条数、耗时）

---

## 测试 Fixtures

测试所需的 fixtures 放在 `tests/fixtures/`：

```
tests/fixtures/
├── meta.yaml              # 标准的 embedder + vector + chunk + decay 配置
└── memories/              # 样例记忆文件（供 index 测试用）
    ├── demand/
    ├── issue/
    ├── knowledge/
    ├── principle/
    └── tmp/
```

---

## 成功标准

| ID | 检查项 | 状态 | 说明 |
|----|--------|------|--------|
| TC-1 | `remx init` 成功创建数据库 | ✅ | |
| TC-2 | `remx retrieve --filter` 过滤结果正确 | ✅ | 返回 4 个 chunks |
| TC-3 | `remx retrieve --query` 语义搜索（ollama bge-m3）| ✅ | deprecated 记忆不出现在结果中 |
| TC-4 | `remx relate nodes` 列出拓扑节点 | ✅ | 节点由 `ensureNode` 同步 |
| TC-5 | `remx relate insert` 插入拓扑关系 | ✅ | 节点需先存在（via `ensureNode`）|
| TC-6 | `remx relate query` 查询拓扑关系 | ✅ | |
| TC-7 | `remx relate graph` BFS 遍历 | ✅ | |
| TC-8 | `remx relate delete` 删除关系 | ✅ | |
| TC-9 | `remx stats` 统计信息 | ✅ | |
| TC-10 | `remx parse` 解析 meta.yaml | ✅ | |
| TC-11 | `remx gc --dry-run` 识别过期/废弃记忆 | ✅ | 识别到 1 条 deprecated tmp 记忆（meeting-notes-tmp.md）|
| TC-12 | `remx gc --purge` 清理废弃记忆 | ✅ | tmp 被清理，knowledge 不受影响 |
| TC-13 | `remx index` 索引记忆文件 | ✅ | 自动写入 files+remx_lifecycle+chunks |
| vitest | 43 tests, 1 test file | ✅ | graph |


**Bug 记录（2026-04-19）：**

| # | 位置 | 问题 | 状态 |
|---|------|------|------|
| 1 | `src/runtime/db.ts` `MEMORIES_COL_DEFS` | 缺 `chunk_count` 列 | ✅ 已修复 |
| 2 | `src/core/index.ts` `docType` | 默认 `null` 违反 NOT NULL 约束 | ✅ 已修复 |
| 3 | `src/runtime/db.ts` `CHUNKS_COL_DEFS` | 缺 `embedding` 列 | ✅ 已修复 |
| 4 | `src/commands/init.ts` | `initDb` 不初始化 triple-store schema | ✅ 已修复 |
| 5 | `createMemory`/`upsertMemory` | 不同步到 `memory_nodes`，`relate` 命令找不到节点 | ✅ 已修复 |
| 6 | `ensureNode` 调用 | 参数类型不匹配（`dbPath` 可能为 `undefined`） | ✅ 已修复 |
| 7 | `index` 命令 | `--meta` 必需但未传时报错信息不明确 | ✅ 已记录（设计约束） |
| 8 | `initSchema` vs `initDb` | 两套 schema 独立初始化，`init` 只调了 `initDb` | ✅ 已修复 |
| 9 | `src/runtime/db.ts` `CHUNKS_COL_DEFS` | SQLite+vec0 FK 解析 bug：`ON DELETE CASCADE` 在最后时 `deprecated` 列被吞掉 | ✅ 已修复（`deprecated` 移到 FK 前面） |
| 10 | `src/runtime/db.ts` `CHUNKS_COL_DEFS` | `embedding TEXT NOT NULL` 导致无 embedding 时插入失败 | ✅ 已修复（改为 nullable） |
| 11 | `src/runtime/db.ts` `findVecExtension` | vec0 扩展路径错误（`../../node_modules`，Monorepo 应为 `../../../node_modules`） | ✅ 已修复 |
| 12 | `src/core/index.ts` `_checkSemanticDedup` | vec0 读取用 JSON.parse 但 vec0 实际存 Float32 Buffer | ✅ 已修复 |
| 13 | `src/core/index.ts` `_writeMemoryToDb` | `upsertMemory`/`upsertChunk` 接口未更新（仍用旧 `id`/`parent_id`） | ✅ 已修复 |
| 14 | `src/memory/crud.ts` | CRUD 仍操作旧 `memories` 表（未适配 `files`/`remx_lifecycle`） | ✅ 已重写 |
| 15 | `src/commands/stats.ts` | 查询 `memories` 表未适配新 schema | ✅ 已重写 |
| 16 | `src/runtime/db.ts` `getDb` | 未加载 sqlite-vec 扩展，导致 `upsertVector` 失败 | ✅ 已修复 |
| 17 | `src/runtime/db.ts` `upsertVector` | vec0 要求 Float32Array/Buffer，传入普通数组报错 | ✅ 已修复 |
| 18 | `src/runtime/db.ts` `upsertVector` | `embedding TEXT NOT NULL` 导致无 embedding 时报错 | ✅ 已修复 |
| 19 | `src/core/index.ts` `_buildMemoryAndChunks` | front-matter `status: deprecated` 未映射到 `deprecated=1`（软删除）| ✅ 已修复 |

**Bug 5 修复详解（已过时 — 2026-04-19 重构后废弃）：**

> ⚠️ 以下方案已被后续 Schema 重构取代。CRUD 层已全面重写为 `files`/`remx_lifecycle` 模型，`memory_nodes` 节点由 `createMemory`/`upsertMemory` 末尾的 `ensureNode()` 同步创建，不再依赖旧 `memories` 表。

**历史问题根因：** `memories` 表和 `memory_nodes` 表是两套独立 schema。`createMemory` 只写 `memories`，`relate` 命令查 `memory_nodes`，导致索引后 `relate nodes` 永远为空。


**历史修复方案（2026-04-19 早间）：** 在 `createMemory` 和 `upsertMemory` 末尾加 `ensureNode()` 调用，每次创建/更新记忆时自动在 `memory_nodes` 中创建对应节点。

**最终修复：** CRUD 层 2026-04-19 晚间全面重写，统一使用 `files`/`remx_lifecycle` 模型，记忆与拓扑节点共用 `path` 作为主键，从根本上消除两套 schema 不同步的问题。

**已验证通过：**
- TC-1, TC-2, TC-4, TC-5, TC-6, TC-7, TC-8, TC-9, TC-10, TC-11, TC-12, TC-13 ✅

**设计限制（CLI 层面，无 bug）：**
- TC-3：CLI 无 `remx parse --file` 命令，`parse` 只验证 meta.yaml
- TC-11：CLI 无 `import` 命令（无 JSON 导入接口）
- TC-2 语义搜索：需要 `--meta` 参数且需 embedder 才能用 `--query`

---

## 执行方式

```bash
# 验证 fixtures 可用
remx parse --meta tests/fixtures/meta.yaml
remx init --db /tmp/test.db --meta tests/fixtures/meta.yaml

# 运行单个 CLI 测试（手动）
remx stats --db /tmp/test.db
remx retrieve --db /tmp/test.db --filter '{"category":"knowledge"}'

# 运行单元测试（vitest）
cd /home/claw/RemX/remx-core
npm test
```

## 单元测试详情（vitest）

**运行方式：**
```bash
cd /home/claw/RemX/remx-core
npm test          # 全部测试
npx vitest run    # 同上（无 watch 模式）
npx vitest run --reporter=verbose  # 详细输出
```

**测试文件：**
- `tests/graph.test.ts` — 覆盖 `src/memory/graph.ts` (v0.3.0 重命名自 `topology.test.ts`)

**覆盖范围：**

| 模块 | 测试内容 |
|------|---------|
| Schema init | `initDb()` 正确执行、表结构完整 |
| Node CRUD | `ensureNode`/`getNode`/`listNodes`/`deleteNode` |
| Triple CRUD | `insertTriple` |
| REL_TYPES / REL_ROLES | 常量数组与对象的合法性 |
| Relation CRUD | `insertRelation`/`deleteRelation`/`queryRelations` |
| Graph BFS | `getRelatedNodes` 深度遍历、循环检测、深度计数 |
| Context Matching | `matchContext` null/global/特定上下文匹配 |
| Topology-Aware Recall | `topologyAwareRecall` 扩展结果、去重、深度限制 |

**43 个测试全部通过。**

# RemX 代码评审报告（Fresh Review）

**评审人：** Reviewer subagent | **日期：** 2026-04-02 | **分支：** impl

---

## 评审范围

- 项目背景：`docs/explorer-report.md`、`docs/design-v2.md`、`docs/adr-001-technical-architecture.md`
- 核心文件：`remx/chunker.py`、`remx/db.py`、`remx/index_.py`、`remx/gc_.py`、`remx/gc.py`、`remx/schema.py`、`remx/cli.py`
- 重点：N3（`retrieve()` 字符串 filter）、N7（f-string 未插值警告）

---

## 一、阻塞项（Blocking）

### B1 — N7：f-string 警告消息未插值 ✅ 确认存在

**文件：** `remx/index_.py:104`

```python
print("remx index: {file_path}: warning: {dim_name}='{dim_val}' not in meta.yaml config; allowing anyway",
      file=sys.stderr)
```

**问题：** 这是一个普通字符串（不是 f-string），`{file_path}`、`{dim_name}`、`{dim_val}` 是字面量文本，不会被插值。用户看到的错误消息形如：

```
remx index: {file_path}: warning: {dim_name}='{dim_val}' not in meta.yaml config; allowing anyway
```

完全无法理解。`dim_val` 的实际值被吞掉了。

**修复：** 改为 f-string：
```python
print(f"remx index: {file_path}: warning: {dim_name}='{dim_val}' not in meta.yaml config; allowing anyway",
      file=sys.stderr)
```

---

### B2 — `remx/commands/add.py` 导入了不存在的函数（废弃代码陷阱）

**文件：** `remx/commands/add.py:13`

```python
from ..db import add_memory, gc_expired as db_gc_expired
```

`db.py` 中**不存在** `add_memory` 和 `gc_expired` 函数。当前 `db.py` 只有：
`write_chunk`、`write_memory`、`gc_collect`、`gc_soft_delete`、`gc_purge`、`retrieve`。

`commands/` 目录是 adr-001 遗留的 v1 风格代码（支持 `pm log/demand/issue` 等命令），**从未被 `cli.py` 导入**，属于废弃代码。

**风险：** 如果将来有人尝试启用这个模块，会立即因 ImportError 崩溃。即使是废弃代码，误导性导入也应在清理时移除。

**建议：** 删除整个 `commands/` 目录，或至少移除那些无法解析的导入语句。

---

## 二、改进项（Improvements）

### I1 — N3：`retrieve()` 类型签名与内部处理不匹配

**文件：** `remx/db.py:392`（`retrieve` 函数）

```python
def retrieve(
    db_path: Path,
    filter: dict[str, Any],   # ← 声明接受 dict
    ...
) -> list[dict[str, Any]]:
    ...
    for key, val in filter.items():  # ← 假设是 dict，直接调 .items()
```

**说明：** 设计文档说 filter 可以传字符串，但 `db.py` 的 `retrieve()` 签名就是 `filter: dict`，内部没有 `isinstance(filter, str)` 处理。

**缓解因素：** `retrieve_.py`（CLI 命令层）在调用 `db.retrieve()` **之前**已经把字符串 JSON 解析成了 dict：
```python
# retrieve_.py
if isinstance(filter, str):
    filter = json.loads(filter)  # ← 在到达 db.retrieve() 之前完成
```

所以 **CLI 路径是安全的**，不会触发 bug。

**但直接调用 `db.retrieve()` 的使用者（如 Phase 2 Skill 层）会踩坑**：如果传字符串，会得到：
```
TypeError: string indices must be integers, not 'str'
```

**建议：** 
1. 如果 `db.retrieve()` 要支持字符串（作为文档承诺的 API），改为：
```python
if isinstance(filter, str):
    filter = json.loads(filter)
```
2. 或者将签名改为 `filter: dict[str, Any] | str`，明确 API 契约。

---

### I2 — `para_indices` 字段：内存有值，数据库无列

**文件：** `remx/chunker.py`（Chunk dataclass）vs `remx/db.py`（chunks 表 schema）

`Chunk` dataclass 定义了 `para_indices: list[int]`（chunker.py:60），记录当前 chunk 覆盖哪些段落索引。

但 `db.py` 的 `CHUNKS_COL_DEFS` **没有** `para_indices` 列：
```sql
CREATE TABLE chunks (
    chunk_id, parent_id, chunk_index, content, embedding,
    created_at, updated_at, deprecated  -- ← 无 para_indices
);
```

`write_memory()` 也从不写入这个字段，`retrieve()` 从不返回它。

**影响：**
- `_make_chunks`（paragraph 策略）为每个 chunk 正确计算了 `para_indices`
- `chunk_by_headings`（heading 策略）**从不填充** `para_indices`（始终 `[]`）
- 这个字段永远不会被持久化或读取，实质上是死代码

**建议：** 明确 `para_indices` 的用途——如果不需要，应从 dataclass 中删除以免误导；如果需要，应加数据库列。

---

### I3 — `chunk_by_headings` 中循环变量遮蔽外层变量

**文件：** `remx/chunker.py:280`

```python
chunk_index = 0        # ← 外层 chunk_index（用于 make_chunk_id）
...
for sec in sections:
    ...
    sub_chunks = _split_by_sentences(sec_text, file_path, max_tokens, heading_lvl, heading)
    for sc in sub_chunks:
        chunks.append(sc)
        _chunk_index += 1   # ← 修改的是内层 _chunk_index，不是外层 chunk_index
    continue
```

循环内的局部 `_chunk_index`（值为 0）递增，但外层真正的 `chunk_index` 始终为 0。
`make_chunk_id` 调用时用的是外层 `chunk_index`，这意味着 `_split_by_sentences` 发出的所有子 chunk 都得到相同的 `chunk_id`（`...::0`）！

**实际影响：** 当 heading 单元 token 超限（`sec_tokens > max_tokens`）时，`_split_by_sentences` 返回的多个 sub-chunk 会有**重复的 chunk_id**。由于 chunk_id 是 PRIMARY KEY，后续 insert 会因唯一约束冲突而静默跳过（除非整个事务回滚）。

**建议：** 内层循环应使用 `chunk_index`（去掉 `_` 前缀），或重构消除遮蔽。

---

### I4 — CLI 命令数量：实现 6 个，文档说 8 个

**文件：** `remx/cli.py`

| design-v2.md Phase 1 命令 | CLI 实现 |
|---------------------------|----------|
| `remx parse` | ✅ |
| `remx init` | ✅ |
| `remx index` | ✅ |
| `remx gc` | ✅ |
| `remx retrieve` | ✅ |
| `remx version` | ✅ |
| `remx chunk_info` | ❌ 缺失 |
| `remx file_meta` | ❌ 缺失 |
| `remx tables` | ❌ 缺失 |
| `remx validate` | ❌ 缺失 |

`design-v2.md` 声称 Phase 1 有 8 个命令，实际只实现了 6 个。这不是 bug，但与文档不符。

---

### I5 — `gc.py` 与 `gc_.py` 职责重叠但未整合

| 文件 | 职责 | 被谁使用 |
|------|------|---------|
| `gc.py` | 文件级 tmp 清理（`gc_expired_files`） | `commands/add.py`（废弃代码） |
| `gc_.py` | DB 级 GC（`gc_collect/gc_soft_delete/gc_purge`） | `cli.py gc` 命令 ✅ |

**观察：**
- `gc_.py`（CLI 实际使用的 GC）**不调用** `gc.py` 的文件清理逻辑
- `gc.py` 的 `gc_expired_files` 只被废弃的 `commands/add.py` 使用
- 两条 GC 路径是**完全独立**的：`remx gc` 只清理 DB 中的过期记录，不会清理对应的物理文件

**潜在问题：** `remx gc --purge` 从 DB 中删除了 deprecated 记录，但如果物理文件还存在，下次 `remx index` 会重新索引（幂等性保护）。但如果文件已被手动删除，DB 记录会残留。

---

### I6 — `gc_expired_files` 文件名模式与 `add_tmp` 生成文件名不匹配

**文件：** `gc.py:10` vs `commands/add.py`

```python
# gc.py — 清理 TMP-*.md 文件
for f in tmp_dir.glob("TMP-*.md"):
```

```python
# add_tmp — 生成的文件名（Python 格式化字符串）
file_path = root / user_id / "tmp" / f"{mem_id}.md"
# 例如：zeki/tmp/TMP-001.md
```

`add_tmp` 生成 `TMP-001.md`，能被 `gc_expired_files` 的 `TMP-*.md` glob 匹配。但这只是因为命名巧合（都以 `TMP-` 开头），并非设计上的对应。

---

### I7 — 警告消息中的 `import sys` 冗余声明

**文件：** `remx/chunker.py:254` 和 `remx/chunker.py:438`

```python
import sys  # 局部 import 在函数内部
print(..., file=sys.stderr)
```

这两处 `import sys` 是局部导入（不是文件顶部）。Python 会在每次函数调用时重复查找 `sys` 模块（虽然模块查找会被缓存）。这只是风格问题，不影响功能。

---

## 三、通过项（Passed）

### P1 — `gc_soft_delete` + `gc_purge` 事务性正确

软删除（`deprecated=1`）和物理删除（VACUUM）逻辑清晰，删除顺序正确（chunks → memories），`memories_vec` 的删除通过 chunk_id 关联到正确的记录。

### P2 — `write_memory` 原子性写入

三次写入（memories → chunks → memories_vec）包裹在同一事务中，ROLLBACK 路径正确。

### P3 — `retrieve_.py` 的防御性类型检查

在 CLI 层做了 `isinstance(filter, str)` → `json.loads` 转换，保护了 `db.retrieve()` 的调用链。

### P4 — `chunk_paragraphs_simple` 的 overlap 保护

```python
if overlap_paras >= chunk_size_paras:
    print(f"WARNING: overlap_paras ({overlap_paras}) >= chunk_size_paras ...")
    effective_overlap = 0
```
防止了 `overlap >= chunk_size` 导致的无限循环。

### P5 — `gc_purge` 正确使用 chunk_id 删除向量

```python
chunk_ids = conn.execute(
    "SELECT chunk_id FROM chunks WHERE deprecated = 1"
).fetchall()
for row in chunk_ids:
    conn.execute("DELETE FROM memories_vec WHERE chunk_id = ?", ...)
```
通过 `chunk_id`（而非 `memory_id`）删除 `memories_vec` 记录，与 `write_memory` 的写入 key 一致。

### P6 — `_normalize_path` 目录遍历防护

```python
if ".." in path:
    raise ValueError(f"Path with '..' is not allowed: {path}")
```
防止了显式的 `..` 路径遍历攻击（虽然对编码路径无效，但覆盖了常见场景）。

### P7 — `MetaYaml.decay_group_for()` 逻辑正确

trigger 匹配逻辑处理了 `category` 必填和 `status` 可选的情况，与 `_compute_expires_at` 的调用一致。

### P8 — Schema Pydantic 模型与 db.py 列定义基本对齐

`MetaYaml` 模型的字段与 `db.py` 的 `MEMORIES_COL_DEFS`/`CHUNKS_COL_DEFS` 的大多数字段对应（除了 `para_indices` 死代码问题）。

---

## 四、架构对齐总结

| 检查项 | 状态 |
|--------|------|
| Phase 1 声称 8 命令，实际实现 6 个 | ⚠️ 缺失 4 个（chunk_info/file_meta/tables/validate） |
| `gc.py` vs `gc_.py` 职责重叠 | ⚠️ 未整合，但影响有限（gc_.py 是实际路径） |
| `para_indices` dataclass 有、DB 无列 | ⚠️ 死代码 |
| design-v2 vs adr-001 架构差异 | ⚠️ 两份文档描述了不同系统；impl 分支实现的是 design-v2 风格 |
| `commands/` 目录是废弃代码 | ⚠️ 导入错误但从未被执行 |

---

## 五、优先修复顺序

1. **立即修复 B1（N7）** — 用户直接看到无法理解的警告消息
2. **清理 `commands/` 目录** — 防止将来误用导致 ImportError
3. **修复 I3（chunk_by_headings _chunk_index 遮蔽）** — 导致重复 chunk_id，可能引起数据丢失
4. **明确 `para_indices` 用途** — 是死代码就删除，是有用字段就加 DB 列
5. **补全 Phase 1 缺失的 4 个命令** — 与文档对齐

---

*本报告由 Reviewer subagent 生成，2026-04-02*

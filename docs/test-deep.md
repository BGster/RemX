# RemX v0.2.0 深度测试报告

> 测试工程师：Tester | 日期：2026-04-02 | 环境：WSL2 (Linux 6.6.87)

---

## 1. 测试环境

- **RemX 版本**：v0.2.0
- **Python**：3.14 (via .venv)
- **测试目录**：`/tmp/remx-test`（隔离，不影响原项目）
- **数据库**：SQLite + sqlite-vec（内存数据库）
- **运行方式**：`PYTHONPATH=/home/claw/.openclaw/workspace/RemX python -m remx`
- **分支**：`impl`（无未提交修改）

---

## 2. 命令覆盖测试

### 2.1 `remx init`

**命令**：`remx init --meta meta.yaml --db memory.db --reset`

**输出**：
```
Rebuilt database at memory.db
  Tables: memories, chunks
  Vector table: memories_vec (dimensions=1024)
  Indexes: created
```

**结果**：✅ 通过
- 数据库文件创建成功
- `memories`、`chunks` 表创建正确
- `memories_vec` 虚拟表创建成功
- 索引创建正确

---

### 2.2 `remx index`

**命令**：`remx index test-doc.md --db memory.db --meta meta.yaml --no-embed`

**输出**：
```
remx index: indexed test-doc.md
  memory_id: UNK-C8CAFDC13EED210E
  category: unknown
  chunks: 6
```

**结果**：⚠️ 功能可用，但存在 B1 问题（详见第 3 节）

---

### 2.3 `remx gc --dry-run`

**命令**：`remx gc --db memory.db --dry-run`

**输出**：
```
remx gc --dry-run
  expired (not yet deprecated): 0
  deprecated (already marked): 0
  chunks pending delete: 0
```

**结果**：✅ 通过
- 无过期记录时输出正确
- dry-run 模式正常

**命令**：`remx gc --db memory.db --scope . --dry-run`

**输出**：同上

**结果**：✅ 通过
- scope 过滤正常工作（无匹配过期文件）

---

### 2.4 `remx retrieve`

**命令**：`remx retrieve --db memory.db --filter '{}'`

**输出**：
```json
[
  {
    "id": "UNK-C8CAFDC13EED210E",
    "category": "unknown",
    "file_path": "test-doc.md",
    "chunk_count": 6,
    "content": "# 项目概述\n\n这是一个测试文档...",
    "chunk_id": "project::test-doc.md::0",
    "chunk_index": 0
  },
  // ... 共 6 个 chunk
]
```

**结果**：✅ 通过
- 空 filter 返回所有记录
- JSON 输出格式正确
- LEFT JOIN chunks 正确（每个 memory 对应多个 chunk 行）

**命令**：`remx retrieve --db memory.db --filter '{"category": "unknown"}' --no-content`

**输出**：
```json
[
  {
    "id": "UNK-C8CAFDC13EED210E",
    "category": "unknown",
    ...
    "deprecated": 0
  }
]
```

**结果**：✅ 通过
- filter 条件正确翻译为 SQL WHERE
- --no-content 跳过 content 字段

---

### 2.5 `remx parse`

**命令**：`remx parse meta.yaml`

**输出**：完整 JSON 序列化的 meta.yaml 内容

**结果**：✅ 通过

---

### 2.6 `remx version`

**命令**：`remx version`

**输出**：`remx v0.2.0`

**结果**：✅ 通过

---

## 3. B1 问题验证：chunker.py para_indices

### 问题描述

Reviewer 提到 B1：`chunker.py` 的 `para_indices` 计算永远从 0 开始。

### 验证方法

直接调用 chunker 模块，对同一文档分别用 heading 策略和 paragraph 策略分块，检查每个 chunk 的 `para_indices`：

### 3.1 `chunk_by_headings`（当前默认策略）

```python
chunks = chunk_by_headings(paragraphs, "test.md", max_tokens=512, overlap_paras=0)
for ch in chunks:
    print(f"  para_indices: {ch.para_indices}")
```

**输出**：
```
Chunk project::test.md::0: para_indices: []
Chunk project::test.md::1: para_indices: []
Chunk project::test.md::2: para_indices: []
Chunk project::test.md::3: para_indices: []
Chunk project::test.md::4: para_indices: []
Chunk project::test.md::5: para_indices: []
```

**结论**：❌ 所有 chunk 的 `para_indices` 均为 `[]`（空列表）

**根因**：在 `chunk_by_headings` 的 `_emit` 函数中，`para_indices` 被硬编码为空列表：
```python
def _emit(chunk_paras: list, tokens: int, lvl: int, htxt: str) -> None:
    ...
    chunks.append(Chunk(
        chunk_id=make_chunk_id(file_path, _chunk_index),
        content=chunk_text,
        para_indices=[],  # ← BUG: 永远是空列表
        ...
    ))
```

### 3.2 `chunk_paragraphs_simple`（备选策略，正常）

```python
chunks = chunk_paragraphs_simple(paragraphs, "test.md", chunk_size_paras=2, overlap_paras=0)
```

**输出**：
```
Chunk project::test.md::0: para_indices: [0, 1]
Chunk project::test.md::1: para_indices: [2, 3]
Chunk project::test.md::2: para_indices: [4, 5]
Chunk project::test.md::3: para_indices: [6, 7]
```

**结论**：✅ `para_indices` 正确记录了每个 chunk 对应的段落索引

### 3.3 `_make_chunks`（token-based，正常）

**输出**：
```
Chunk project::test.md::0: para_indices: [0]
Chunk project::test.md::1: para_indices: [0]
Chunk project::test.md::2: para_indices: [1]
...
```

**结论**：✅ `para_indices` 基本正确（最后一个 chunk 在段落被 split 时有边界 case）

### 3.4 数据库层面验证

查询 `memory.db` 中 `chunks` 表：
```sql
SELECT chunk_id, content FROM chunks;
```

**发现**：`chunks` 表的 schema 中根本没有 `para_indices` 列！
```sql
CREATE TABLE chunks (
    chunk_id    TEXT PRIMARY KEY,
    parent_id   TEXT NOT NULL,
    chunk_index INTEGER,
    content     TEXT NOT NULL,
    embedding   BLOB,
    created_at  TEXT,
    updated_at  TEXT,
    deprecated  INTEGER DEFAULT 0
    -- 缺少 para_indices 列
);
```

**结论**：即使 `index_.py` 传递了 `para_indices`，`db.py` 的 `write_memory` 也不会存储它（既没有 INSERT 也没有对应的表列）。

---

## 4. 未实现的命令

以下 tech-spec.md 中描述的命令在当前 CLI 中**不存在**：

| 命令 | 状态 |
|------|------|
| `pm init --user <user>` | ❌ `remx init` 不支持 `--user` 参数 |
| `pm log --content "..."` | ❌ 未实现 |
| `pm demand --content "..." --priority P1` | ❌ 未实现 |
| `pm tmp --content "..." --ttl 1` | ❌ 未实现 |
| `pm list` | ❌ 未实现 |
| `pm search --query "..."` | ❌ 未实现 |
| `pm issue --content "..."` | ❌ 未实现 |
| `pm knowledge --content "..."` | ❌ 未实现 |
| `pm principles --content "..."` | ❌ 未实现 |
| `pm update` | ❌ 未实现 |
| `pm delete` | ❌ 未实现 |
| `pm get` | ❌ 未实现 |

**说明**：当前 CLI 仅有 Phase 1 引擎层命令（`parse`、`init`、`index`、`gc`、`retrieve`），Phase 2 用户层命令尚未实现。

---

## 5. 总结

### 测试结论：**部分通过**

| 测试项 | 状态 | 备注 |
|--------|------|------|
| `remx init` | ✅ | 数据库初始化正确 |
| `remx index` | ⚠️ | 功能可用，但 B1 未修复 |
| `remx gc --dry-run` | ✅ | 过期检查和 dry-run 正常 |
| `remx retrieve` | ✅ | 过滤和 JSON 输出正确 |
| `remx parse` | ✅ | meta.yaml 解析正确 |
| `remx version` | ✅ | 版本号正确 |

### 阻塞问题列表

1. **[B1] `chunk_by_headings` 的 `para_indices` 永远为空**
   - **严重程度**：中
   - **影响**：使用 heading 策略（默认）索引时，每个 chunk 丢失了"对应原文哪些段落"的信息
   - **根因**：`chunker.py` 第 `_emit()` 函数中 `para_indices=[]` 硬编码
   - **修复方案**：在 `_emit` 调用处传入实际的段落索引范围

2. **[B2] `db.py` chunks 表缺少 `para_indices` 列**
   - **严重程度**：中
   - **影响**：即使 chunker 修复，`para_indices` 也无法持久化到数据库
   - **修复方案**：在 `CHUNKS_COL_DEFS` 中添加 `para_indices TEXT` 列，并修改 `write_memory` 中的 INSERT 语句

3. **[B3] `index_.py` 未传递 `para_indices`**
   - **严重程度**：低（紧跟前两个问题的连锁）
   - **影响**：chunk_dicts 构建时遗漏了 `para_indices`
   - **修复方案**：在 `chunk_dicts.append()` 时加入 `"para_indices": json.dumps(ch.para_indices)`

### 建议

- B1 是 Reviewer 明确标记的阻塞项，建议优先修复后再合并
- B2 和 B3 是 B1 的连锁问题，三者需同时修复

# Phase 1 测试报告

**日期:** 2026-04-01 18:30 GMT+8  
**环境:** Python 3.14 + `.venv`, sqlite-vec installed  
**分支:** `impl` (未 commit)  
**测试文件:** `/tmp/test_meta.yaml`, `/tmp/test_note.md`, `/tmp/test_pm.db`

---

## 测试结果总览

| 测试用例 | 结果 | 备注 |
|----------|------|------|
| TEST-parse-01 | ✅ PASS | 输出有效 JSON |
| TEST-init-01 | ✅ PASS | 表创建成功 |
| TEST-index-01 | ✅ PASS | 8 个 chunk 正确索引 |
| TEST-gc-01 | ✅ PASS | dry-run 正常 |
| TEST-retrieve-01 | ❌ FAIL → ✅ FIXED | 修复 `datetime` 未导入 bug |

---

## 详细测试记录

### TEST-parse-01: parse 命令验证

**命令:**
```bash
python -m pm parse /tmp/test_meta.yaml
```

**预期:** 输出有效 JSON
**实际:** ✅ 通过 — 输出如下：
```json
{
  "name": "project",
  "version": "1",
  "index_scope": [],
  "dimensions": { "normal": [], "decay": [] },
  "decay_groups": [],
  "vector": { "dimensions": 768, "table": "memories_vec", "key_column": "chunk_id", "embedding_column": "embedding" },
  "chunk": { "max_tokens": 512, "overlap": 1 }
}
```

---

### TEST-init-01: init 命令建表

**命令:**
```bash
python -m pm init --reset --db /tmp/test_pm.db --meta /tmp/test_meta.yaml
```

**预期:** 创建 memories/chunks/memories_vec 表
**实际:** ✅ 通过 — 输出：
```
Rebuilt database at /tmp/test_pm.db
  Tables: memories, chunks
  Vector table: memories_vec (dimensions=768)
  Indexes: created
```

**验证:**
- `memories` 表: ✅ 存在，含 id/category/priority/status/type/file_path/chunk_count/created_at/updated_at/expires_at/deprecated
- `chunks` 表: ✅ 存在，含 chunk_id/parent_id/chunk_index/content/embedding/created_at/updated_at/deprecated
- `memories_vec` 虚拟表: ✅ vec0(chunk_id TEXT, embedding FLOAT[768])
- 索引: ✅ idx_memories_category, idx_memories_status, idx_memories_expires_at, idx_memories_deprecated, idx_memories_file_path, idx_chunks_parent, idx_chunks_deprecated

---

### TEST-index-01: index 命令单文件索引

**命令:**
```bash
python -m pm index /tmp/test_note.md --db /tmp/test_pm.db --meta /tmp/test_meta.yaml
```

**预期:** 文件索引成功，chunk 存入 DB
**实际:** ✅ 通过 — 输出：
```
pm index: indexed /tmp/test_note.md
  memory_id: UNK-48F792B93F5B887D
  category: unknown
  chunks: 8
```

**验证:**
- memories 表: ✅ 1 条记录 (id=UNK-48F792B93F5B887D, category=unknown)
- chunks 表: ✅ 8 条记录

---

### TEST-gc-01: gc 命令 dry-run

**命令:**
```bash
python -m pm gc --dry-run --db /tmp/test_pm.db
```

**预期:** gc 能正常执行
**实际:** ✅ 通过 — 输出：
```
pm gc --dry-run
  expired (not yet deprecated): 0
  deprecated (already marked): 0
  chunks pending delete: 0
```

---

### TEST-retrieve-01: retrieve 命令

**命令:**
```bash
python -m pm retrieve --filter '{"category":"demand"}' --db /tmp/test_pm.db
```

**第一次运行 — ❌ FAIL:**
```
NameError: name 'datetime' is not defined
  File "pm/retrieve_.py:53", in _sanitize
    if isinstance(v, (datetime,)):
```

**根因:** `retrieve_.py` 第 53 行使用了 `datetime` 类型检查，但未导入 `datetime` 模块。

**修复:** 在 `retrieve_.py` 顶部添加 `from datetime import datetime`

**修复后重新测试 — ✅ PASS:**
```bash
python -m pm retrieve --filter '{"category":"unknown"}' --db /tmp/test_pm.db
# 输出有效 JSON 数组，含 memory 记录及 chunk content
```

---

## Bug 修复

### Bug-01: datetime 未导入

- **文件:** `pm/retrieve_.py`
- **问题:** `_sanitize()` 函数使用 `isinstance(v, (datetime,))` 但未导入 `datetime`
- **修复:** 添加 `from datetime import datetime`
- **状态:** ✅ 已修复并验证

---

## commit 建议

修复后建议 commit 以下文件（未包含的由主 agent 决定）：
- `pm/retrieve_.py` — 修复 datetime 导入缺失

Phase 1 代码 5 个命令均已验证通过（retrieve 修复后）。

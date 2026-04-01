# Phase 1 代码评审报告

**评审日期：** 2026-04-01
**评审人：** Reviewer subagent
**分支：** `impl`
**评审范围：** `pm/chunker.py`, `pm/db.py`, `pm/schema.py`, `pm/index_.py`, `pm/gc_.py`, `pm/retrieve_.py`

---

## 一、设计对齐检查 ✅

| 检查项 | 设计描述 | 代码实现 | 状态 |
|--------|----------|----------|------|
| chunk_id 分隔符 | `{file_path}::{chunk_index}` | `f"{file_path}::{chunk_index}"` | ✅ |
| overlap 计算单位 | 段落数（paragraph count） | `overlap_paras` 参数 + `_SENTENCE_END_RE` 断句 | ✅ |
| 超长段落断句 | 按 `。？！；\n` 断句 | `_SENTENCE_END_RE = re.compile(r"[。？！；\n]")` | ✅ |
| 原子写入事务 | `BEGIN/COMMIT` + `ROLLBACK` | `conn.execute("BEGIN")` / `conn.commit()` / `except: rollback` | ✅ |
| gc 三模式 | `--dry-run` / (default soft) / `--purge` | `gc_cmd` + `run_gc(dry_run, purge)` | ✅ |
| `deprecated` 软删除字段 | 存在于 memories 和 chunks 表 | `deprecated INTEGER DEFAULT 0` + `idx_memories_deprecated` | ✅ |

---

## 二、阻塞问题（必须修复）

### B1: `chunker.py` — `_make_chunks()` 中 `para_indices` 计算永远从 0 开始

**严重程度：** 阻塞（功能逻辑错误）

**问题位置：** `_make_chunks()` 函数，两处 flush 逻辑

**问题描述：**

`current_paras` 的类型是 `list[str]`（段落文本列表），但代码尝试将其第一个元素当作 `int` 来计算起始段落索引：

```python
# 位置 1: 超长段落 flush（第 ~59-74 行）
para_indices=list(range(
    int(current_paras[0]) if isinstance(current_paras[0], int) else   # ← 永远走 else
    (current_paras and current_paras[0] and int(current_paras[0])) or 0,
    para_idx
)),

# 位置 2: 普通段落 flush（第 ~85-97 行）
para_indices=[p for p in range(len(paragraphs)) if paragraphs[p] in current_paras],
```

- `isinstance(current_paras[0], int)` — 永远 `False`（是 `str`）
- `or 0` — 永远触发
- 结果：`para_indices` 永远从 `0` 开始，无法正确记录 chunk 在原文中的段落位置

**修改建议：**

在 `_make_chunks` 中增加显式 `start_para_idx` 跟踪变量：

```python
def _make_chunks(
    paragraphs: list[str],
    file_path: str,
    max_tokens: int,
    overlap_paras: int,
) -> list[Chunk]:
    if not paragraphs:
        return []

    chunks: list[Chunk] = []
    chunk_index = 0
    current_paras: list[str] = []
    current_token_count = 0
    overlap_buffer: list[str] = []
    start_para_idx = 0          # ← 新增：跟踪当前 chunk 的起始段落索引

    for para_idx, para in enumerate(paragraphs):
        # ... 超长段落处理（flush 时用 start_para_idx）...
        
        if current_token_count + para_tokens > max_tokens and current_paras:
            chunk_text = "\n\n".join(current_paras)
            chunk_id = f"{file_path}::{chunk_index}"
            chunks.append(Chunk(
                chunk_id=chunk_id,
                content=chunk_text,
                para_indices=list(range(start_para_idx, para_idx)),  # ← 修复
                token_count=current_token_count,
            ))
            chunk_index += 1
            overlap_start = max(0, len(current_paras) - overlap_paras)
            current_paras = current_paras[overlap_start:]
            start_para_idx = para_idx - len(current_paras) + overlap_start  # ← 新增：更新起始索引
            current_token_count = sum(count_tokens(p) for p in current_paras)
            overlap_buffer = []

        current_paras.append(para)
        current_token_count += para_tokens

    # flush remaining（同样用 start_para_idx）...
```

**注：** `chunk_paragraphs_simple` 使用 `start`/`end` 变量，无此问题。

---

### B2: `retrieve_.py` — `datetime` 命名冲突导致类型检查失效

**严重程度：** 阻塞（运行时潜在错误）

**问题位置：** `pm/retrieve_.py` 第 9 行和 `_sanitize()` 函数

**问题描述：**

```python
from .db import retrieve, ...         # 第 4 行：db 模块导入
...
from datetime import datetime         # 第 9 行：同时导入 datetime 类

def _sanitize(row: dict) -> dict:
    ...
    if isinstance(v, (datetime,)):   # ← `datetime` 在此作用域是 `datetime.datetime` 类 ✅
        out[k] = v.isoformat()
```

实际上 `retrieve_.py` 第 4 行是 `from .db import retrieve`（没有 import datetime），第 9 行的 `from datetime import datetime` 没问题。但 `_sanitize` 中的 `datetime` 引用是正确的 Pydantic/datetime 类用法。

**重新评估：** 经复查，`retrieve_.py` 的 `datetime` 导入是正确的（`from datetime import datetime`）。**此条不是阻塞问题，删除。**

---

## 三、建议改进项

### S1: `schema.py` — `MetaYaml` 缺少 `embedder` 配置字段

**文件：** `pm/schema.py`

**问题：** `cli.py` 的 `index_cmd` 尝试读取 `meta_cfg.embedder.provider`，但 `MetaYaml` 模型没有定义 `embedder` 字段。当前靠 `hasattr` 兜底：

```python
# cli.py 第 90 行
embedder = create_embedder(
    provider=meta_cfg.embedder.provider if hasattr(meta_cfg, "embedder") else "ollama",
    ...
)
```

**建议：** 在 `MetaYaml` 中增加可选的 `embedder` 配置块，与设计文档中 `vector` 配置对齐：

```python
class EmbedderConfig(BaseModel):
    provider: str = "ollama"   # "ollama" | "openai"
    model: str = "bge-m3"
    ollama_base_url: str = "http://localhost:11434"
    openai_api_key: Optional[str] = None
    openai_model: str = "text-embedding-3-small"

class MetaYaml(BaseModel):
    ...
    embedder: Optional[EmbedderConfig] = None
```

---

### S2: `gc_.py` — `gc_collect` 的 deprecated 查询未应用 scope 过滤

**文件：** `pm/db.py` 的 `gc_collect` 函数

**问题：** expired 查询有 scope 过滤，deprecated 查询没有：

```python
expired_rows = conn.execute(
    f"SELECT * FROM memories WHERE {where}",  # ← 有 scope LIKE 过滤
    params,
).fetchall()

deprecated_rows = conn.execute(
    "SELECT * FROM memories WHERE deprecated = 1",  # ← 无 scope 过滤
).fetchall()
```

**建议：** 统一过滤逻辑，或在文档中明确说明行为差异（deprecated 是全量，不受 scope 限制）。

---

### S3: `chunker.py` — `chunk_paragraphs_simple` overlap 大于 chunk_size 时自动归零

**文件：** `pm/chunker.py` 第 137 行

**问题：** 当 `overlap_paras >= chunk_size_paras` 时，`effective_overlap = min(overlap_paras, chunk_size_paras - 1)` 直接归零，可能不符合用户预期：

```python
effective_overlap = min(overlap_paras, max(0, chunk_size_paras - 1))
```

**建议：** 在函数开头增加参数校验，对无效组合发出警告：

```python
if overlap_paras >= chunk_size_paras:
    import sys
    print(f"WARNING: overlap_paras ({overlap_paras}) >= chunk_size_paras ({chunk_size_paras}); "
          f"setting overlap to 0", file=sys.stderr)
    effective_overlap = 0
```

---

### S4: `index_.py` — `overlap_paras` 默认值 `-1` 导致 meta.yaml overlap 无法生效

**文件：** `pm/index_.py` 第 47 行

**问题：** 当用户通过 CLI 调用且不传 `--overlap` 时，`overlap_paras` 为 `-1`（typer 默认值），然后走 `ov = overlap_paras if overlap_paras >= 0 else meta.chunk.overlap` 分支。

由于 `meta.chunk.overlap` 在 schema 中默认 `0`，所以 **meta.yaml 中配置 overlap 在 `pm index` 命令行调用时永远不生效**（除非显式传 `--overlap`）。

这不是 bug（默认值为 0 是合理的安全选择），但建议在 CLI help 中说明：

```
--overlap: Paragraph overlap (default from meta.yaml, or 0 if not set)
```

---

### S5: `db.py` — `gc_purge` 中 vec 表删除失败静默忽略

**文件：** `pm/db.py` 的 `gc_purge` 函数

**问题：** sqlite-vec 删除失败时直接 `pass`，可能导致残留向量记录：

```python
for row in chunk_ids:
    try:
        conn.execute("DELETE FROM memories_vec WHERE chunk_id = ?", (row["chunk_id"],))
    except Exception:
        pass  # ← 静默忽略
```

**建议：** 至少记录 warning：

```python
except Exception as e:
    import sys
    print(f"[pm] WARNING: could not delete vector for {row['chunk_id']}: {e}", file=sys.stderr)
```

---

## 四、评审总结

**Phase 1 实现质量：良好**

- 架构分层清晰，CLI 与业务逻辑分离
- 数据库事务设计正确（BEGIN/COMMIT + ROLLBACK）
- gc 三模式（dry-run / soft / purge）完整实现
- chunk_id `::` 分隔符、超长段落句子断句、overlap 按段落数计算 均符合设计

**阻塞项数量：1 个**

- **B1**: `_make_chunks` 的 `para_indices` 永远从 0 开始 — 需要增加显式 `start_para_idx` 跟踪变量

**建议改进项数量：4 个**

- S1: `MetaYaml` 缺少 `embedder` 字段（影响 CLI embedder 配置）
- S2: `gc_collect` scope 过滤不一致
- S3: `chunk_paragraphs_simple` overlap 归零无警告
- S4: CLI overlap 默认行为说明不清
- S5: `gc_purge` vec 删除失败静默忽略

---

*评审完成。阻塞项 B1 修复后建议合并。*

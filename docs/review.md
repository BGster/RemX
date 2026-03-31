# Code Review Report — Commit `5432bab`

**Reviewer:** Reviewer Subagent  
**Date:** 2026-03-31  
**Branch:** `impl`  
**Files Reviewed:** `pm/__init__.py`, `pm/config.py`, `pm/db.py`, `pm/storage.py`, `pm/idgen.py`, `pm/gc.py`, `pm/embedding.py`, `pm/commands/add.py`, `pm/commands/init.py`  
**Tools:** ruff (15 errors), code inspection, design-doc comparison

---

## ❌ 阻塞项（Blocking — Must Fix Before Merge）

### 🔴 B-1: `Undefined name _is_tmp_expired` in `db.py:260`
**Severity:** Runtime `NameError` — completely broken

`gc_expired()` in `db.py` calls `_is_tmp_expired(f)` but this function is defined in `gc.py` and **never imported** into `db.py`. Every call to `gc_expired()` (triggered by `_run_gc()` in every add command) will crash.

```python
# db.py:260
if tmp_dir.exists():
    for f in tmp_dir.glob("TMP-*.md"):
        if _is_tmp_expired(f):   # ← NameError: name '_is_tmp_expired' is not defined
```

**Fix:** Import `_is_tmp_expired` from `.gc` in `db.py`, or move the function to a shared utility module.

---

### 🔴 B-2: `gc_expired()` deletes vec entries with wrong join key
**Severity:** Silent data corruption — vec table accumulates orphaned entries

The `memories_vec` join in `gc_expired()` uses `rowid`:
```python
conn.execute(
    "DELETE FROM memories_vec WHERE rowid = (SELECT rowid FROM memories WHERE id = ?)",
    (rid,)
)
```
But:
1. `memories_vec` is created with `USING vec0()` (no column spec, defaults to a single `embedding` column — see B-3)
2. The join key should be `memory_id TEXT` per ADR-001 schema, not `rowid`
3. This DELETE will always fail silently (caught by bare `except`)

Result: every expired tmp deletion leaves orphaned vec entries. For non-tmp `pm delete` (if implemented), the same problem exists.

---

### 🔴 B-3: `memories_vec` virtual table schema mismatch with code assumptions
**Severity:** Vector search will not work; vec table silently broken

ADR-001 specifies:
```sql
CREATE VIRTUAL TABLE memories_vec USING vec0(
    memory_id   TEXT,
    embedding   FLOAT[1024]
);
```

Actual code (`db.py:54-55`):
```python
conn.execute("CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0()")
```

`vec0()` with no column spec creates a table with a single `embedding` column (sqlite-vec default). The code then tries to insert using `rowid` from memories:
```python
conn.execute(
    "INSERT INTO memories_vec (rowid, embedding) VALUES ((SELECT rowid FROM memories WHERE id = ?), ?)",
    (memory_id, vec_blob)
)
```
This will fail silently (bare `except: pass`). **Vector search will fall back to text search every time.**

**Fix:** Use correct sqlite-vec schema per ADR-001, with `memory_id TEXT` as the join key, and fix the INSERT accordingly.

---

## ⚠️ 需改进项（Should Fix）

### 🟡 I-1: `pm gc`, `pm delete`, `pm update`, `pm daemon` commands not implemented
**Severity:** Missing features from CLI command list (ADR-001 §5.1)

ADR specifies 17 commands. Currently implemented: `init`, `log`, `demand`, `issue`, `principles`, `knowledge`, `tmp`, `list`, `search`, `get`, `version`. Missing:
- `pm gc --expired` — explicit GC trigger
- `pm update <id>` — update memory status/content
- `pm delete <id>` — delete memory (file + DB + vec)
- `pm daemon` — background GC daemon

**Fix:** Implement missing commands or explicitly defer them.

---

### 🟡 I-2: `.pm.yaml` config field names don't match ADR spec
**Severity:** Config interoperability risk

ADR-001 §3.1 specifies nested embedder config:
```yaml
embedder:
  provider: "ollama"
  model: "bge-m3"
  ollama:
    base_url: "http://localhost:11434"
    timeout: 60
  openai:
    api_key: "${OPENAI_API_KEY}"
    model: "text-embedding-3-small"
```

Actual `config.py` uses flat keys:
```python
ollama_base_url: str = "http://localhost:11434"
ollama_timeout: int = 60
openai_api_key: Optional[str] = None
openai_model: str = "text-embedding-3-small"
```

Works within the current codebase but violates the ADR contract. Users expecting the nested format from the spec will be confused.

---

### 🟡 I-3: `pm init --force` doesn't actually force
**Severity:** UX bug

`init.py` accepts `--force` but the code only does `mkdir(parents=True, exist_ok=True)` — it never deletes or overwrites existing content. The flag is a no-op.

**Fix:** If `--force`, optionally clear/recreate user directories, or at minimum warn the user that it's not implemented.

---

### 🟡 I-4: `_get_project_root()` loads config but ignores it
**Severity:** Dead code / misleading

```python
def _get_project_root(config_path: Path) -> Path:
    config = Config.load(config_path)   # loaded...
    return config_path.parent.resolve()  # ...but never used
```

Loads config then returns `config_path.parent.resolve()` unconditionally. Should use `config.resolve_root(config_path)` per the method's own docstring.

---

### 🟡 I-5: `_run_gc()` in `add.py` calls unimported `gc_expired_files`
**Severity:** Unused import, misleading

`_run_gc()` calls both `db_gc_expired` and `gc_expired_files`. The latter is not imported at the top of `add.py` (it's not in the imports list). It IS defined in `gc.py` and called via `_run_gc`, but the direct file-based GC backup (`gc_expired_files`) will raise `NameError` if the `db_gc_expired` path fails and falls through.

---

### 🟡 I-6: `_slugify` imported at module level then shadowed locally
**Severity:** Lint warning (F811)

```python
# Top of add.py
import re  # ← imported globally

def _slugify(text: str) -> str:
    import re  # ← redefined locally
```

Remove the global import since it's only needed inside `_slugify`.

---

### 🟡 I-7: Demand ID sequence scope violation
**Severity:** Logic bug

`idgen.py:get_next_id()` counts from `{user}/demands/` only:
```python
row = conn.execute(
    "SELECT id FROM memories WHERE category=? AND id LIKE ? ORDER BY id DESC LIMIT 1",
    (category, f"{prefix}-%")
).fetchone()
```

Per tech-spec §3.3: "PRJ-, MS-, ISC-, KNW-, DMD-, ADR- 均使用**全局**自增序号". The current code IS global (DB-level), which is correct for the DB — but `demands` can be in either `{user}/demands/` or `share/demands/` per the spec. The ID sequence is shared, which happens to work, but the comment "within `{user}/demands/`" in the implementation comment is misleading.

---

### 🟡 I-8: `gc_expired()` catches all exceptions silently
**Severity:** Hidden failures

Both `db_gc_expired` and `gc_expired_files` catch `Exception: pass`. GC failures are completely silent. For a TTL mechanism that users rely on for data expiry, silent failures mean tmp files accumulate indefinitely.

---

## ✅ 通过项

| # | 检查项 | 状态 |
|---|--------|------|
| 1 | `tmp` entries do NOT write to `memory.db` (per spec §4.1) | ✅ Correct |
| 2 | SQLite WAL mode enabled (`PRAGMA journal_mode=WAL`) | ✅ Correct |
| 3 | Directory structure matches design (share/ vs {user}/ separation) | ✅ Correct |
| 4 | `share/issues/` and `share/knowledge/` use `user_id=NULL` (global) | ✅ Correct |
| 5 | Lazy GC on 10% probability per call (ADR §4.1) | ✅ Correct |
| 6 | File-based GC fallback when DB fails | ✅ Correct |
| 7 | `expires_at` written to tmp file front-matter | ✅ Correct |
| 8 | `init_db()` creates all required indexes | ✅ Correct |
| 9 | `search_memories` correctly excludes `category='tmp'` | ✅ Correct |
| 10 | Vector search falls back to text search when vec unavailable | ✅ Correct |
| 11 | Config hot-reloads on every command (no daemon state) | ✅ Correct |
| 12 | ID prefixes match design (ISC-, DMD-, KNW-, PRN-, TMP-, ADR-) | ✅ Correct |
| 13 | Dependency list in `pyproject.toml` covers all required packages | ✅ Correct |

---

## 🔍 Lint/Code Quality Issues (ruff)

| File | Code | Issue |
|------|------|-------|
| `pm/__init__.py:21` | F401 | `gc_expired_files` imported but unused |
| `pm/__init__.py:270` | F401 | `Path as P` imported but unused |
| `pm/commands/add.py:3` | F401 | `re` imported but unused (globally) |
| `pm/commands/add.py:6` | F401 | `Any` imported but unused |
| `pm/commands/add.py:22` | F841 | `config` assigned but never used (`_get_project_root`) |
| `pm/commands/add.py:87,168,242,319,392,438` | F541 | f-string without placeholders (cosmetic) |
| `pm/commands/add.py:446` | F811 | `re` redefined (shadowing global import) |
| `pm/db.py:260` | **F821** | `Undefined name _is_tmp_expired` ← **B-1** |
| `pm/idgen.py:5` | F401 | `Optional` imported but unused |
| `pm/storage.py:4` | F401 | `Any` imported but unused |

15 total errors (1 blocking, 1 major B-2/B-3, rest cosmetic/unused imports).

---

## 📋 Summary

| Category | Count |
|----------|-------|
| 🔴 Blocking (must fix) | 3 |
| 🟡 Should fix | 8 |
| ✅ Passing | 13 |
| 🪥 Lint issues | 15 (11 auto-fixable) |

**Verdict:** ⚠️ **NOT READY TO MERGE** — 3 blocking issues must be resolved. B-1 causes a runtime crash in every `add_*` command. B-2 and B-3 cause vector search to silently fail (always falls back to text search). The GC vec cleanup bug also means the vec table will accumulate orphaned entries over time.

**Recommended Priority:**
1. Fix B-1 (import `_is_tmp_expired` into `db.py`)
2. Fix B-3 (correct `memories_vec` schema per ADR)
3. Fix B-2 (correct vec DELETE join key — `memory_id` not `rowid`)
4. Then address all I-1 through I-8 items

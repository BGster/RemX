# RemX Fix Verification Report

**Date:** 2026-04-02
**Branch:** impl
**Tester:** Nova (Subagent)

---

## B1 — f-string prefix in warning (index_.py line ~104)

**Check:** `print(f"remx index: {file_path}: warning: ...")` — confirm f-string prefix present.

**Result:** ✅ PASS

```
remx/index_.py line 104:
    print(f"remx index: {file_path}: warning: {dim_name}='{dim_val}' not in meta.yaml config; allowing anyway",
```

The f-string prefix `f"..."` is present. Commit `d69b920` confirmed.

---

## B2 — Dead add.py removed (Phase 2 cleanup)

**Check:** `remx/commands/add.py` should not exist.

**Result:** ✅ PASS

```
$ ls remx/commands/add.py
ls: cannot access 'remx/commands/add.py': No such file or directory
```

Commit `2f089a2` confirmed. No orphaned dead code remains.

---

## T1 — `parse -` stdin reading

**Check:** `echo '...' | python -m remx parse -` outputs JSON (not file-not-found).

**Result:** ⚠️ PARTIAL PASS — JSON output correct, but exit code is 1 (should be 0)

```
$ echo '...' | uv run --with pyyaml --directory . python -m remx parse -
remx parse: stdin error —
{
  "name": "test",
  "version": "1",
  ...
}
EXIT: 1
```

**Finding:** The `cli.py` parse_cmd has a bug. `raise typer.Exit(code=rc)` inside the `try` block is itself an exception that inherits from `RuntimeError` (which inherits from `Exception`). Therefore it is caught by `except Exception as e`, which then prints "stdin error — {e}" (where `{e}` is empty because `typer.Exit.__str__` is empty) and raises a new `typer.Exit(code=1)`.

The JSON IS correctly printed to stdout before the exception propagates, but the exit code ends up as 1 instead of 0.

---

## T2 — Duplicate index FK constraint

**Check:** Re-indexing same file should not produce `FOREIGN KEY constraint failed`.

**Result:** ❌ FAIL

```
$ uv run python -m remx index doc.md --db test.db --no-embed
remx index: indexed doc.md  memory_id: UNK-73C7A319F52F7FAC  chunks: 1

$ uv run python -m remx index doc.md --db test.db --no-embed
remx index: doc.md: write error — FOREIGN KEY constraint failed
```

**Root cause (db.py write_memory order):**
1. `DELETE FROM memories_vec ...` (OK)
2. `DELETE FROM memories WHERE id = ?` ← **FAILS HERE** because chunks with this `parent_id` still exist. FK constraint is `FOREIGN KEY (parent_id) REFERENCES memories(id)` with no ON DELETE CASCADE.
3. `INSERT INTO memories` (never reached)
4. `DELETE FROM chunks` (never reached)
5. `INSERT INTO chunks` (never reached)

**Correct order should be:**
1. `DELETE FROM memories_vec ...`
2. **`DELETE FROM chunks WHERE parent_id = ?`** ← must happen BEFORE memories delete
3. `DELETE FROM memories WHERE id = ?`
4. `INSERT INTO memories`
5. `INSERT INTO chunks`

Commit `4160810` only moved the `memories_vec` deletion earlier; it did NOT fix the chunks/memories deletion order. The bug persists.

---

## I2 — Inner `_chunk_index` shadowing in `chunk_by_headings`

**Check:** `_split_by_sentences` should not shadow outer `_chunk_index`.

**Result:** ✅ PASS

```
$ grep -n 'sub_chunk_index\|_chunk_index' remx/chunker.py
301:    _chunk_index = 0          # outer function (chunk_by_headings)
308:        nonlocal _chunk_index  # inner _emit() closure
311:            chunk_id=make_chunk_id(file_path, _chunk_index),
318:        _chunk_index += 1
338:                _chunk_index += 1
384:    sub_chunk_index = 0      # _split_by_sentences inner variable
394:            chunk_id = make_chunk_id(file_path, sub_chunk_index)
403:            sub_chunk_index += 1
412:            chunk_id = make_chunk_id(file_path, sub_chunk_index)
```

Commit `391a367` correctly renamed the inner variable to `sub_chunk_index`. No shadowing.

---

## Summary

| ID | Check | Result |
|----|-------|--------|
| B1 | f-string prefix in index_.py warning | ✅ PASS |
| B2 | add.py deleted | ✅ PASS |
| T1 | `parse -` stdin JSON output | ⚠️ JSON OK, exit code 1 (bug) |
| T2 | Re-index no FK error | ❌ FK error still occurs |
| I2 | No inner `_chunk_index` shadowing | ✅ PASS |

**Outstanding bugs:**
- **T1:** `cli.py` parse_cmd — `raise typer.Exit` caught by `except Exception`; needs `except typer.Exit: raise` before the generic handler.
- **T2:** `db.py` write_memory — chunks must be deleted BEFORE memories to satisfy FK constraint. Current order: memories → chunks; correct order: chunks → memories.

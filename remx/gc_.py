"""remx gc command — decay recall cleanup (soft-delete + optional purge)."""
import json
import sys
from pathlib import Path
from typing import Optional

from .db import gc_collect, gc_purge, gc_soft_delete


def run_gc(
    db_path: Path,
    scope_path: Optional[Path] = None,
    dry_run: bool = False,
    purge: bool = False,
) -> int:
    """Run garbage collection on expired/deprecated records.

    Args:
        db_path: path to SQLite database
        scope_path: limit to records whose file_path starts with this path
        dry_run: only report, don't modify
        purge: physically delete deprecated records

    Returns:
        0 on success, 1 on error
    """
    if not db_path.exists():
        print(f"remx gc: {db_path}: database not found", file=sys.stderr)
        return 1

    # ── Collect ────────────────────────────────────────────────────────────────
    try:
        report = gc_collect(db_path, scope_path=scope_path)
    except Exception as e:
        print(f"remx gc: collect error — {e}", file=sys.stderr)
        return 1

    expired = report["expired_memories"]
    deprecated = report["deprecated_memories"]

    # ── Dry run: just report ───────────────────────────────────────────────────
    if dry_run:
        print("remx gc --dry-run")
        print(f"  expired (not yet deprecated): {len(expired)}")
        for m in expired:
            print(f"    {m['id']}  {m['file_path']}  expires_at={m['expires_at']}")
        print(f"  deprecated (already marked): {len(deprecated)}")
        print(f"  chunks pending delete: {report['total_chunks']}")
        return 0

    # ── Soft delete expired ────────────────────────────────────────────────────
    if expired:
        try:
            counts = gc_soft_delete(db_path, scope_path=scope_path)
        except Exception as e:
            print(f"remx gc: soft-delete error — {e}", file=sys.stderr)
            return 1
        print(f"remx gc: soft-deleted {counts['expired_memories']} expired memories, "
              f"{counts['chunks']} chunks")
    else:
        print("remx gc: no expired records found")

    # ── Purge deprecated ────────────────────────────────────────────────────────
    if purge:
        try:
            purge_counts = gc_purge(db_path)
        except Exception as e:
            print(f"remx gc --purge: error — {e}", file=sys.stderr)
            return 1
        print(f"remx gc: purged {purge_counts['memories']} memories, "
              f"{purge_counts['chunks']} chunks (+ VACUUM)")
    elif deprecated:
        print(f"remx gc: {len(deprecated)} deprecated records remain "
              f"(run `remx gc --purge` to physically delete)")

    return 0

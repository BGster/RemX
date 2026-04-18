"""remx stats command — database health check and statistics."""
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import sqlite3

from ..core.db import get_db
from ..core.schema import MetaYaml


def run_stats(
    db_path: Path,
    meta_path: Optional[Path] = None,
) -> int:
    """Output DB statistics for health checking.

    Returns:
        0 on success, 1 on error (file not found, etc.)
    """
    if not db_path.exists():
        print(f"remx stats: {db_path}: database not found", file=sys.stderr)
        return 1

    conn = get_db(db_path)
    try:
        # Memory counts by category
        rows = conn.execute("""
            SELECT
                category,
                COUNT(*) as count,
                SUM(CASE WHEN deprecated = 1 THEN 1 ELSE 0 END) as deprecated
            FROM memories
            GROUP BY category
        """).fetchall()

        total_memories = sum(r["count"] for r in rows)
        total_deprecated = sum(r["deprecated"] for r in rows)
        total_chunks = conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE deprecated = 0"
        ).fetchone()[0]

        # DB size
        db_size_bytes = db_path.stat().st_size
        if db_size_bytes >= 1024 * 1024:
            db_size_str = f"{db_size_bytes / 1024 / 1024:.1f} MB"
        elif db_size_bytes >= 1024:
            db_size_str = f"{db_size_bytes / 1024:.1f} KB"
        else:
            db_size_str = f"{db_size_bytes} B"

        # Time range
        oldest = conn.execute(
            "SELECT MIN(created_at) FROM memories"
        ).fetchone()[0]
        newest = conn.execute(
            "SELECT MAX(updated_at) FROM memories"
        ).fetchone()[0]

        # Decay config from meta.yaml
        decay_info = ""
        if meta_path and meta_path.exists():
            try:
                meta = MetaYaml.load(meta_path)
                decay_groups = meta.decay_groups
                if decay_groups:
                    parts = []
                    for dg in decay_groups:
                        fn = dg.function
                        params = dg.params
                        if fn == "ttl":
                            parts.append(f"{dg.name}(ttl={params.get('ttl_hours', 24)}h)")
                        elif fn == "stale_after":
                            parts.append(f"{dg.name}(stale_after={params.get('days', 30)}d)")
                        elif fn == "never":
                            parts.append(f"{dg.name}(never)")
                    decay_info = "  decay groups: " + "  ".join(parts) + "\n"
            except Exception:
                pass

        # Output
        print(f"memories:  {total_memories}  ", end="")
        for r in rows:
            if r["deprecated"] > 0:
                print(f"{r['category']}={r['count']}({r['deprecated']}*)  ", end="")
            else:
                print(f"{r['category']}={r['count']}  ", end="")
        print()

        print(f"chunks:    {total_chunks}")
        print(f"deprecated: {total_deprecated} ({100*total_deprecated/max(total_memories,1):.1f}%)")
        print(f"db size:   {db_size_str}")

        if oldest:
            oldest_dt = _parse_dt(oldest)
            newest_dt = _parse_dt(newest)
            print(f"oldest:    {oldest_dt.strftime('%Y-%m-%d')}   newest: {newest_dt.strftime('%Y-%m-%d')}")

        if decay_info:
            print(decay_info.rstrip())

        # Topology stats
        try:
            total_nodes = conn.execute("SELECT COUNT(*) FROM memory_nodes").fetchone()[0]
            total_relations = conn.execute("SELECT COUNT(*) FROM memory_relations").fetchone()[0]
            rel_type_counts = conn.execute(
                "SELECT rel_type, COUNT(*) as cnt FROM memory_relations GROUP BY rel_type"
            ).fetchall()
            if total_nodes > 0:
                print(f"topology:  {total_nodes} nodes  {total_relations} relations")
                for r in rel_type_counts:
                    print(f"  {r['rel_type']}: {r['cnt']}")
        except Exception:
            pass

        return 0
    finally:
        conn.close()


def _parse_dt(s: str) -> datetime:
    """Parse ISO datetime string to datetime object."""
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00"))
    except ValueError:
        return datetime.fromisoformat(s[:19])  # fallback

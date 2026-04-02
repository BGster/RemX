"""Database operations for RemX v2 (SQLite + sqlite-vec)."""
import json
import struct
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import sqlite3

try:
    import sqlite_vec
    VEC_AVAILABLE = True
except ImportError:
    VEC_AVAILABLE = False
    sqlite_vec = None

# ─── Connection helper ─────────────────────────────────────────────────────────

def get_db(db_path: Path) -> sqlite3.Connection:
    """Get database connection with vec extension loaded, WAL mode, FK enforcement."""
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    if VEC_AVAILABLE:
        conn.enable_load_extension(True)
        try:
            sqlite_vec.load(conn)
        except Exception:
            pass
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


# ─── Schema constants ─────────────────────────────────────────────────────────

MEMORIES_COLS = [
    "id", "category", "priority", "status", "type",
    "file_path", "chunk_count",
    "created_at", "updated_at", "expires_at",
    "deprecated",
]

MEMORIES_COL_DEFS = """
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL,
    priority    TEXT,
    status      TEXT,
    type        TEXT,
    file_path   TEXT NOT NULL,
    chunk_count INTEGER DEFAULT 0,
    created_at  TEXT NOT NULL,
    updated_at  TEXT NOT NULL,
    expires_at  TEXT,
    deprecated  INTEGER DEFAULT 0
"""

CHUNKS_COL_DEFS = """
    chunk_id    TEXT PRIMARY KEY,
    parent_id   TEXT NOT NULL,
    chunk_index INTEGER,
    content     TEXT NOT NULL,
    embedding   BLOB,
    created_at  TEXT,
    updated_at  TEXT,
    deprecated  INTEGER DEFAULT 0,
    FOREIGN KEY (parent_id) REFERENCES memories(id)
"""

INDEXES = [
    "CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category)",
    "CREATE INDEX IF NOT EXISTS idx_memories_status ON memories(status)",
    "CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at)",
    "CREATE INDEX IF NOT EXISTS idx_memories_deprecated ON memories(deprecated)",
    "CREATE INDEX IF NOT EXISTS idx_memories_file_path ON memories(file_path)",
    "CREATE INDEX IF NOT EXISTS idx_chunks_parent ON chunks(parent_id)",
    "CREATE INDEX IF NOT EXISTS idx_chunks_deprecated ON chunks(deprecated)",
]


# ─── Init ─────────────────────────────────────────────────────────────────────

def init_db(db_path: Path, vector_dimensions: int = 1024, reset: bool = False) -> None:
    """Create / rebuild all tables and vector index.

    Args:
        db_path: path to SQLite database file
        vector_dimensions: embedding dimension for vec virtual table
        reset: if True, DROP existing tables first
    """
    conn = get_db(db_path)
    try:
        if reset:
            # Drop in reverse dependency order
            conn.execute("DROP TABLE IF EXISTS chunks")
            conn.execute("DROP TABLE IF EXISTS memories")
            try:
                conn.execute("DROP TABLE IF EXISTS memories_vec")
            except Exception:
                pass

        # memories table
        conn.execute(f"CREATE TABLE IF NOT EXISTS memories ({MEMORIES_COL_DEFS})")

        # chunks table
        conn.execute(f"CREATE TABLE IF NOT EXISTS chunks ({CHUNKS_COL_DEFS})")

        # memories_vec virtual table
        if VEC_AVAILABLE:
            dim_str = f"FLOAT[{vector_dimensions}]"
            try:
                conn.execute(
                    f"CREATE VIRTUAL TABLE IF NOT EXISTS memories_vec USING vec0("
                    f"chunk_id TEXT, embedding {dim_str})"
                )
            except Exception as e:
                # vec0 may fail if sqlite-vec not compiled; continue without vector support
                import sys
                print(f"[remx] WARNING: could not create memories_vec: {e}", file=sys.stderr)

        # indexes
        for idx_sql in INDEXES:
            conn.execute(idx_sql)

        conn.commit()
    finally:
        conn.close()


# ─── Vector serialization ──────────────────────────────────────────────────────

def serialize_vector(vec: list[float]) -> bytes:
    """Serialize a float list to binary blob (little-endian float32)."""
    return struct.pack(f"<{len(vec)}f", *vec)


def deserialize_vector(blob: bytes) -> list[float]:
    """Deserialize a binary blob back to float list."""
    count = len(blob) // 4
    return list(struct.unpack(f"<{count}f", blob))


# ─── Chunk write (atomic 3-table insert) ─────────────────────────────────────

def write_chunk(
    db_path: Path,
    chunk_id: str,
    parent_id: str,
    chunk_index: int,
    content: str,
    embedding: Optional[list[float]] = None,
    created_at: Optional[str] = None,
) -> None:
    """Write a single chunk + vector inside a transaction."""
    now = created_at or datetime.now(timezone.utc).isoformat()
    conn = get_db(db_path)
    try:
        conn.execute("BEGIN")
        conn.execute(
            "INSERT INTO chunks (chunk_id, parent_id, chunk_index, content, created_at, updated_at, deprecated) "
            "VALUES (?, ?, ?, ?, ?, ?, 0)",
            (chunk_id, parent_id, chunk_index, content, now, now),
        )
        if embedding and VEC_AVAILABLE:
            vec_blob = serialize_vector(embedding)
            try:
                conn.execute(
                    "INSERT INTO memories_vec (chunk_id, embedding) VALUES (?, ?)",
                    (chunk_id, vec_blob),
                )
            except Exception:
                pass  # vec table may not be available
        conn.commit()
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


def write_memory(
    db_path: Path,
    memory: dict[str, Any],
    chunks: list[dict[str, Any]],
    vector_dimensions: int = 1024,
) -> None:
    """Atomically write a memory record + its chunks + vectors.

    Args:
        db_path: database path
        memory: dict with keys matching memories columns (minus deprecated)
        chunks: list of chunk dicts with keys: chunk_id, chunk_index, content, embedding
        vector_dimensions: embedding dimension for vec table
    """
    now = datetime.now(timezone.utc).isoformat()
    conn = get_db(db_path)
    try:
        conn.execute("BEGIN")

        # Upsert memory (delete first for idempotency, then insert)
        # Delete vectors BEFORE chunks/memories to avoid FK violations on re-index
        if VEC_AVAILABLE:
            conn.execute(
                "DELETE FROM memories_vec WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE parent_id = ?)",
                (memory["id"],)
            )
        conn.execute(
            "DELETE FROM memories WHERE id = ?",
            (memory["id"],)
        )
        conn.execute(
            f"INSERT INTO memories ({', '.join(memory.keys())}, deprecated) "
            f"VALUES ({', '.join(['?'] * len(memory))}, 0)",
            list(memory.values()),
        )

        # Delete old chunks for this parent
        conn.execute(
            "DELETE FROM chunks WHERE parent_id = ?",
            (memory["id"],)
        )

        # Insert new chunks
        for ch in chunks:
            conn.execute(
                "INSERT INTO chunks (chunk_id, parent_id, chunk_index, content, created_at, updated_at, deprecated) "
                "VALUES (?, ?, ?, ?, ?, ?, 0)",
                (
                    ch["chunk_id"],
                    memory["id"],
                    ch["chunk_index"],
                    ch["content"],
                    now,
                    now,
                ),
            )
            if ch.get("embedding") and VEC_AVAILABLE:
                vec_blob = serialize_vector(ch["embedding"])
                try:
                    conn.execute(
                        "INSERT INTO memories_vec (chunk_id, embedding) VALUES (?, ?)",
                        (ch["chunk_id"], vec_blob),
                    )
                except Exception:
                    pass

        conn.commit()
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


# ─── GC ──────────────────────────────────────────────────────────────────────

def gc_collect(
    db_path: Path,
    scope_path: Optional[Path] = None,
) -> dict[str, Any]:
    """Query deprecated/expired records for GC report.

    Returns a dict with:
      - expired_memories: list of memory records past expires_at
      - deprecated_memories: list of already-soft-deleted records
      - total_chunks: count of associated chunks
    """
    conn = get_db(db_path)
    try:
        now = datetime.now(timezone.utc).isoformat()
        conditions = ["expires_at IS NOT NULL", "expires_at < ?", "deprecated = 0"]
        params: list = [now]

        if scope_path:
            conditions.append("file_path LIKE ?")
            params.append(str(scope_path) + "%")

        where = " AND ".join(conditions)

        expired_rows = conn.execute(
            f"SELECT * FROM memories WHERE {where}",
            params,
        ).fetchall()

        deprecated_conditions = ["deprecated = 1"]
        deprecated_params: list = []
        if scope_path:
            deprecated_conditions.append("file_path LIKE ?")
            deprecated_params.append(str(scope_path) + "%")
        deprecated_where = " AND ".join(deprecated_conditions)
        deprecated_rows = conn.execute(
            f"SELECT * FROM memories WHERE {deprecated_where}",
            deprecated_params,
        ).fetchall()

        chunk_count = conn.execute(
            "SELECT COUNT(*) FROM chunks WHERE parent_id IN "
            "(SELECT id FROM memories WHERE deprecated = 1)"
        ).fetchone()[0]

        return {
            "expired_memories": [dict(r) for r in expired_rows],
            "deprecated_memories": [dict(r) for r in deprecated_rows],
            "total_chunks": chunk_count,
        }
    finally:
        conn.close()


def gc_soft_delete(
    db_path: Path,
    scope_path: Optional[Path] = None,
) -> dict[str, int]:
    """Soft-delete expired/deprecated memories and their chunks.

    Returns counts of updated records.
    """
    conn = get_db(db_path)
    try:
        now = datetime.now(timezone.utc).isoformat()

        # Soft-delete expired memories
        conditions = ["expires_at IS NOT NULL", "expires_at < ?", "deprecated = 0"]
        params: list = [now]
        if scope_path:
            conditions.append("file_path LIKE ?")
            params.append(str(scope_path) + "%")

        where = " AND ".join(conditions)

        conn.execute(
            f"UPDATE memories SET deprecated = 1, updated_at = ? WHERE {where}",
            [now] + params,
        )
        expired_count = conn.rowcount

        # Soft-delete their chunks
        conn.execute(
            f"UPDATE chunks SET deprecated = 1, updated_at = ? "
            f"WHERE parent_id IN (SELECT id FROM memories WHERE deprecated = 1)",
            (now,),
        )
        chunk_count = conn.rowcount

        conn.commit()

        return {"expired_memories": expired_count, "chunks": chunk_count}
    finally:
        conn.close()


def gc_purge(db_path: Path) -> dict[str, int]:
    """Physically delete all deprecated records and VACUUM.

    Returns counts of deleted records.
    """
    conn = get_db(db_path)
    try:
        # Collect chunk_ids to remove from vec
        if VEC_AVAILABLE:
            chunk_ids = conn.execute(
                "SELECT chunk_id FROM chunks WHERE deprecated = 1"
            ).fetchall()
            import sys
            for row in chunk_ids:
                try:
                    conn.execute("DELETE FROM memories_vec WHERE chunk_id = ?", (row["chunk_id"],))
                except Exception as e:
                    print(f"[remx] WARNING: could not delete vector for {row['chunk_id']}: {e}", file=sys.stderr)

        # Delete chunks
        conn.execute("DELETE FROM chunks WHERE deprecated = 1")
        chunk_count = conn.rowcount

        # Delete memories
        conn.execute("DELETE FROM memories WHERE deprecated = 1")
        memory_count = conn.rowcount

        conn.commit()
        conn.execute("VACUUM")

        return {"memories": memory_count, "chunks": chunk_count}
    finally:
        conn.close()


# ─── Retrieve ─────────────────────────────────────────────────────────────────

def retrieve(
    db_path: Path,
    filter: dict[str, Any],
    include_content: bool = True,
    limit: int = 50,
) -> list[dict[str, Any]]:
    """Retrieve memories by filter dict → SQL WHERE translation.

    Supports: category, priority, status, type, file_path, deprecated,
    expires_at (comparison: <, >, =), id.

    Args:
        db_path: database path
        filter: e.g. {"category": "demand", "priority": "P1"}
        include_content: join with chunks and return content
        limit: max rows
    """
    conn = get_db(db_path)
    try:
        conditions = []
        params: list = []

        # Handle special expires_at comparisons
        if "expires_at" in filter:
            val = filter["expires_at"]
            if isinstance(val, dict):
                for op, v in val.items():
                    conditions.append(f"expires_at {op} ?")
                    params.append(v)
            else:
                conditions.append("expires_at = ?")
                params.append(val)
            del filter["expires_at"]

        for key, val in filter.items():
            if val is None:
                conditions.append(f"{key} IS NULL")
            elif isinstance(val, list):
                placeholders = ", ".join(["?"] * len(val))
                conditions.append(f"{key} IN ({placeholders})")
                params.extend(val)
            else:
                conditions.append(f"{key} = ?")
                params.append(val)

        where_clause = " AND ".join(conditions) if conditions else "1=1"

        if include_content:
            rows = conn.execute(
                f"""
                SELECT m.*, c.content, c.chunk_id, c.chunk_index
                FROM memories m
                LEFT JOIN chunks c ON c.parent_id = m.id AND c.deprecated = 0
                WHERE m.deprecated = 0 AND {where_clause}
                ORDER BY m.updated_at DESC
                LIMIT ?
                """,
                params + [limit],
            ).fetchall()
        else:
            rows = conn.execute(
                f"""
                SELECT * FROM memories
                WHERE deprecated = 0 AND {where_clause}
                ORDER BY updated_at DESC
                LIMIT ?
                """,
                params + [limit],
            ).fetchall()

        return [dict(r) for r in rows]
    finally:
        conn.close()


# ─── Helpers ─────────────────────────────────────────────────────────────────

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def expires_at_ttl(ttl_hours: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(hours=ttl_hours)).isoformat()


def expires_at_stale(days: int) -> str:
    return (datetime.now(timezone.utc) + timedelta(days=days)).isoformat()

"""Database operations for RemX v2 (SQLite + sqlite-vec)."""
import json
import math
import struct
import sys
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

def get_db(db_path: Path, vec_available: Optional[bool] = None) -> sqlite3.Connection:
    """Get database connection with vec extension loaded, WAL mode, FK enforcement."""
    if vec_available is None:
        vec_available = VEC_AVAILABLE
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    if vec_available:
        conn.enable_load_extension(True)
        try:
            sqlite_vec.load(conn)
        except Exception as e:
            import sys

            print(f"[remx] WARNING: sqlite-vec extension not available — vector features disabled ({e})", file=sys.stderr)
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
    content_hash TEXT,
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
    "CREATE INDEX IF NOT EXISTS idx_chunks_content_hash ON chunks(content_hash)",
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
            except Exception as e:
                print(f"[remx] WARNING: could not drop memories_vec: {e}", file=sys.stderr)

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
            except Exception as e:
                print(f"[remx] WARNING: could not insert vector: {e}", file=sys.stderr)
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

    Chunk deduplication by content_hash:
    - If a new chunk's content_hash matches an existing chunk in the DB,
      the existing chunk_id and vector are preserved (no re-embedding needed).
    - Only chunks with new/changed content get new chunk_ids and embeddings.

    Args:
        db_path: database path
        memory: dict with keys matching memories columns (minus deprecated)
        chunks: list of chunk dicts with keys: chunk_id, chunk_index, content,
                 content_hash, embedding (embedding may be None to skip)
        vector_dimensions: embedding dimension for vec table
    """
    now = datetime.now(timezone.utc).isoformat()
    conn = get_db(db_path)
    try:
        conn.execute("BEGIN")

        # Build hash → (chunk_id, embedding) map from existing chunks
        existing_chunks = {
            row["content_hash"]: (row["chunk_id"], row["embedding"])
            for row in conn.execute(
                "SELECT chunk_id, content_hash, embedding FROM chunks WHERE parent_id = ?",
                (memory["id"],)
            ).fetchall()
            if row["content_hash"]
        }

        # Determine which chunks to upsert: reuse existing chunk_id+vector for
        # unchanged content_hash, assign new chunk_ids for new/changed content
        upsert_chunks: list[dict[str, Any]] = []
        reused_count = 0
        for ch in chunks:
            content_hash = ch.get("content_hash")
            if content_hash and content_hash in existing_chunks:
                old_chunk_id, old_embedding = existing_chunks[content_hash]
                # Reuse existing chunk_id and vector (skip embedding)
                upsert_chunks.append({
                    **ch,
                    "chunk_id": old_chunk_id,
                    "embedding": old_embedding,  # preserve existing vector
                    "reused": True,
                })
                reused_count += 1
            else:
                upsert_chunks.append({**ch, "reused": False})

        if reused_count:
            print(f"[remx] write_memory: reused {reused_count}/{len(chunks)} chunk vectors (content hash match)")

        # Delete old chunks + vectors (correct order: vec → chunks → memories)
        conn.execute(
            "DELETE FROM chunks WHERE parent_id = ?",
            (memory["id"],)
        )
        if VEC_AVAILABLE:
            conn.execute(
                "DELETE FROM memories_vec WHERE chunk_id IN (SELECT chunk_id FROM chunks WHERE parent_id = ?)",
                (memory["id"],)
            )
        conn.execute(
            "DELETE FROM memories WHERE id = ?",
            (memory["id"],)
        )

        # Insert memory
        conn.execute(
            f"INSERT INTO memories ({', '.join(memory.keys())}, deprecated) "
            f"VALUES ({', '.join(['?'] * len(memory))}, 0)",
            list(memory.values()),
        )

        # Insert chunks with content_hash
        chunk_rows = [
            (
                ch["chunk_id"], memory["id"], ch["chunk_index"],
                ch["content"], ch.get("content_hash"), now, now,
            )
            for ch in upsert_chunks
        ]
        conn.executemany(
            "INSERT INTO chunks (chunk_id, parent_id, chunk_index, content, content_hash, created_at, updated_at, deprecated) "
            "VALUES (?, ?, ?, ?, ?, ?, ?, 0)",
            chunk_rows,
        )

        # Batch-insert vectors only for chunks that have new embeddings
        if VEC_AVAILABLE:
            vec_rows = [
                (ch["chunk_id"], serialize_vector(ch["embedding"]))
                for ch in upsert_chunks
                if ch.get("embedding") and not ch.get("reused")
            ]
            if vec_rows:
                try:
                    conn.executemany(
                        "INSERT INTO memories_vec (chunk_id, embedding) VALUES (?, ?)",
                        vec_rows,
                    )
                except Exception as e:
                    print(f"[remx] WARNING: could not batch-insert vectors: {e}", file=sys.stderr)

        conn.commit()
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.close()


# ─── GC ──────────────────────────────────────────────────────────────────────

def _scope_clause(scope_path: Optional[Path]) -> tuple[str, list[Any]]:
    if scope_path:
        return "file_path LIKE ?", [str(scope_path) + "%"]
    return "", []


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
        params: list[Any] = [now]

        scope_cond, scope_params = _scope_clause(scope_path)
        if scope_cond:
            conditions.append(scope_cond)
            params.extend(scope_params)

        where = " AND ".join(conditions)

        expired_rows = conn.execute(
            f"SELECT * FROM memories WHERE {where}",
            params,
        ).fetchall()

        deprecated_conditions = ["deprecated = 1"]
        deprecated_params: list[Any] = []
        dep_scope_cond, dep_scope_params = _scope_clause(scope_path)
        if dep_scope_cond:
            deprecated_conditions.append(dep_scope_cond)
            deprecated_params.extend(dep_scope_params)
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
        params: list[Any] = [now]
        if scope_path:
            conditions.append("file_path LIKE ?")
            params.append(str(scope_path) + "%")

        where = " AND ".join(conditions)

        cursor = conn.execute(
            f"UPDATE memories SET deprecated = 1, updated_at = ? WHERE {where}",
            [now] + params,
        )
        expired_count = cursor.rowcount

        # Soft-delete their chunks
        cursor = conn.execute(
            f"UPDATE chunks SET deprecated = 1, updated_at = ? "
            f"WHERE parent_id IN (SELECT id FROM memories WHERE deprecated = 1)",
            (now,),
        )
        chunk_count = cursor.rowcount

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
            for row in chunk_ids:
                try:
                    conn.execute("DELETE FROM memories_vec WHERE chunk_id = ?", (row["chunk_id"],))
                except Exception as e:
                    print(f"[remx] WARNING: could not delete vector for {row['chunk_id']}: {e}", file=sys.stderr)

        # Delete chunks
        cursor = conn.execute("DELETE FROM chunks WHERE deprecated = 1")
        chunk_count = cursor.rowcount

        # Delete memories
        cursor = conn.execute("DELETE FROM memories WHERE deprecated = 1")
        memory_count = cursor.rowcount

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
        params: list[Any] = []

        # Handle special expires_at comparisons
        if "expires_at" in filter:
            val = filter["expires_at"]
            if val is None:
                conditions.append("expires_at IS NULL")
            elif isinstance(val, dict):
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


def expires_at_stale(days: int, updated_at: Optional[str] = None) -> str:
    """Compute stale_after expiration: updated_at + days.

    If updated_at is not provided, falls back to current time.
    """
    if updated_at is None:
        ref = datetime.now(timezone.utc)
    else:
        ref = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
    return (ref + timedelta(days=days)).isoformat()


# ─── Semantic Retrieval with Decay Scoring ───────────────────────────────────

def compute_decay_factor(
    category: str,
    updated_at: Optional[str],
    expires_at: Optional[str],
    meta: Any,
) -> float:
    """Compute decay factor for a memory record.

    Returns a score between 0.0 and 1.0:
    - 1.0: fresh / no decay configured
    - 0.0: fully expired
    - between: partially decayed

    Decay functions:
    - never / no decay_group: 1.0
    - ttl: linear decay from 1.0 to 0.0 over ttl_hours
    - stale_after: exponential decay after stale_after days
    """
    dg = meta.decay_group_for(category)
    if dg is None:
        return 1.0

    fn = dg.function
    params = dg.params

    now = datetime.now(timezone.utc)

    if fn == "never":
        return 1.0

    elif fn == "ttl":
        if not expires_at:
            return 1.0
        try:
            exp = datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
        except ValueError:
            return 1.0
        ttl_hours = params.get("ttl_hours", 24)
        remaining = (exp - now).total_seconds() / 3600
        return max(0.0, min(1.0, remaining / ttl_hours))

    elif fn == "stale_after":
        if not updated_at:
            return 1.0
        try:
            upd = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
        except ValueError:
            return 1.0
        days = params.get("days", 30)
        stale_days = params.get("stale_days", 7)  # grace period before decay
        days_since = (now - upd).total_seconds() / 86400
        if days_since <= stale_days:
            return 1.0
        # Exponential decay: factor = exp(-rate * (days_since - stale_days))
        rate = params.get("decay_rate", 0.1)
        over = days_since - stale_days
        return max(0.0, math.exp(-rate * over))

    return 1.0


def retrieve_semantic(
    db_path: Path,
    query_embedding: list[float],
    meta: Any,
    filter: Optional[dict[str, Any]] = None,
    include_content: bool = True,
    limit: int = 50,
    decay_weight: float = 0.5,
) -> list[dict[str, Any]]:
    """Retrieve memories by semantic similarity + time decay scoring.

    Score = (1 - decay_weight) * cosine_similarity + decay_weight * decay_factor

    Args:
        db_path: database path
        query_embedding: embedded query vector
        meta: MetaYaml config (for decay_groups and dimensions)
        filter: optional SQL filter to narrow candidates before scoring
        include_content: join with chunks table
        limit: max raw vector results (before scoring, larger to allow filtering)
        decay_weight: weight for decay factor in final score (0.0 to 1.0)
    """
    conn = get_db(db_path)
    try:
        vector_dim = meta.vector.dimensions
        vec_blob = struct.pack(f"<{vector_dim}f", *query_embedding)

        # Build optional WHERE clause from filter
        conditions = []
        params: list[Any] = []
        if filter:
            for key, val in filter.items():
                if val is None:
                    conditions.append(f"m.{key} IS NULL")
                elif isinstance(val, list):
                    placeholders = ", ".join(["?"] * len(val))
                    conditions.append(f"m.{key} IN ({placeholders})")
                    params.extend(val)
                else:
                    conditions.append(f"m.{key} = ?")
                    params.append(val)
            conditions.append("m.deprecated = 0")
        else:
            conditions.append("m.deprecated = 0")

        where_clause = " AND ".join(conditions) if conditions else "1=1"

        # Get candidate memories with their chunks
        # First get matching memory IDs
        candidate_ids = conn.execute(
            f"""SELECT DISTINCT m.id FROM memories m
                WHERE {where_clause}""",
            params,
        ).fetchall()
        candidate_ids = [r["id"] for r in candidate_ids]

        if not candidate_ids:
            return []

        # Search vector table for similar chunks among candidates
        placeholders = ", ".join(["?"] * len(candidate_ids))
        vec_rows = conn.execute(
            f"""SELECT
                    v.chunk_id,
                    v.distance,
                    c.parent_id,
                    c.content,
                    c.chunk_index,
                    m.category,
                    m.updated_at,
                    m.expires_at,
                    m.priority,
                    m.status,
                    m.file_path,
                    m.chunk_count,
                    m.id as memory_id
                FROM memories_vec v
                JOIN chunks c ON c.chunk_id = v.chunk_id
                JOIN memories m ON m.id = c.parent_id
                WHERE c.parent_id IN ({placeholders})
                  AND m.deprecated = 0
                ORDER BY v.distance ASC
                LIMIT ?
            """,
            candidate_ids + [limit * 2],
        ).fetchall()

        if not vec_rows:
            return []

        # Compute scores
        scored = []
        for row in vec_rows:
            # Convert distance to similarity (vec0 uses L2 distance)
            # similarity = 1 / (1 + distance)
            distance = row["distance"]
            cosine_score = 1.0 / (1.0 + distance)

            decay = compute_decay_factor(
                category=row["category"],
                updated_at=row["updated_at"],
                expires_at=row["expires_at"],
                meta=meta,
            )
            final_score = (1 - decay_weight) * cosine_score + decay_weight * decay
            scored.append((final_score, row))

        # Sort by score descending, take top N unique memories
        scored.sort(key=lambda x: x[0], reverse=True)

        # Deduplicate by memory_id (keep best chunk per memory)
        seen = set()
        results = []
        for score, row in scored:
            mid = row["memory_id"]
            if mid in seen:
                continue
            seen.add(mid)
            result = {
                "id": row["memory_id"],
                "category": row["category"],
                "priority": row["priority"],
                "status": row["status"],
                "file_path": row["file_path"],
                "chunk_count": row["chunk_count"],
                "updated_at": row["updated_at"],
                "expires_at": row["expires_at"],
                "score": round(score, 6),
                "chunk_id": row["chunk_id"],
                "chunk_index": row["chunk_index"],
            }
            if include_content:
                result["content"] = row["content"]
            results.append(result)
            if len(results) >= limit:
                break

        return results
    finally:
        conn.close()

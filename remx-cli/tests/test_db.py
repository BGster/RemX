"""Tests for remx.db module — focusing on bug fixes."""
import sqlite3
from datetime import datetime, timedelta, timezone

import pytest

from remx.core.db import gc_purge, gc_soft_delete, retrieve


class TestGCSoftDeleteRowcount:
    """Bug #1: conn.rowcount should be cursor.rowcount."""

    def test_gc_soft_delete_returns_expired_count(self, db_with_schema):
        """gc_soft_delete should return count of expired memories."""
        # Insert an already expired memory
        conn = sqlite3.connect(db_with_schema)
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        conn.execute(
            """
            INSERT INTO memories (id, category, file_path, deprecated, created_at, updated_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("EXP-001", "tmp", "/tmp/expired.md", 0, past, past, past),
        )
        conn.commit()
        conn.close()

        result = gc_soft_delete(db_with_schema)

        assert "expired_memories" in result
        assert result["expired_memories"] >= 1

    def test_gc_soft_delete_returns_chunk_count(self, db_with_schema):
        """gc_soft_delete should return count of affected chunks."""
        # Insert an expired memory with chunks
        conn = sqlite3.connect(db_with_schema)
        past = (datetime.now(timezone.utc) - timedelta(hours=1)).isoformat()
        memory_id = "EXP-002"
        conn.execute(
            """
            INSERT INTO memories (id, category, file_path, deprecated, created_at, updated_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            (memory_id, "tmp", "/tmp/expired2.md", 0, past, past, past),
        )
        conn.execute(
            """
            INSERT INTO chunks (chunk_id, parent_id, content, deprecated, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("EXP-002::0", memory_id, "test content", 0, past, past),
        )
        conn.commit()
        conn.close()

        result = gc_soft_delete(db_with_schema)

        assert "chunks" in result
        assert result["chunks"] >= 1


class TestRetrieveExpiresAtNull:
    """Bug #2: expires_at: null should use IS NULL instead of = NULL."""

    def test_retrieve_null_expires_at(self, db_with_schema):
        """retrieve with expires_at: null should return memories with NULL expires_at."""
        # Insert a memory with NULL expires_at (never expires)
        conn = sqlite3.connect(db_with_schema)
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            """
            INSERT INTO memories (id, category, file_path, deprecated, created_at, updated_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("NEVER-001", "demand", "/tmp/never.md", 0, now, now, None),
        )
        conn.commit()
        conn.close()

        result = retrieve(db_with_schema, {"expires_at": None})

        assert len(result) >= 1
        assert any(r["id"] == "NEVER-001" for r in result)

    def test_retrieve_with_expires_at_filter(self, db_with_schema):
        """retrieve with expires_at comparison should still work."""
        conn = sqlite3.connect(db_with_schema)
        now = datetime.now(timezone.utc).isoformat()
        future = (datetime.now(timezone.utc) + timedelta(hours=1)).isoformat()
        conn.execute(
            """
            INSERT INTO memories (id, category, file_path, deprecated, created_at, updated_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("FUTURE-001", "tmp", "/tmp/future.md", 0, now, now, future),
        )
        conn.commit()
        conn.close()

        result = retrieve(db_with_schema, {"expires_at": {"<": "2020-01-01T00:00:00+00:00"}})

        assert len(result) == 0  # Should not match future expires_at


class TestGCPurgeRowcount:
    """Bug #1 variant: gc_purge should also use cursor.rowcount."""

    def test_gc_purge_returns_counts(self, db_with_schema):
        """gc_purge should return counts of deleted records."""
        # First mark something as deprecated
        conn = sqlite3.connect(db_with_schema)
        now = datetime.now(timezone.utc).isoformat()
        conn.execute(
            """
            INSERT INTO memories (id, category, file_path, deprecated, created_at, updated_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            """,
            ("DEP-001", "tmp", "/tmp/dep.md", 1, now, now, now),
        )
        conn.execute(
            """
            INSERT INTO chunks (chunk_id, parent_id, content, deprecated, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?)
            """,
            ("DEP-001::0", "DEP-001", "content", 1, now, now),
        )
        conn.commit()
        conn.close()

        result = gc_purge(db_with_schema)

        assert "memories" in result
        assert "chunks" in result

"""Topology relations for RemX — context-aware graph recall."""
from __future__ import annotations

import json
import math
import struct
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import sqlite3

from .db import get_db

# ─── Constants ────────────────────────────────────────────────────────────────

REL_TYPES = {
    "因果关系",
    "相关性",
    "对立性",
    "流程顺序性",
    "组成性",
    "依赖性",
}

REL_ROLES = {
    "cause",      # 因：导致方
    "effect",     # 果：被导致方
    "component",  # 组件
    "whole",      # 整体
    "related",    # 相关（对称关系用）
    "opponent",   # 对立（对称关系用）
}

DEFAULT_CONTEXT = "global"  # 无条件全局可用


# ─── Schema ─────────────────────────────────────────────────────────────────

TOPOLOGY_TABLES = """
CREATE TABLE IF NOT EXISTS memory_nodes (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL,
    chunk       TEXT NOT NULL,
    created_at INTEGER DEFAULT (unixepoch('now', 'subsec'))
);

CREATE TABLE IF NOT EXISTS memory_relations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_type    TEXT NOT NULL CHECK (rel_type IN (
        '因果关系', '相关性', '对立性', '流程顺序性', '组成性', '依赖性'
    )),
    context     TEXT DEFAULT NULL,
    description TEXT,
    created_at  INTEGER DEFAULT (unixepoch('now', 'subsec'))
);

CREATE TABLE IF NOT EXISTS memory_relation_participants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    relation_id INTEGER NOT NULL REFERENCES memory_relations(id) ON DELETE CASCADE,
    node_id     TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    UNIQUE(relation_id, node_id, role)
);

CREATE INDEX IF NOT EXISTS idx_participants_node ON memory_relation_participants(node_id);
CREATE INDEX IF NOT EXISTS idx_participants_rel ON memory_relation_participants(relation_id);
CREATE INDEX IF NOT EXISTS idx_relations_context ON memory_relations(context);
"""


def init_topology_db(db_path: Path) -> None:
    """Create topology tables if not exist."""
    conn = get_db(db_path)
    try:
        for stmt in TOPOLOGY_TABLES.strip().split(";"):
            stmt = stmt.strip()
            if stmt:
                conn.execute(stmt)
        conn.commit()
    finally:
        conn.close()


# ─── Node CRUD ────────────────────────────────────────────────────────────────

def ensure_node(db_path: Path, node_id: str, category: str, chunk: str) -> None:
    """Insert or ignore a node."""
    conn = get_db(db_path)
    try:
        conn.execute(
            "INSERT OR IGNORE INTO memory_nodes (id, category, chunk) VALUES (?, ?, ?)",
            (node_id, category, chunk),
        )
        conn.commit()
    finally:
        conn.close()


def list_nodes(db_path: Path, category: Optional[str] = None) -> list[dict[str, Any]]:
    conn = get_db(db_path)
    try:
        if category:
            rows = conn.execute(
                "SELECT * FROM memory_nodes WHERE category = ? ORDER BY created_at DESC",
                (category,),
            ).fetchall()
        else:
            rows = conn.execute(
                "SELECT * FROM memory_nodes ORDER BY created_at DESC"
            ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


# ─── Relation CRUD ────────────────────────────────────────────────────────────

def insert_relation(
    db_path: Path,
    rel_type: str,
    node_ids: list[str],
    roles: list[str],
    context: Optional[str] = None,
    description: Optional[str] = None,
) -> int:
    """Insert a relation and its participants atomically.

    Args:
        rel_type: relation type (因果关系/相关性/...)
        node_ids: list of participating node IDs
        roles: role for each node (cause/effect/component/whole/related/opponent)
        context: optional context tag (e.g. 'group_chat', 'main_session')
        description: human-readable description

    Returns:
        relation_id
    """
    assert len(node_ids) == len(roles), "node_ids and roles must have same length"
    assert rel_type in REL_TYPES, f"invalid rel_type: {rel_type}"
    assert len(node_ids) >= 2, "need at least 2 participants"

    conn = get_db(db_path)
    try:
        cursor = conn.execute(
            "INSERT INTO memory_relations (rel_type, context, description) VALUES (?, ?, ?)",
            (rel_type, context or DEFAULT_CONTEXT, description),
        )
        rel_id = cursor.lastrowid

        for node_id, role in zip(node_ids, roles):
            assert role in REL_ROLES, f"invalid role: {role}"
            conn.execute(
                "INSERT INTO memory_relation_participants (relation_id, node_id, role) VALUES (?, ?, ?)",
                (rel_id, node_id, role),
            )
        conn.commit()
        return rel_id
    finally:
        conn.close()


def delete_relation(db_path: Path, relation_id: int) -> None:
    conn = get_db(db_path)
    try:
        conn.execute("DELETE FROM memory_relation_participants WHERE relation_id = ?", (relation_id,))
        conn.execute("DELETE FROM memory_relations WHERE id = ?", (relation_id,))
        conn.commit()
    finally:
        conn.close()


def query_relations(
    db_path: Path,
    node_id: str,
    current_context: Optional[str] = None,
) -> list[dict[str, Any]]:
    """Query all relations involving a node, filtered by context.

    Rules:
    - context == NULL → always match (global/unconditional)
    - context == current_context → match
    - Otherwise → don't match
    """
    conn = get_db(db_path)
    try:
        # Get all relations this node participates in
        rows = conn.execute(
            """
            SELECT DISTINCT
                r.id          AS relation_id,
                r.rel_type,
                r.context,
                r.description,
                r.created_at,
                rp.role       AS my_role
            FROM memory_relations r
            JOIN memory_relation_participants rp ON rp.relation_id = r.id
            WHERE rp.node_id = ?
            ORDER BY r.created_at DESC
            """,
            (node_id,),
        ).fetchall()

        results = []
        for row in rows:
            r = dict(row)
            # Context filter
            if r["context"] is not None and r["context"] != (current_context or ""):
                continue
            # Get all participants for this relation
            participants = conn.execute(
                """
                SELECT node_id, role FROM memory_relation_participants
                WHERE relation_id = ?
                """,
                (r["relation_id"],),
            ).fetchall()
            r["participants"] = [dict(p) for p in participants]
            results.append(r)

        return results
    finally:
        conn.close()


def get_related_nodes(
    db_path: Path,
    node_id: str,
    current_context: Optional[str] = None,
    max_depth: int = 2,
) -> dict[str, Any]:
    """BFS traversal to get related nodes up to max_depth hops.

    Returns:
        dict keyed by node_id, each value has: node data, relations, distance (depth)
    """
    conn = get_db(db_path)
    try:
        visited: dict[str, dict[str, Any]] = {}
        frontier = {node_id}  # node_ids at current depth

        for depth in range(1, max_depth + 1):
            if not frontier:
                break
            next_frontier: set[str] = set()
            for nid in frontier:
                if nid in visited:
                    continue
                # Get node data
                node_row = conn.execute(
                    "SELECT * FROM memory_nodes WHERE id = ?", (nid,)
                ).fetchone()
                if not node_row:
                    continue
                visited[nid] = {
                    "node": dict(node_row),
                    "relations": [],
                    "depth": depth,
                }
                # Get relations
                rels = query_relations(db_path, nid, current_context)
                visited[nid]["relations"] = rels
                # Collect other participants as next frontier
                for rel in rels:
                    for p in rel["participants"]:
                        if p["node_id"] != nid and p["node_id"] not in visited:
                            next_frontier.add(p["node_id"])
            frontier = next_frontier

        return visited
    finally:
        conn.close()


# ─── Context Matching ────────────────────────────────────────────────────────

def match_context(relation_context: Optional[str], current: Optional[str]) -> bool:
    """Check if a relation's context matches the current session context."""
    if relation_context is None or relation_context == DEFAULT_CONTEXT:
        return True
    return relation_context == current


# ─── Semantic Search with Topology Enhancement ───────────────────────────────

def topology_aware_recall(
    db_path: Path,
    base_results: list[dict[str, Any]],
    current_context: Optional[str] = None,
    max_depth: int = 2,
    max_additional: int = 10,
) -> list[dict[str, Any]]:
    """Given base semantic search results, expand via topology.

    For each returned entry, query its relations and traverse the graph
    to find additional relevant entries.

    Returns expanded results with topology-added entries marked.
    """
    if not base_results:
        return []

    seen_ids = {r["id"] for r in base_results if "id" in r}
    topology_added: list[dict[str, Any]] = []

    for result in base_results:
        entry_id = result.get("id") or result.get("memory_id")
        if not entry_id:
            continue

        related = get_related_nodes(
            db_path, entry_id, current_context, max_depth
        )
        for node_id, data in related.items():
            if node_id in seen_ids:
                continue
            if len(topology_added) >= max_additional:
                break
            node = data["node"]
            # Convert node to entry-like format
            related_entry = {
                "id": node["id"],
                "category": node["category"],
                "chunk": node["chunk"],
                "source": "topology",
                "depth": data["depth"],
                "topology_relations": data["relations"],
            }
            topology_added.append(related_entry)
            seen_ids.add(node_id)

    return topology_added

/**
 * graph.ts
 * Graph relations for RemX — context-aware graph recall.
 *
 * Ported from topology.py (Python) → TypeScript.
 * Represents nodes (memory chunks) and typed relations between them.
 */

import Database from "better-sqlite3";
import { accessSync } from "fs";
import { join } from "path";

import { getDb, DEFAULT_DB } from "../core/db";

// ─── Constants ────────────────────────────────────────────────────────────────

export const REL_TYPES_ARRAY = [
  "因果关系",
  "相关性",
  "对立性",
  "流程顺序性",
  "组成性",
  "依赖性",
] as const;
export type RelType = typeof REL_TYPES_ARRAY[number];

export const REL_ROLES_ARRAY = [
  "cause",
  "effect",
  "component",
  "whole",
  "related",
  "opponent",
] as const;
export type RelRole = typeof REL_ROLES_ARRAY[number];

// For O(1) membership checks
export const REL_TYPES = new Set<RelType>(REL_TYPES_ARRAY);
export const REL_ROLES = new Set<RelRole>(REL_ROLES_ARRAY);

export const DEFAULT_CONTEXT = "global"; // 无条件全局可用

// ─── Types ────────────────────────────────────────────────────────────────────

export interface MemoryNode {
  id: string;
  category: string;
  chunk: string;
  created_at: number;
}

export interface MemoryRelation {
  id: number;
  rel_type: RelType;
  context: string | null;
  description: string | null;
  created_at: number;
}

export interface RelationParticipant {
  node_id: string;
  role: RelRole;
}

export interface RelationWithParticipants extends MemoryRelation {
  participants: RelationParticipant[];
  my_role?: RelRole;
}

export interface RelatedNodeData {
  node: MemoryNode;
  relations: RelationWithParticipants[];
  depth: number;
}

export interface QueryTriplesOptions {
  nodeId: string;
  context?: string;
  dbPath?: string;
}

// ─── Node CRUD ───────────────────────────────────────────────────────────────

export function ensureNode(dbPath: string, nodeId: string, category: string, chunk: string): void {
  const db = getDb(dbPath);
  try {
    db.prepare(
      "INSERT OR IGNORE INTO memory_nodes (id, category, chunk) VALUES (?, ?, ?)"
    ).run(nodeId, category, chunk);
  } finally {
    db.close();
  }
}

export function listNodes(
  dbPath: string,
  category?: string
): MemoryNode[] {
  const db = getDb(dbPath);
  try {
    const rows: MemoryNode[] = category
      ? (db
          .prepare("SELECT * FROM memory_nodes WHERE category = ? ORDER BY created_at DESC")
          .all(category) as MemoryNode[])
      : (db
          .prepare("SELECT * FROM memory_nodes ORDER BY created_at DESC")
          .all() as MemoryNode[]);
    return rows;
  } finally {
    db.close();
  }
}

export function getNode(dbPath?: string, nodeId?: string): MemoryNode | null {
  if (!nodeId) return null;
  const db = getDb(dbPath ?? DEFAULT_DB);
  try {
    return (db.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(nodeId) as MemoryNode) ?? null;
  } finally {
    db.close();
  }
}

export function deleteNode(dbPath: string, nodeId: string): void {
  const db = getDb(dbPath);
  try {
    db.prepare(`DELETE FROM memory_relations WHERE id IN (SELECT relation_id FROM memory_relation_participants WHERE node_id = ?)`).run(nodeId);
    db.prepare("DELETE FROM memory_nodes WHERE id = ?").run(nodeId);
  } finally {
    db.close();
  }
}

export function upsertNode(dbPath: string, nodeId: string, category: string, chunk: string): void {
  const db = getDb(dbPath);
  try {
    db.prepare(
      `INSERT INTO memory_nodes (id, category, chunk)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         category = excluded.category,
         chunk    = excluded.chunk`
    ).run(nodeId, category, chunk);
  } finally {
    db.close();
  }
}

export function queryTriples(opts: QueryTriplesOptions): Array<{
  id: number;
  rel_type: RelType;
  context: string | null;
  description: string | null;
  participants_raw: string;
}> {
  const { nodeId, context, dbPath } = opts;
  const db = getDb(dbPath);
  try {
    let sql = `
      SELECT DISTINCT
          r.id,
          r.rel_type,
          r.context,
          r.description,
          GROUP_CONCAT(p.node_id || ':' || p.role, ' | ') AS participants_raw
      FROM memory_relations r
      JOIN memory_relation_participants p ON p.relation_id = r.id
      WHERE r.id IN (
          SELECT relation_id FROM memory_relation_participants WHERE node_id = ?
      )`;
    const params: (string | number)[] = [nodeId];
    if (context) {
      if (context !== 'any') {
        sql += ` AND (r.context IS NULL OR r.context = ?)`;
        params.push(context);
      }
    }
    sql += ` GROUP BY r.id;`;
    return db.prepare(sql).all(...params) as Array<{
      id: number; rel_type: RelType; context: string | null;
      description: string | null; participants_raw: string;
    }>;
  } finally {
    db.close();
  }
}

export function deleteTriple(dbPath: string, relationId: number): void {
  deleteRelation(dbPath, relationId);
}

export function listTriples(dbPath: string, context?: string): Array<{
  id: number;
  rel_type: RelType;
  context: string | null;
  description: string | null;
  participants_raw: string;
}> {
  const db = getDb(dbPath);
  try {
    let sql = `
      SELECT
          r.id,
          r.rel_type,
          r.context,
          r.description,
          GROUP_CONCAT(p.node_id || ':' || p.role, ' | ') AS participants_raw
      FROM memory_relations r
      JOIN memory_relation_participants p ON p.relation_id = r.id`;
    const params: string[] = [];
    if (context) {
      if (context !== 'any') {
        sql += ` WHERE r.context = ? OR r.context IS NULL`;
        params.push(context);
      }
    }
    sql += ` GROUP BY r.id;`;
    return db.prepare(sql).all(...params) as ReturnType<typeof listTriples>;
  } finally {
    db.close();
  }
}

export function parseParticipants(raw: string): Array<{ node_id: string; role: string }> {
  if (!raw) return [];
  return raw.split(" | ").map((p) => {
    const [node_id, role] = p.split(":", 2);
    return { node_id, role };
  });
}

// ─── Relation CRUD ────────────────────────────────────────────────────────────

export interface InsertRelationOptions {
  relType: RelType;
  nodeIds: string[];
  roles: RelRole[];
  context?: string;
  description?: string;
  dbPath?: string;
}

export function insertRelation(opts: InsertRelationOptions): number {
  const { relType, nodeIds, roles, context, description, dbPath } = opts;
  if (nodeIds.length !== roles.length) {
    throw new Error("nodeIds and roles must have the same length");
  }
  if (!REL_TYPES.has(relType)) {
    throw new Error(`invalid rel_type: ${relType}`);
  }
  if (nodeIds.length < 2) {
    throw new Error("need at least 2 participants");
  }
  for (const role of roles) {
    if (!REL_ROLES.has(role)) {
      throw new Error(`invalid role: ${role}`);
    }
  }

  const db = getDb(dbPath ?? DEFAULT_DB);
  try {
    const ctx = context ?? DEFAULT_CONTEXT;
    const stmt = db.prepare(
      "INSERT INTO memory_relations (rel_type, context, description) VALUES (?, ?, ?)"
    );
    const result = stmt.run(relType, ctx, description ?? null);
    const relId = result.lastInsertRowid as number;

    const participantStmt = db.prepare(
      "INSERT INTO memory_relation_participants (relation_id, node_id, role) VALUES (?, ?, ?)"
    );
    for (let i = 0; i < nodeIds.length; i++) {
      participantStmt.run(relId, nodeIds[i], roles[i]);
    }
    return relId;
  } finally {
    db.close();
  }
}

export function deleteRelation(dbPath: string, relationId: number): void {
  const db = getDb(dbPath);
  try {
    db.prepare("DELETE FROM memory_relation_participants WHERE relation_id = ?").run(relationId);
    db.prepare("DELETE FROM memory_relations WHERE id = ?").run(relationId);
  } finally {
    db.close();
  }
}

export function queryRelations(
  dbPath: string,
  nodeId: string,
  currentContext?: string
): RelationWithParticipants[] {
  const db = getDb(dbPath);
  try {
    const rows = db
      .prepare(
        `
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
        `
      )
      .all(nodeId) as Array<{
      relation_id: number;
      rel_type: RelType;
      context: string | null;
      description: string | null;
      created_at: number;
      my_role: RelRole;
    }>;

    const results: RelationWithParticipants[] = [];
    for (const row of rows) {
      // Context filter: NULL = global always matches
      if (
        row.context != null &&
        row.context !== DEFAULT_CONTEXT &&
        currentContext != null &&
        currentContext !== DEFAULT_CONTEXT &&
        row.context !== currentContext
      ) {
        continue;
      }
      const participants = db
        .prepare(
          "SELECT node_id, role FROM memory_relation_participants WHERE relation_id = ?"
        )
        .all(row.relation_id) as RelationParticipant[];
      results.push({
        id: row.relation_id,
        rel_type: row.rel_type,
        context: row.context,
        description: row.description,
        created_at: row.created_at,
        my_role: row.my_role,
        participants,
      });
    }
    return results;
  } finally {
    db.close();
  }
}

// ─── Graph Traversal ─────────────────────────────────────────────────────────

export function getRelatedNodes(
  dbPath: string,
  nodeId: string,
  currentContext?: string,
  maxDepth: number = 2
): Record<string, RelatedNodeData> {
  const db = getDb(dbPath);
  try {
    const visited: Record<string, RelatedNodeData> = {};
    let frontier: Set<string> = new Set([nodeId]);
    let depth = 0;

    // BFS: maxDepth=N runs N iterations (depth 1..N), discovering next frontier at depth+1
    // maxDepth=1 → [node1,node2], maxDepth=2 → [node1,node2,node3,node4], maxDepth=3 → all 5
    while (depth <= maxDepth) {
      depth++;
      const nextFrontier: Set<string> = new Set();

      for (const nid of frontier) {
        if (nid in visited) continue;
        const nodeRow = db
          .prepare("SELECT * FROM memory_nodes WHERE id = ?")
          .get(nid) as MemoryNode | undefined;
        if (!nodeRow) continue;

        const rels = queryRelations(dbPath, nid, currentContext);

        visited[nid] = {
          node: nodeRow,
          relations: rels,
          depth,
        };
        for (const rel of rels) {
          for (const p of rel.participants) {
            if (p.node_id !== nid && !(p.node_id in visited)) {
              nextFrontier.add(p.node_id);
            }
          }
        }
      }
      frontier = nextFrontier;
    }
    return visited;
  } finally {
    db.close();
  }
}

// ─── Context Matching ────────────────────────────────────────────────────────

export function matchContext(
  relationContext: string | null,
  current: string | null
): boolean {
  if (relationContext == null || relationContext === DEFAULT_CONTEXT) {
    return true;
  }
  return relationContext === current;
}

// ─── Topology-Aware Recall ───────────────────────────────────────────────────

export interface BaseResult {
  id?: string;
  memory_id?: string;
  [key: string]: unknown;
}

export interface TopologyRecallOptions {
  dbPath?: string;
  currentContext?: string;
  maxDepth?: number;
  maxAdditional?: number;
}

export function topologyAwareRecall(
  baseResults: BaseResult[],
  opts: TopologyRecallOptions = {}
): Array<Record<string, unknown> & { source: "topology"; depth: number }> {
  const {
    dbPath = DEFAULT_DB,
    currentContext,
    maxDepth = 2,
    maxAdditional = 10,
  } = opts;

  if (baseResults.length === 0) return [];

  const seenIds = new Set<string>();
  for (const r of baseResults) {
    if (r.id) seenIds.add(r.id);
    if (r.memory_id) seenIds.add(r.memory_id);
  }

  const topologyAdded: Array<Record<string, unknown> & { source: "topology"; depth: number }> = [];

  for (const result of baseResults) {
    const entryId = result.id ?? result.memory_id;
    if (!entryId) continue;

    const related = getRelatedNodes(dbPath, entryId, currentContext, maxDepth);

    for (const [nodeId, data] of Object.entries(related)) {
      if (seenIds.has(nodeId)) continue;
      if (topologyAdded.length >= maxAdditional) break;

      const relatedEntry: Record<string, unknown> & { source: "topology"; depth: number } = {
        id: data.node.id,
        category: data.node.category,
        chunk: data.node.chunk,
        source: "topology",
        depth: data.depth,
        topology_relations: data.relations,
      };
      topologyAdded.push(relatedEntry as typeof topologyAdded[number]);
      seenIds.add(nodeId);
    }
  }

  return topologyAdded;
}

// ─── Triple Convenience Wrapper ──────────────────────────────────────────────

export interface InsertTripleOptions {
  relType: RelType;
  nodeIds: string[];
  roles?: RelRole[];
  context?: string;
  description?: string;
  dbPath?: string;
}

/**
 * Insert a new triple (relation + participants).
 * Ensures participant nodes exist before linking.
 */
export function insertTriple(opts: InsertTripleOptions): number {
  const { relType, nodeIds, roles = [], context, description, dbPath } = opts;

  // Ensure all participant nodes exist
  for (const nodeId of nodeIds) {
    ensureNode(dbPath ?? DEFAULT_DB, nodeId, "unknown", "");
  }

  const fullRoles: RelRole[] = roles.length >= nodeIds.length
    ? roles
    : [...roles, ...Array(nodeIds.length - roles.length).fill("related" as RelRole)];

  return insertRelation({
    relType,
    nodeIds,
    roles: fullRoles,
    context,
    description,
    dbPath,
  });
}

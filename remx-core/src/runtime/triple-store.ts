/**
 * triple-store.ts
 * Triple-Store CRUD — TypeScript implementation.
 *
 * Ported from triple-store.js (CommonJS JS) → TypeScript.
 * Wraps SQLite topology tables (memory_nodes, memory_relations,
 * memory_relation_participants) with a typed interface.
 */

import { join } from "path";
import Database from "better-sqlite3";

import { getDb, DEFAULT_DB } from "../shared/db";
import { insertRelation, deleteRelation, queryRelations, listNodes, ensureNode, type RelType, type RelRole, type MemoryNode } from "../memory/topology";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface TripleStoreOptions {
  dbPath?: string;
}

export interface InsertTripleOptions {
  relType: RelType;
  nodeIds: string[];
  roles?: RelRole[];
  context?: string;
  description?: string;
  dbPath?: string;
}

export interface QueryTriplesOptions {
  nodeId: string;
  context?: string;
  dbPath?: string;
}

export interface TripleRow {
  id: number;
  rel_type: RelType;
  context: string | null;
  description: string | null;
  participants: string; // GROUP_CONCAT result: "nodeId:role | ..."
}

// ─── Node Operations ─────────────────────────────────────────────────────────

export { ensureNode, listNodes };

export function getNode(dbPath?: string, nodeId?: string): MemoryNode | null {
  if (!nodeId) return null;
  const d = getDb(dbPath);
  try {
    return (d.prepare("SELECT * FROM memory_nodes WHERE id = ?").get(nodeId) as MemoryNode) ?? null;
  } finally {
    d.close();
  }
}

export function upsertNode(
  dbPath: string,
  nodeId: string,
  category: string,
  chunk: string
): void {
  const d = getDb(dbPath);
  try {
    d.prepare(
      `INSERT INTO memory_nodes (id, category, chunk)
       VALUES (?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         category = excluded.category,
         chunk    = excluded.chunk`
    ).run(nodeId, category, chunk);
  } finally {
    d.close();
  }
}

export function deleteNode(dbPath: string, nodeId: string): void {
  const d = getDb(dbPath);
  try {
    // Delete all relations that this node participates in (full relation removal, not just participant row)
    d.prepare(`DELETE FROM memory_relations WHERE id IN (SELECT relation_id FROM memory_relation_participants WHERE node_id = ?)`).run(nodeId);
    // Foreign key cascade will handle participant rows for the deleted relations
    // Then delete the node itself
    d.prepare("DELETE FROM memory_nodes WHERE id = ?").run(nodeId);
  } finally {
    d.close();
  }
}

// ─── Triple/Relation Operations ──────────────────────────────────────────────

/**
 * Insert a new triple (relation + participants).
 * Ensures participant nodes exist before linking.
 */
export function insertTriple(opts: InsertTripleOptions): number {
  const { relType, nodeIds, roles = [], context, description, dbPath } = opts;

  // Ensure all participant nodes exist (insert with minimal data if not)
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

/**
 * Query all triples (relations) involving a node.
 */
export function queryTriples(opts: QueryTriplesOptions): Array<{
  id: number;
  rel_type: RelType;
  context: string | null;
  description: string | null;
  participants_raw: string;
}> {
  const { nodeId, context, dbPath } = opts;
  const d = getDb(dbPath);
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
      if (context === 'any') {
        // 'any' is a wildcard: match all contexts (including NULL and any specific context)
        // No additional condition needed — all relations match
      } else {
        sql += ` AND (r.context IS NULL OR r.context = ?)`;
        params.push(context);
      }
    }
    sql += ` GROUP BY r.id;`;
    return d.prepare(sql).all(...params) as Array<{
      id: number;
      rel_type: RelType;
      context: string | null;
      description: string | null;
      participants_raw: string;
    }>;
  } finally {
    d.close();
  }
}

/**
 * Delete a triple by relation ID.
 */
export function deleteTriple(dbPath: string, relationId: number): void {
  deleteRelation(dbPath, relationId);
}

/**
 * List all triples (optionally filtered by context).
 */
export function listTriples(dbPath: string, context?: string): Array<{
  id: number;
  rel_type: RelType;
  context: string | null;
  description: string | null;
  participants_raw: string;
}> {
  const d = getDb(dbPath);
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
      if (context === 'any') {
        // 'any' is a wildcard: match all contexts (no filter)
      } else {
        sql += ` WHERE r.context = ? OR r.context IS NULL`;
        params.push(context);
      }
    }
    sql += ` GROUP BY r.id;`;
    return d.prepare(sql).all(...params) as ReturnType<typeof listTriples>;
  } finally {
    d.close();
  }
}

/**
 * Parse participants_raw string back to structured form.
 */
export function parseParticipants(raw: string): Array<{ node_id: string; role: string }> {
  if (!raw) return [];
  return raw.split(" | ").map((p) => {
    const [node_id, role] = p.split(":", 2);
    return { node_id, role };
  });
}

// ─── CLI entrypoint ────────────────────────────────────────────────────────────

export type CLICommand = "insert" | "query" | "delete" | "nodes" | "list";

export interface CLIRunOptions {
  cmd: CLICommand;
  args: string[];
  dbPath?: string;
}

export async function cliRun(opts: CLIRunOptions): Promise<void> {
  const { cmd, args, dbPath = DEFAULT_DB } = opts;

  switch (cmd) {
    case "insert": {
      const [relType, ...nodes] = args;
      if (!relType || nodes.length < 2) {
        throw new Error(
          "用法: insert <rel_type> <node_id1> <node_id2> [...] [--role cause,effect,...] [--context <ctx>]"
        );
      }
      const roleFlag = args.includes("--role");
      const ctxFlagIdx = args.indexOf("--context");
      const roles: RelRole[] = roleFlag
        ? ((args[args.indexOf("--role") + 1] ?? "").split(",") as RelRole[])
        : [];
      const ctx = ctxFlagIdx !== -1 ? args[ctxFlagIdx + 1] : undefined;
      const relId = insertTriple({ relType: relType as RelType, nodeIds: nodes, roles, context: ctx, dbPath });
      console.log(`created relation #${relId} (${relType}) with ${nodes.length} participants`);
      break;
    }

    case "query": {
      const [nodeId] = args;
      if (!nodeId) throw new Error("用法: query <node_id> [--context <ctx>]");
      const ctxFlagIdx = args.indexOf("--context");
      const ctx = ctxFlagIdx !== -1 ? args[ctxFlagIdx + 1] : undefined;
      const results = queryTriples({ nodeId, context: ctx, dbPath });
      if (results.length === 0) {
        console.log("(no relations found)");
      } else {
        console.log(JSON.stringify(results, null, 2));
      }
      break;
    }

    case "delete": {
      const [relId] = args;
      if (!relId) throw new Error("用法: delete <relation_id>");
      deleteTriple(dbPath, Number(relId));
      console.log(`deleted relation #${relId}`);
      break;
    }

    case "nodes": {
      const catFlagIdx = args.indexOf("--category");
      const cat = catFlagIdx !== -1 ? args[catFlagIdx + 1] : undefined;
      const nodes = listNodes(dbPath, cat);
      if (nodes.length === 0) {
        console.log("(no nodes)");
      } else {
        console.log(JSON.stringify(nodes, null, 2));
      }
      break;
    }

    case "list": {
      const ctxFlagIdx = args.indexOf("--context");
      const ctx = ctxFlagIdx !== -1 ? args[ctxFlagIdx + 1] : undefined;
      const triples = listTriples(dbPath, ctx);
      if (triples.length === 0) {
        console.log("(no relations)");
      } else {
        console.log(JSON.stringify(triples, null, 2));
      }
      break;
    }

    default:
      throw new Error(`unknown command: ${cmd}. Available: insert, query, delete, nodes, list`);
  }
}

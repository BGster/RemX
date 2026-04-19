/**
 * graph.test.ts
 * Unit tests for remx-core/src/memory/graph.ts
 *
 * Covers: REL_TYPES / REL_ROLES constants, Node CRUD,
 * Relation CRUD, Graph Traversal (BFS), Context Matching,
 * and Topology-Aware Recall.
 *
 * Uses an ephemeral in-memory SQLite database per test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  REL_TYPES_ARRAY,
  REL_ROLES_ARRAY,
  REL_TYPES,
  REL_ROLES,
  DEFAULT_CONTEXT,
  ensureNode,
  listNodes,
  getNode,
  deleteNode,
  insertRelation,
  deleteRelation,
  queryRelations,
  getRelatedNodes,
  matchContext,
  topologyAwareRecall,
  type RelType,
  type RelRole,
} from "../src/memory/graph";
import { initDb } from "../src/memory/memory";
import { join } from "path";
import { mkdtempSync, rmSync } from "fs";

// ─── Test DB factory ──────────────────────────────────────────────────────────

let _testDbCounter = 0;
function freshDb(): { path: string; close: () => void } {
  const n = ++_testDbCounter;
  const path = join(process.env.TEMP ?? "/tmp", `remx-topology-test-${n}.sqlite`);
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // initDb creates all tables including topology tables
  initDb(path);
  return {
    path,
    close: () => {
      db.close();
      try {
        rmSync(path, { force: true });
        rmSync(path + "-wal", { force: true });
        rmSync(path + "-shm", { force: true });
      } catch {}
    },
  };
}

// ─── Constants ────────────────────────────────────────────────────────────────

describe("Constants", () => {
  it("REL_TYPES_ARRAY has 6 valid Chinese relation types", () => {
    expect(REL_TYPES_ARRAY).toHaveLength(6);
    expect(REL_TYPES_ARRAY).toContain("因果关系");
    expect(REL_TYPES_ARRAY).toContain("相关性");
    expect(REL_TYPES_ARRAY).toContain("对立性");
    expect(REL_TYPES_ARRAY).toContain("流程顺序性");
    expect(REL_TYPES_ARRAY).toContain("组成性");
    expect(REL_TYPES_ARRAY).toContain("依赖性");
  });

  it("REL_ROLES_ARRAY has expected roles", () => {
    expect(REL_ROLES_ARRAY).toContain("cause");
    expect(REL_ROLES_ARRAY).toContain("effect");
    expect(REL_ROLES_ARRAY).toContain("related");
  });

  it("REL_TYPES is a Set with all rel_types", () => {
    expect(REL_TYPES.has("因果关系")).toBe(true);
    expect(REL_TYPES.has("相关性")).toBe(true);
    expect(REL_TYPES.has("invalid")).toBe(false);
  });

  it("REL_ROLES is a Set with all roles", () => {
    expect(REL_ROLES.has("cause")).toBe(true);
    expect(REL_ROLES.has("effect")).toBe(true);
    expect(REL_ROLES.has("unknown")).toBe(false);
  });

  it("DEFAULT_CONTEXT is 'global'", () => {
    expect(DEFAULT_CONTEXT).toBe("global");
  });
});

// ─── Node CRUD ────────────────────────────────────────────────────────────────

describe("Node CRUD", () => {
  let db: { path: string; close: () => void };

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it("ensureNode inserts a node and getNode retrieves it", () => {
    ensureNode(db.path, "node1", "knowledge", "Some memory chunk");
    const node = getNode(db.path, "node1");
    expect(node).not.toBeNull();
    expect(node!.id).toBe("node1");
    expect(node!.category).toBe("knowledge");
    expect(node!.chunk).toBe("Some memory chunk");
  });

  it("ensureNode is idempotent — no error on duplicate", () => {
    ensureNode(db.path, "node1", "knowledge", "First");
    ensureNode(db.path, "node1", "knowledge", "Second"); // should not throw
    const nodes = listNodes(db.path);
    expect(nodes).toHaveLength(1);
  });

  it("listNodes returns all nodes ordered by created_at DESC", () => {
    ensureNode(db.path, "node1", "knowledge", "Chunk 1");
    ensureNode(db.path, "node2", "principle", "Chunk 2");
    const nodes = listNodes(db.path);
    expect(nodes).toHaveLength(2);
    // Most recently inserted first
    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual(["node1", "node2"]);
  });

  it("listNodes with category filter returns only matching nodes", () => {
    ensureNode(db.path, "node1", "knowledge", "Chunk 1");
    ensureNode(db.path, "node2", "principle", "Chunk 2");
    ensureNode(db.path, "node3", "knowledge", "Chunk 3");
    const knowledgeNodes = listNodes(db.path, "knowledge");
    expect(knowledgeNodes).toHaveLength(2);
    expect(knowledgeNodes.every((n) => n.category === "knowledge")).toBe(true);
  });

  it("deleteNode removes the node", () => {
    ensureNode(db.path, "node1", "knowledge", "Chunk");
    deleteNode(db.path, "node1");
    expect(getNode(db.path, "node1")).toBeNull();
    expect(listNodes(db.path)).toHaveLength(0);
  });

  it("getNode returns null for non-existent node", () => {
    expect(getNode(db.path, "nonexistent")).toBeNull();
  });

  it("listNodes returns empty array when no nodes exist", () => {
    expect(listNodes(db.path)).toHaveLength(0);
  });
});

// ─── Relation CRUD ────────────────────────────────────────────────────────────

describe("Relation CRUD", () => {
  let db: { path: string; close: () => void };

  beforeEach(() => {
    db = freshDb();
    // Insert two nodes that will be participants
    ensureNode(db.path, "nodeA", "knowledge", "Chunk A");
    ensureNode(db.path, "nodeB", "knowledge", "Chunk B");
    ensureNode(db.path, "nodeC", "principle", "Chunk C");
  });
  afterEach(() => db.close());

  it("insertRelation creates a relation and returns its numeric ID", () => {
    const relId = insertRelation({
      relType: "因果关系",
      nodeIds: ["nodeA", "nodeB"],
      roles: ["cause", "effect"],
      dbPath: db.path,
    });
    expect(typeof relId).toBe("number");
    expect(relId).toBeGreaterThan(0);
  });

  it("insertRelation with context stores the context", () => {
    const relId = insertRelation({
      relType: "相关性",
      nodeIds: ["nodeA", "nodeB"],
      roles: ["cause", "effect"],
      context: "main_session",
      description: "A and B are related",
      dbPath: db.path,
    });
    const rels = queryRelations(db.path, "nodeA", "main_session");
    expect(rels).toHaveLength(1);
    expect(rels[0].context).toBe("main_session");
    expect(rels[0].description).toBe("A and B are related");
  });

  it("insertRelation throws if rel_type is invalid", () => {
    expect(() =>
      insertRelation({
        relType: "invalid_type" as RelType,
        nodeIds: ["nodeA", "nodeB"],
        roles: ["cause", "effect"],
        dbPath: db.path,
      })
    ).toThrow("invalid rel_type");
  });

  it("insertRelation throws if a role is invalid", () => {
    expect(() =>
      insertRelation({
        relType: "因果关系",
        nodeIds: ["nodeA", "nodeB"],
        roles: ["cause", "not_a_role" as RelRole],
        dbPath: db.path,
      })
    ).toThrow("invalid role");
  });

  it("insertRelation throws if nodeIds and roles lengths mismatch", () => {
    expect(() =>
      insertRelation({
        relType: "因果关系",
        nodeIds: ["nodeA", "nodeB"],
        roles: ["cause"], // only 1 role for 2 nodes
        dbPath: db.path,
      })
    ).toThrow("same length");
  });

  it("insertRelation throws if fewer than 2 participants", () => {
    expect(() =>
      insertRelation({
        relType: "因果关系",
        nodeIds: ["nodeA"],
        roles: ["cause"],
        dbPath: db.path,
      })
    ).toThrow("need at least 2 participants");
  });

  it("queryRelations returns relations for a node", () => {
    insertRelation({
      relType: "相关性",
      nodeIds: ["nodeA", "nodeB"],
      roles: ["related", "related"],
      dbPath: db.path,
    });
    const rels = queryRelations(db.path, "nodeA");
    expect(rels).toHaveLength(1);
    expect(rels[0].rel_type).toBe("相关性");
    expect(rels[0].participants).toHaveLength(2);
  });

  it("queryRelations filters by currentContext", () => {
    insertRelation({
      relType: "相关性",
      nodeIds: ["nodeA", "nodeB"],
      roles: ["related", "related"],
      context: "group_chat",
      dbPath: db.path,
    });
    // Without context filter, should return
    expect(queryRelations(db.path, "nodeA")).toHaveLength(1);
    // With wrong context, should be filtered out
    expect(queryRelations(db.path, "nodeA", "main_session")).toHaveLength(0);
    // With matching context, should return
    expect(queryRelations(db.path, "nodeA", "group_chat")).toHaveLength(1);
  });

  it("queryRelations returns null context (global) regardless of currentContext", () => {
    insertRelation({
      relType: "因果关系",
      nodeIds: ["nodeA", "nodeB"],
      roles: ["cause", "effect"],
      // no context → global
      dbPath: db.path,
    });
    expect(queryRelations(db.path, "nodeA", "any_context")).toHaveLength(1);
    expect(queryRelations(db.path, "nodeA")).toHaveLength(1);
  });

  it("deleteRelation removes the relation", () => {
    const relId = insertRelation({
      relType: "相关性",
      nodeIds: ["nodeA", "nodeB"],
      roles: ["related", "related"],
      dbPath: db.path,
    });
    deleteRelation(db.path, relId);
    expect(queryRelations(db.path, "nodeA")).toHaveLength(0);
    expect(queryRelations(db.path, "nodeB")).toHaveLength(0);
  });

  it("queryRelations includes my_role for the originating node", () => {
    insertRelation({
      relType: "组成性",
      nodeIds: ["nodeA", "nodeB", "nodeC"],
      roles: ["whole", "component", "component"],
      dbPath: db.path,
    });
    const rels = queryRelations(db.path, "nodeB");
    expect(rels).toHaveLength(1);
    expect(rels[0].my_role).toBe("component");
  });

  it("participants are returned for each relation", () => {
    insertRelation({
      relType: "依赖性",
      nodeIds: ["nodeA", "nodeB", "nodeC"],
      roles: ["cause", "effect", "effect"],
      dbPath: db.path,
    });
    const rels = queryRelations(db.path, "nodeA");
    expect(rels[0].participants).toHaveLength(3);
    const roles = rels[0].participants.map((p) => p.role);
    expect(roles).toContain("cause");
    expect(roles).toContain("effect");
  });
});

// ─── Graph Traversal ─────────────────────────────────────────────────────────

describe("Graph Traversal (BFS)", () => {
  let db: { path: string; close: () => void };

  beforeEach(() => {
    db = freshDb();
    // Build a graph:
    //   node1 --因果关系--> node2 --相关性--> node3
    //   node2 --组成性--> node4
    //   node3 --对立性--> node5
    ensureNode(db.path, "node1", "knowledge", "Chunk 1");
    ensureNode(db.path, "node2", "knowledge", "Chunk 2");
    ensureNode(db.path, "node3", "principle", "Chunk 3");
    ensureNode(db.path, "node4", "demand", "Chunk 4");
    ensureNode(db.path, "node5", "issue", "Chunk 5");

    insertRelation({ relType: "因果关系", nodeIds: ["node1", "node2"], roles: ["cause", "effect"], dbPath: db.path });
    insertRelation({ relType: "相关性", nodeIds: ["node2", "node3"], roles: ["related", "related"], dbPath: db.path });
    insertRelation({ relType: "组成性", nodeIds: ["node2", "node4"], roles: ["whole", "component"], dbPath: db.path });
    insertRelation({ relType: "对立性", nodeIds: ["node3", "node5"], roles: ["opponent", "opponent"], dbPath: db.path });
  });
  afterEach(() => db.close());

  it("getRelatedNodes at depth 1 finds direct neighbors", () => {
    // while(depth <= maxDepth): maxDepth=1 runs 2 iterations → node1@1, node2@2
    const result = getRelatedNodes(db.path, "node1", undefined, 1);
    const ids = Object.keys(result);
    expect(ids).toContain("node1");
    expect(ids).toContain("node2");
    expect(ids).not.toContain("node3"); // depth 3
    expect(ids).not.toContain("node4"); // depth 3
  });

  it("getRelatedNodes at depth 2 traverses two hops", () => {
    // while(depth <= maxDepth): maxDepth=2 runs 3 iterations → [node1,node2,node3,node4]
    const result = getRelatedNodes(db.path, "node1", undefined, 2);
    const ids = Object.keys(result);
    expect(ids).toContain("node1");
    expect(ids).toContain("node2");
    expect(ids).toContain("node3");
    expect(ids).toContain("node4");
    expect(ids).not.toContain("node5"); // depth 4
  });

  it("getRelatedNodes at maxDepth 3 reaches all reachable nodes", () => {
    // while(depth <= maxDepth): maxDepth=3 runs 4 iterations → reaches node5 (dist 4)
    const result = getRelatedNodes(db.path, "node1", undefined, 3);
    const ids = Object.keys(result);
    expect(ids).toHaveLength(5); // all 5 nodes reachable
    expect(ids).toContain("node5");
  });

  it("getRelatedNodes respects context filter", () => {
    // Insert a depth-2 relation scoped to 'group_chat'
    insertRelation({
      relType: "因果关系",
      nodeIds: ["node2", "node3"],
      roles: ["cause", "effect"],
      context: "group_chat",
      dbPath: db.path,
    });
    // 'global' context matches global/null relations (not group_chat)
    // 'main_session' context also matches global/null relations
    // The group_chat relation (node2→node3) is NOT matched by either
    const resultGlobal = getRelatedNodes(db.path, "node1", "global", 2);
    const resultSession = getRelatedNodes(db.path, "node1", "main_session", 2);
    // With 'global': traverses node1→node2(global), then node2→node3(global via 相关性) and node2→node4(global)
    // maxDepth=2: iterations 1,2 → [node1,node2,node3,node4]
    expect(Object.keys(resultGlobal)).toContain("node3");
    expect(Object.keys(resultGlobal)).toContain("node4");
    // With 'main_session': same traversal (global matches main_session too)
    // maxDepth=2: [node1,node2,node3,node4]
    const idsSession = Object.keys(resultSession);
    expect(idsSession).toContain("node1");
    expect(idsSession).toContain("node2");
    expect(idsSession).toContain("node3"); // via node2→node3(global 相关性)
    expect(idsSession).toContain("node4"); // via node2→node4(global 组成性)
    // node3 IS reachable in both: the global relation node2→node3 (相关性) exists
  });

  it("getRelatedNodes returns correct depth per node", () => {
    // while(depth <= maxDepth): depth = iteration number (1-indexed)
    // maxDepth=3: 4 iterations (depth 1,2,3,4) → node1@1, node2@2, node3@3, node4@3, node5@4
    const result = getRelatedNodes(db.path, "node1", undefined, 3);
    expect(result["node1"].depth).toBe(1);
    expect(result["node2"].depth).toBe(2);
    expect(result["node3"].depth).toBe(3);
    expect(result["node4"].depth).toBe(3);
    expect(result["node5"].depth).toBe(4);
  });

  it("getRelatedNodes returns relations array for each visited node", () => {
    const result = getRelatedNodes(db.path, "node1", undefined, 2);
    expect(result["node2"].relations.length).toBeGreaterThan(0);
  });

  it("getRelatedNodes handles a node with no relations", () => {
    ensureNode(db.path, "orphan", "tmp", "Orphan node");
    const result = getRelatedNodes(db.path, "orphan", undefined, 2);
    expect(Object.keys(result)).toHaveLength(1);
    expect(result["orphan"]).toBeDefined();
  });

  it("getRelatedNodes handles non-existent start node gracefully", () => {
    const result = getRelatedNodes(db.path, "does_not_exist", undefined, 2);
    expect(result).toEqual({});
  });
});

// ─── Context Matching ─────────────────────────────────────────────────────────

describe("matchContext", () => {
  it("null relationContext always matches (global)", () => {
    expect(matchContext(null, null)).toBe(true);
    expect(matchContext(null, "main_session")).toBe(true);
    expect(matchContext(null, "group_chat")).toBe(true);
  });

  it("'global' relationContext always matches", () => {
    expect(matchContext("global", null)).toBe(true);
    expect(matchContext("global", "any_context")).toBe(true);
  });

  it("specific context matches only exact current context", () => {
    expect(matchContext("main_session", "main_session")).toBe(true);
    expect(matchContext("main_session", "group_chat")).toBe(false);
    expect(matchContext("main_session", null)).toBe(false);
  });
});

// ─── Topology-Aware Recall ───────────────────────────────────────────────────

describe("topologyAwareRecall", () => {
  let db: { path: string; close: () => void };

  beforeEach(() => {
    db = freshDb();
    ensureNode(db.path, "seed1", "knowledge", "Seed knowledge chunk");
    ensureNode(db.path, "related1", "principle", "Related principle");
    ensureNode(db.path, "related2", "demand", "Related demand");
    ensureNode(db.path, "far_away", "tmp", "Far away");

    insertRelation({
      relType: "因果关系",
      nodeIds: ["seed1", "related1"],
      roles: ["cause", "effect"],
      dbPath: db.path,
    });
    insertRelation({
      relType: "相关性",
      nodeIds: ["related1", "related2"],
      roles: ["related", "related"],
      dbPath: db.path,
    });
  });
  afterEach(() => db.close());

  it("returns empty array when baseResults is empty", () => {
    expect(topologyAwareRecall([], { dbPath: db.path })).toEqual([]);
  });

  it("returns empty array when baseResults have no id or memory_id", () => {
    expect(topologyAwareRecall([{ chunk: "no id" } as any], { dbPath: db.path })).toEqual([]);
  });

  it("expands from base result ids via topology graph", () => {
    const base = [{ id: "seed1" }];
    const expanded = topologyAwareRecall(base, { dbPath: db.path, maxDepth: 2, maxAdditional: 10 });
    const ids = expanded.map((r) => r.id as string);
    expect(ids).toContain("related1");
    expect(ids).toContain("related2"); // depth 2 via related1
  });

  it("respects maxAdditional limit", () => {
    ensureNode(db.path, "extra1", "tmp", "Extra 1");
    ensureNode(db.path, "extra2", "tmp", "Extra 2");
    insertRelation({ relType: "相关性", nodeIds: ["related2", "extra1"], roles: ["related", "related"], dbPath: db.path });
    insertRelation({ relType: "相关性", nodeIds: ["related2", "extra2"], roles: ["related", "related"], dbPath: db.path });

    const base = [{ id: "seed1" }];
    const expanded = topologyAwareRecall(base, { dbPath: db.path, maxDepth: 3, maxAdditional: 1 });
    expect(expanded.length).toBeLessThanOrEqual(1);
  });

  it("does not include nodes already in baseResults", () => {
    const base = [{ id: "seed1" }, { id: "related1" }];
    const expanded = topologyAwareRecall(base, { dbPath: db.path, maxDepth: 2, maxAdditional: 10 });
    const ids = expanded.map((r) => r.id as string);
    expect(ids).not.toContain("seed1");
    expect(ids).not.toContain("related1");
  });

  it("each result has source='topology' and depth", () => {
    const base = [{ id: "seed1" }];
    const expanded = topologyAwareRecall(base, { dbPath: db.path, maxDepth: 2, maxAdditional: 10 });
    for (const r of expanded) {
      expect(r.source).toBe("topology");
      expect(typeof r.depth).toBe("number");
    }
  });

  it("respects maxDepth", () => {
    const base = [{ id: "seed1" }];
    const depth1Only = topologyAwareRecall(base, { dbPath: db.path, maxDepth: 1, maxAdditional: 10 });
    expect(depth1Only.map((r) => r.id as string)).not.toContain("related2"); // depth 2
  });

  it("topologyAwareRecall uses memory_id as fallback id", () => {
    const base = [{ memory_id: "seed1" }];
    const expanded = topologyAwareRecall(base, { dbPath: db.path, maxDepth: 1, maxAdditional: 10 });
    const ids = expanded.map((r) => r.id as string);
    expect(ids).toContain("related1");
  });
});

/**
 * triple-store.test.ts
 * Unit tests for remx-core/src/runtime/triple-store.ts
 *
 * Covers: Schema init, Node operations (via topology re-exports),
 * Triple operations (insertTriple, queryTriples, deleteTriple, listTriples),
 * and parseParticipants helper.
 *
 * Uses an ephemeral in-memory SQLite database per test suite.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  ensureNode,
  listNodes,
  getNode,
  upsertNode,
  deleteNode,
  insertTriple,
  queryTriples,
  deleteTriple,
  listTriples,
  parseParticipants,
} from "../src/runtime/triple-store";
import { initDb } from "../src/runtime/db";
import { join } from "path";
import { rmSync } from "fs";

let _counter = 0;
function freshDb(): { path: string; close: () => void } {
  const n = ++_counter;
  const path = join(process.env.TEMP ?? "/tmp", `remx-triple-test-${n}.sqlite`);
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

// ─── Schema Init ──────────────────────────────────────────────────────────────

describe("initSchema", () => {
  it("initSchema creates all required tables without error", () => {
    const db = freshDb();
    // Schema already inited by freshDb(); just verify the tables exist
    const tables = db.path; // just use path
    const verifier = new Database(tables);
    const result = verifier
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name"
      )
      .all() as Array<{ name: string }>;
    verifier.close();
    const names = result.map((r) => r.name);
    expect(names).toContain("memory_nodes");
    expect(names).toContain("memory_relations");
    expect(names).toContain("memory_relation_participants");
    db.close();
  });
});

// ─── Node Operations ──────────────────────────────────────────────────────────

describe("Node Operations", () => {
  let db: { path: string; close: () => void };

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it("ensureNode creates a node", () => {
    ensureNode(db.path, "n1", "knowledge", "Memory chunk content");
    const node = getNode(db.path, "n1");
    expect(node).not.toBeNull();
    expect(node!.id).toBe("n1");
    expect(node!.category).toBe("knowledge");
    expect(node!.chunk).toBe("Memory chunk content");
  });

  it("listNodes returns all nodes", () => {
    ensureNode(db.path, "n1", "knowledge", "C1");
    ensureNode(db.path, "n2", "principle", "C2");
    const nodes = listNodes(db.path);
    expect(nodes).toHaveLength(2);
  });

  it("listNodes with category filter", () => {
    ensureNode(db.path, "n1", "knowledge", "C1");
    ensureNode(db.path, "n2", "principle", "C2");
    ensureNode(db.path, "n3", "knowledge", "C3");
    const knowledgeNodes = listNodes(db.path, "knowledge");
    expect(knowledgeNodes).toHaveLength(2);
    expect(knowledgeNodes.every((n) => n.category === "knowledge")).toBe(true);
  });

  it("upsertNode updates existing node", () => {
    ensureNode(db.path, "n1", "knowledge", "Original chunk");
    upsertNode(db.path, "n1", "principle", "Updated chunk");
    const node = getNode(db.path, "n1");
    expect(node!.category).toBe("principle");
    expect(node!.chunk).toBe("Updated chunk");
  });

  it("upsertNode inserts if not exists", () => {
    upsertNode(db.path, "new_node", "demand", "Demand chunk");
    const node = getNode(db.path, "new_node");
    expect(node).not.toBeNull();
    expect(node!.category).toBe("demand");
  });

  it("deleteNode removes node", () => {
    ensureNode(db.path, "n1", "knowledge", "C1");
    deleteNode(db.path, "n1");
    expect(getNode(db.path, "n1")).toBeNull();
    expect(listNodes(db.path)).toHaveLength(0);
  });

  it("getNode returns null for non-existent node", () => {
    expect(getNode(db.path, "nonexistent")).toBeNull();
  });

  it("getNode with no nodeId returns null", () => {
    expect(getNode(db.path)).toBeNull();
  });
});

// ─── Triple Operations ────────────────────────────────────────────────────────

describe("Triple Operations", () => {
  let db: { path: string; close: () => void };

  beforeEach(() => {
    db = freshDb();
    // Insert some nodes to be participants
    ensureNode(db.path, "nodeX", "knowledge", "Chunk X");
    ensureNode(db.path, "nodeY", "principle", "Chunk Y");
    ensureNode(db.path, "nodeZ", "demand", "Chunk Z");
  });
  afterEach(() => db.close());

  it("insertTriple creates a relation and returns its ID", () => {
    const relId = insertTriple({
      relType: "因果关系",
      nodeIds: ["nodeX", "nodeY"],
      roles: ["cause", "effect"],
      dbPath: db.path,
    });
    expect(typeof relId).toBe("number").toBe;
    expect(relId).toBeGreaterThan(0);
  });

  it("insertTriple auto-creates participant nodes that don't exist", () => {
    const relId = insertTriple({
      relType: "相关性",
      nodeIds: ["brand_new_X", "brand_new_Y"],
      roles: ["related", "related"],
      dbPath: db.path,
    });
    expect(typeof relId).toBe("number");
    expect(getNode(db.path, "brand_new_X")).not.toBeNull();
    expect(getNode(db.path, "brand_new_Y")).not.toBeNull();
  });

  it("insertTriple fills missing roles with 'related'", () => {
    // 3 nodes but only 1 role provided
    ensureNode(db.path, "nodeA", "tmp", "A");
    ensureNode(db.path, "nodeB", "tmp", "B");
    ensureNode(db.path, "nodeC", "tmp", "C");
    const relId = insertTriple({
      relType: "相关性",
      nodeIds: ["nodeA", "nodeB", "nodeC"],
      roles: ["cause"], // only 1 role
      dbPath: db.path,
    });
    const triples = queryTriples({ nodeId: "nodeA", dbPath: db.path });
    expect(triples).toHaveLength(1);
    // participants_raw should contain all 3 nodes
    expect(triples[0].participants_raw).toContain("nodeA");
    expect(triples[0].participants_raw).toContain("nodeB");
    expect(triples[0].participants_raw).toContain("nodeC");
  });

  it("insertTriple with context and description", () => {
    const relId = insertTriple({
      relType: "组成性",
      nodeIds: ["nodeX", "nodeY"],
      roles: ["whole", "component"],
      context: "main_session",
      description: "X is the whole, Y is a component",
      dbPath: db.path,
    });
    const triples = queryTriples({ nodeId: "nodeX", context: "main_session", dbPath: db.path });
    expect(triples).toHaveLength(1);
    expect(triples[0].context).toBe("main_session");
    expect(triples[0].description).toBe("X is the whole, Y is a component");
    expect(triples[0].rel_type).toBe("组成性");
  });

  it("queryTriples returns triples for a node", () => {
    insertTriple({ relType: "相关性", nodeIds: ["nodeX", "nodeY"], roles: ["related", "related"], dbPath: db.path });
    insertTriple({ relType: "因果关系", nodeIds: ["nodeY", "nodeZ"], roles: ["cause", "effect"], dbPath: db.path });
    const triples = queryTriples({ nodeId: "nodeY", dbPath: db.path });
    expect(triples).toHaveLength(2);
  });

  it("queryTriples with context filter", () => {
    insertTriple({ relType: "相关性", nodeIds: ["nodeX", "nodeY"], context: "group_chat", dbPath: db.path });
    expect(queryTriples({ nodeId: "nodeX", context: "group_chat", dbPath: db.path })).toHaveLength(1);
    expect(queryTriples({ nodeId: "nodeX", context: "main_session", dbPath: db.path })).toHaveLength(0);
    // null context (global) should also match
    insertTriple({ relType: "相关性", nodeIds: ["nodeX", "nodeY"], dbPath: db.path }); // global
    expect(queryTriples({ nodeId: "nodeX", context: "any", dbPath: db.path })).toHaveLength(2); // global + any
  });

  it("queryTriples returns participants_raw string", () => {
    insertTriple({ relType: "相关性", nodeIds: ["nodeX", "nodeY"], roles: ["cause", "effect"], dbPath: db.path });
    const triples = queryTriples({ nodeId: "nodeX", dbPath: db.path });
    expect(triples[0].participants_raw).toContain("nodeX");
    expect(triples[0].participants_raw).toContain("nodeY");
  });

  it("deleteTriple removes the relation", () => {
    const relId = insertTriple({ relType: "相关性", nodeIds: ["nodeX", "nodeY"], roles: ["related", "related"], dbPath: db.path });
    deleteTriple(db.path, relId);
    expect(queryTriples({ nodeId: "nodeX", dbPath: db.path })).toHaveLength(0);
    expect(queryTriples({ nodeId: "nodeY", dbPath: db.path })).toHaveLength(0);
  });

  it("listTriples returns all triples in the DB", () => {
    insertTriple({ relType: "因果关系", nodeIds: ["nodeX", "nodeY"], roles: ["cause", "effect"], dbPath: db.path });
    insertTriple({ relType: "相关性", nodeIds: ["nodeY", "nodeZ"], roles: ["related", "related"], dbPath: db.path });
    const all = listTriples(db.path);
    expect(all).toHaveLength(2);
  });

  it("listTriples with context filter", () => {
    insertTriple({ relType: "因果关系", nodeIds: ["nodeX", "nodeY"], context: "main_session", dbPath: db.path });
    insertTriple({ relType: "相关性", nodeIds: ["nodeY", "nodeZ"], dbPath: db.path }); // global
    expect(listTriples(db.path, "main_session")).toHaveLength(1);
    expect(listTriples(db.path, "group_chat")).toHaveLength(0); // global doesn't match specific
    expect(listTriples(db.path)).toHaveLength(2); // all
  });

  it("listTriples returns empty array when no relations exist", () => {
    expect(listTriples(db.path)).toHaveLength(0);
  });

  it("queryTriples returns empty for node with no relations", () => {
    ensureNode(db.path, "orphan", "tmp", "Orphan");
    expect(queryTriples({ nodeId: "orphan", dbPath: db.path })).toHaveLength(0);
  });
});

// ─── parseParticipants ────────────────────────────────────────────────────────

describe("parseParticipants", () => {
  it("parses a simple participants_raw string", () => {
    const result = parseParticipants("nodeA:cause | nodeB:effect");
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ node_id: "nodeA", role: "cause" });
    expect(result[1]).toEqual({ node_id: "nodeB", role: "effect" });
  });

  it("handles multiple participants", () => {
    const result = parseParticipants("nodeA:whole | nodeB:component | nodeC:component");
    expect(result).toHaveLength(3);
    expect(result[2]).toEqual({ node_id: "nodeC", role: "component" });
  });

  it("returns empty array for empty input", () => {
    expect(parseParticipants("")).toHaveLength(0);
    expect(parseParticipants(undefined as any as string)).toHaveLength(0);
  });

  it("handles colons in node IDs (edge case — known limitation)", () => {
    // NOTE: parseParticipants splits on ALL colons (p.split(":") not p.split(":", 2)),
    // so node IDs containing ':' will not parse correctly.
    // This test documents the actual (buggy) behavior as known limitation.
    const result = parseParticipants("ns:node1:cause | ns:node2:effect");
    expect(result[0].node_id).toBe("ns");
    // Due to split(':') splitting all colons, the role is incorrectly "node1"
    // (should be "node1:cause" if split only on first colon)
    expect(result[0].role).toBe("node1");
    // Known limitation: "cause | ns" part is silently lost
  });
});

// ─── Upsert Node ─────────────────────────────────────────────────────────────

describe("upsertNode", () => {
  let db: { path: string; close: () => void };

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it("upsertNode creates node if not present", () => {
    upsertNode(db.path, "new1", "demand", "New demand");
    const node = getNode(db.path, "new1");
    expect(node).not.toBeNull();
    expect(node!.category).toBe("demand");
    expect(node!.chunk).toBe("New demand");
  });

  it("upsertNode updates chunk and category if present", () => {
    ensureNode(db.path, "ex1", "knowledge", "Original");
    upsertNode(db.path, "ex1", "issue", "Updated");
    const node = getNode(db.path, "ex1");
    expect(node!.category).toBe("issue");
    expect(node!.chunk).toBe("Updated");
  });

  it("upsertNode does not affect other nodes", () => {
    ensureNode(db.path, "ex1", "knowledge", "Original 1");
    ensureNode(db.path, "ex2", "principle", "Original 2");
    upsertNode(db.path, "ex1", "issue", "Updated 1");
    const nodes = listNodes(db.path);
    expect(nodes).toHaveLength(2);
    expect(getNode(db.path, "ex2")!.chunk).toBe("Original 2");
  });
});

// ─── Integration: Full workflow ─────────────────────────────────────────────

describe("Full workflow", () => {
  let db: { path: string; close: () => void };

  beforeEach(() => {
    db = freshDb();
  });
  afterEach(() => db.close());

  it("Node → Triple → Query → Delete lifecycle", () => {
    // 1. Create nodes
    upsertNode(db.path, "user_pref", "principle", "User prefers concise replies");
    upsertNode(db.path, "reply_style", "knowledge", "Concise reply style guide");

    // 2. Insert a triple linking them
    const relId = insertTriple({
      relType: "相关性",
      nodeIds: ["user_pref", "reply_style"],
      roles: ["cause", "effect"],
      context: "main_session",
      description: "User preference informs reply style",
      dbPath: db.path,
    });
    expect(typeof relId).toBe("number");

    // 3. Query from either end
    const fromPref = queryTriples({ nodeId: "user_pref", context: "main_session", dbPath: db.path });
    expect(fromPref).toHaveLength(1);
    expect(fromPref[0].rel_type).toBe("相关性");
    expect(fromPref[0].description).toBe("User preference informs reply style");
    expect(fromPref[0].participants_raw).toContain("user_pref");
    expect(fromPref[0].participants_raw).toContain("reply_style");

    // 4. Parse participants
    const parsed = parseParticipants(fromPref[0].participants_raw);
    expect(parsed).toHaveLength(2);
    expect(parsed.find((p) => p.node_id === "user_pref")?.role).toBe("cause");
    expect(parsed.find((p) => p.node_id === "reply_style")?.role).toBe("effect");

    // 5. List all triples
    const allTriples = listTriples(db.path);
    expect(allTriples).toHaveLength(1);

    // 6. Delete the triple
    deleteTriple(db.path, relId);
    expect(queryTriples({ nodeId: "user_pref", dbPath: db.path })).toHaveLength(0);
    expect(listTriples(db.path)).toHaveLength(0);

    // 7. Nodes still exist (only the relation was deleted)
    expect(getNode(db.path, "user_pref")).not.toBeNull();
    expect(getNode(db.path, "reply_style")).not.toBeNull();
  });

  it("Cascading delete when node is deleted", () => {
    ensureNode(db.path, "a", "tmp", "A");
    ensureNode(db.path, "b", "tmp", "B");
    const relId = insertTriple({ relType: "相关性", nodeIds: ["a", "b"], roles: ["related", "related"], dbPath: db.path });
    // Delete node a — foreign key cascade should clean up participants
    deleteNode(db.path, "a");
    // The relation should be gone (cascade)
    expect(queryTriples({ nodeId: "b", dbPath: db.path })).toHaveLength(0);
  });
});

/**
 * crud.ts
 * Memory chunk CRUD — RemX v0.3.0.
 *
 * Aligned with OpenClaw global memory schema:
 *   files(path)         — file record (path = memory ID)
 *   chunks(id, path)     — chunk records
 *   remx_lifecycle(path) — lifecycle fields (category, priority, type, status, deprecated, expires_at)
 *
 * NOT using: memories table, parent_id references, or memories_vec virtual table.
 */

import { join } from "path";
import Database from "better-sqlite3";
import { accessSync } from "fs";

import { getDb, DEFAULT_DB, findVecExtension } from "../shared/db";
import { ensureNode } from "./graph";

// ─── Types ────────────────────────────────────────────────────────────────────

export type Priority = "P0" | "P1" | "P2" | "P3";
export type MemoryStatus = "open" | "closed" | "archived";
export type MemoryType = "note" | "demand" | "issue" | "principle" | "knowledge" | "tmp";

/** Memory record — aligns with files + remx_lifecycle join */
export interface Memory {
  path: string;              // PRIMARY KEY (used as memory ID)
  category: string;
  priority: Priority | null;
  status: MemoryStatus | null;
  type: MemoryType | null;
  hash: string;
  mtime: number;
  size: number;
  chunk_count: number;
  deprecated: number;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** Chunk record — aligns with chunks table */
export interface Chunk {
  id: string;               // PRIMARY KEY (chunk ID)
  path: string;             // FK → files.path
  source: string;
  start_line: number;
  end_line: number;
  hash: string;
  model: string;
  text: string;
  embedding: Buffer | null;
  updated_at: number;       // Unix ms
  deprecated: number;
}

/** Memory with all its non-deprecated chunks */
export interface MemoryWithChunks extends Memory {
  chunks: Chunk[];
}

export interface CreateMemoryOptions {
  path: string;             // file path (used as memory ID)
  category: string;
  priority?: Priority;
  status?: MemoryStatus;
  type?: MemoryType;
  hash: string;
  mtime: number;
  size?: number;
  chunk_count?: number;
  created_at?: string;
  updated_at?: string;
  expires_at?: string | null;
}

export interface CreateChunkOptions {
  id: string;
  path: string;             // FK → files.path
  source?: string;
  start_line?: number;
  end_line?: number;
  content: string;
  content_hash?: string;
  embedding?: Buffer | null;
  model?: string;
  chunk_index?: number;
  created_at?: string;
  updated_at?: string;
}

export interface UpdateMemoryOptions {
  path: string;
  priority?: Priority;
  status?: MemoryStatus;
  type?: MemoryType;
  expires_at?: string | null;
  deprecated?: boolean;
  hash?: string;
  mtime?: number;
  size?: number;
  updated_at?: string;
}

export interface DeleteOptions {
  hard?: boolean;
}

// ─── DB Setup ────────────────────────────────────────────────────────────────

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Memory CRUD ─────────────────────────────────────────────────────────────

/**
 * Create a new memory record (files + remx_lifecycle).
 */
export function createMemory(opts: CreateMemoryOptions, dbPath?: string): Memory {
  const d = getDb(dbPath);
  const t = nowIso();
  try {
    d.prepare(
      `INSERT INTO files (path, source, hash, mtime, size) VALUES (?, 'remx', ?, ?, ?)`
    ).run(opts.path, opts.hash, opts.mtime, opts.size ?? 0);

    d.prepare(
      `INSERT INTO remx_lifecycle (path, category, priority, type, status, deprecated, expires_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(
      opts.path,
      opts.category,
      opts.priority ?? "P2",
      opts.type ?? null,
      opts.status ?? "open",
      opts.expires_at ?? null,
      opts.created_at ?? t,
      opts.updated_at ?? t,
    );

    ensureNode(dbPath ?? DEFAULT_DB, opts.path, opts.category, opts.path);
    return getMemoryById(opts.path, dbPath)!;
  } finally {
    d.close();
  }
}

/**
 * Retrieve a memory by path (join files + remx_lifecycle).
 */
export function getMemoryById(path: string, dbPath?: string): Memory | null {
  const d = getDb(dbPath);
  try {
    return (
      (d.prepare(`
        SELECT f.path, f.hash, f.mtime, f.size,
               lc.category, lc.priority, lc.type, lc.status,
               lc.deprecated, lc.expires_at, lc.created_at, lc.updated_at,
               (SELECT COUNT(*) FROM chunks c WHERE c.path = f.path AND c.deprecated = 0) AS chunk_count
        FROM files f
        JOIN remx_lifecycle lc ON lc.path = f.path
        WHERE f.path = ?
      `).get(path) as Memory | undefined) ?? null
    );
  } finally {
    d.close();
  }
}

export type MemoryFilter = Partial<Pick<Memory, "category" | "priority" | "status" | "type">> & {
  deprecated?: number;
  expires_at_lt?: string;
  path?: string;
  path_in?: string[];
};

/**
 * List memories with optional filter (join files + remx_lifecycle).
 */
export function listMemories(filter: MemoryFilter = {}, dbPath?: string): Memory[] {
  const d = getDb(dbPath);
  try {
    const conditions = ["f.path = lc.path"];
    const params: unknown[] = [];

    if (filter.category != null)  { conditions.push("lc.category = ?");  params.push(filter.category); }
    if (filter.priority != null)  { conditions.push("lc.priority = ?"); params.push(filter.priority); }
    if (filter.status != null)    { conditions.push("lc.status = ?");   params.push(filter.status); }
    if (filter.type != null)       { conditions.push("lc.type = ?");     params.push(filter.type); }
    if (filter.deprecated != null) { conditions.push("lc.deprecated = ?"); params.push(filter.deprecated); }
    if (filter.expires_at_lt != null) { conditions.push("lc.expires_at < ?"); params.push(filter.expires_at_lt); }
    if (filter.path != null)        { conditions.push("f.path = ?");    params.push(filter.path); }
    if (filter.path_in != null && filter.path_in.length > 0) {
      conditions.push(`f.path IN (${filter.path_in.map(() => "?").join(",")})`);
      params.push(...filter.path_in);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return d.prepare(`
      SELECT f.path, f.hash, f.mtime, f.size,
             lc.category, lc.priority, lc.type, lc.status,
             lc.deprecated, lc.expires_at, lc.created_at, lc.updated_at,
             (SELECT COUNT(*) FROM chunks c WHERE c.path = f.path AND c.deprecated = 0) AS chunk_count
      FROM files f
      JOIN remx_lifecycle lc ON lc.path = f.path
      ${where}
      ORDER BY lc.updated_at DESC
    `).all(...params) as Memory[];
  } finally {
    d.close();
  }
}

/**
 * Update a memory's fields.
 */
export function updateMemory(opts: UpdateMemoryOptions, dbPath?: string): Memory | null {
  const d = getDb(dbPath);
  try {
    const lcFields: string[] = [];
    const lcParams: unknown[] = [];
    const fFields: string[] = [];
    const fParams: unknown[] = [];

    if (opts.priority != null)    { lcFields.push("priority = ?");    lcParams.push(opts.priority); }
    if (opts.status != null)       { lcFields.push("status = ?");      lcParams.push(opts.status); }
    if (opts.type != null)         { lcFields.push("type = ?");        lcParams.push(opts.type); }
    if (opts.expires_at != null)   { lcFields.push("expires_at = ?");  lcParams.push(opts.expires_at); }
    if (opts.deprecated != null)   { lcFields.push("deprecated = ?");   lcParams.push(opts.deprecated ? 1 : 0); }
    if (opts.hash != null)         { fFields.push("hash = ?");         fParams.push(opts.hash); }
    if (opts.mtime != null)        { fFields.push("mtime = ?");        fParams.push(opts.mtime); }
    if (opts.size != null)         { fFields.push("size = ?");         fParams.push(opts.size); }

    const t = opts.updated_at ?? nowIso();
    lcFields.push("updated_at = ?");
    lcParams.push(t);

    if (fFields.length > 0) {
      fParams.push(opts.path);
      d.prepare(`UPDATE files SET ${fFields.join(", ")} WHERE path = ?`).run(...fParams);
    }
    if (lcFields.length > 0) {
      lcParams.push(opts.path);
      d.prepare(`UPDATE remx_lifecycle SET ${lcFields.join(", ")} WHERE path = ?`).run(...lcParams);
    }

    return getMemoryById(opts.path, dbPath);
  } finally {
    d.close();
  }
}

/**
 * Soft-delete a memory (set deprecated=1 on both files and remx_lifecycle).
 */
export function softDeleteMemory(path: string, dbPath?: string): void {
  const d = getDb(dbPath);
  try {
    d.prepare("UPDATE files SET size = 0 WHERE path = ?").run(path);
    d.prepare("UPDATE remx_lifecycle SET deprecated = 1, updated_at = ? WHERE path = ?").run(nowIso(), path);
  } finally {
    d.close();
  }
}

/**
 * Hard-delete a memory and all its chunks (CASCADE drops chunks automatically).
 */
export function hardDeleteMemory(path: string, dbPath?: string): void {
  const d = getDb(dbPath);
  try {
    // CASCADE takes care of chunks via FK
    d.prepare("DELETE FROM files WHERE path = ?").run(path);
  } finally {
    d.close();
  }
}

/**
 * Delete a memory (soft by default, hard if opts.hard === true).
 */
export function deleteMemory(path: string, opts: DeleteOptions = {}, dbPath?: string): void {
  if (opts.hard) {
    hardDeleteMemory(path, dbPath);
  } else {
    softDeleteMemory(path, dbPath);
  }
}

// ─── Chunk CRUD ─────────────────────────────────────────────────────────────

/**
 * Upsert a chunk (insert or replace).
 */
export function upsertChunk(opts: CreateChunkOptions, dbPath?: string): Chunk {
  const d = getDb(dbPath);
  const t = Date.now();
  try {
    // Explicitly delete vec entry before INSERT OR REPLACE to avoid UNIQUE constraint
    // issues when the cascade delete of chunks_vec doesn't fire before the new insert.
    d.prepare(`DELETE FROM chunks_vec WHERE id = ?`).run(opts.id);
    d.prepare(`
      INSERT OR REPLACE INTO chunks
        (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at, deprecated)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(
      opts.id,
      opts.path,
      opts.source ?? "remx",
      opts.start_line ?? 0,
      opts.end_line ?? 0,
      opts.content_hash ?? "",
      opts.model ?? "remx",
      opts.content,
      opts.embedding ?? null,
      t,
    );
    return getChunkById(opts.id, dbPath)!;
  } finally {
    d.close();
  }
}

/**
 * Retrieve a chunk by ID.
 */
export function getChunkById(id: string, dbPath?: string): Chunk | null {
  const d = getDb(dbPath);
  try {
    return (d.prepare("SELECT * FROM chunks WHERE id = ?").get(id) as Chunk | undefined) ?? null;
  } finally {
    d.close();
  }
}

/**
 * List chunks for a memory path.
 */
export function listChunks(path: string, dbPath?: string): Chunk[] {
  const d = getDb(dbPath);
  try {
    return d
      .prepare("SELECT * FROM chunks WHERE path = ? AND deprecated = 0 ORDER BY start_line")
      .all(path) as Chunk[];
  } finally {
    d.close();
  }
}

/**
 * Bulk upsert chunks for a memory (soft-delete old, insert new).
 */
export function upsertChunks(path: string, chunks: CreateChunkOptions[], dbPath?: string): Chunk[] {
  const d = getDb(dbPath);
  const t = Date.now();
  try {
    d.exec("BEGIN");
    d.prepare("UPDATE chunks SET deprecated = 1, updated_at = ? WHERE path = ? AND deprecated = 0").run(t, path);
    for (const ch of chunks) {
      upsertChunk({ ...ch, path }, dbPath);
    }
    d.exec("COMMIT");
    return listChunks(path, dbPath);
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  } finally {
    d.close();
  }
}

/**
 * Soft-delete a chunk.
 */
export function softDeleteChunk(id: string, dbPath?: string): void {
  const d = getDb(dbPath);
  try {
    d.prepare("UPDATE chunks SET deprecated = 1, updated_at = ? WHERE id = ?").run(Date.now(), id);
  } finally {
    d.close();
  }
}

// ─── Memory + Chunks ────────────────────────────────────────────────────────

/**
 * Get a memory with all its non-deprecated chunks.
 */
export function getMemoryWithChunks(path: string, dbPath?: string): MemoryWithChunks | null {
  const mem = getMemoryById(path, dbPath);
  if (!mem) return null;
  return { ...mem, chunks: listChunks(path, dbPath) };
}

/**
 * Create a memory and its chunks atomically.
 */
export function createMemoryWithChunks(
  opts: CreateMemoryOptions,
  chunks: CreateChunkOptions[],
  dbPath?: string
): MemoryWithChunks {
  const d = getDb(dbPath);
  try {
    d.exec("BEGIN");
    createMemory({ ...opts, chunk_count: chunks.length }, dbPath);
    for (const ch of chunks) {
      upsertChunk({ ...ch, path: opts.path }, dbPath);
    }
    d.exec("COMMIT");
    return getMemoryWithChunks(opts.path, dbPath)!;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  } finally {
    d.close();
  }
}

/**
 * Upsert a memory record (insert or replace).
 */
export function upsertMemory(opts: CreateMemoryOptions, dbPath?: string): Memory {
  const d = getDb(dbPath);
  const t = nowIso();
  try {
    d.prepare(`
      INSERT OR REPLACE INTO files (path, source, hash, mtime, size)
      VALUES (?, 'remx', ?, ?, ?)`
    ).run(opts.path, opts.hash, opts.mtime, opts.size ?? 0);

    d.prepare(`
      INSERT OR REPLACE INTO remx_lifecycle (path, category, priority, type, status, deprecated, expires_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)`
    ).run(
      opts.path,
      opts.category,
      opts.priority ?? "P2",
      opts.type ?? null,
      opts.status ?? "open",
      opts.expires_at ?? null,
      opts.created_at ?? t,
      opts.updated_at ?? t,
    );

    ensureNode(dbPath ?? DEFAULT_DB, opts.path, opts.category, opts.path);
    return getMemoryById(opts.path, dbPath)!;
  } finally {
    d.close();
  }
}

// ─── Utility ────────────────────────────────────────────────────────────────

/**
 * Compute a simple content hash (SHA-256).
 */
export async function contentHash(content: string): Promise<string> {
  const { createHash } = await import("crypto");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Compute content hash synchronously.
 */
export function contentHashSync(content: string): string {
  const { createHash } = require("crypto");
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Set expires_at using a TTL (hours).
 */
export function expiresAtTTL(ttlHours: number): string {
  return new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
}

/**
 * Check if a memory is expired.
 */
export function isExpired(memory: Memory): boolean {
  if (!memory.expires_at) return false;
  return new Date(memory.expires_at) < new Date();
}

/**
 * Find expired memories.
 */
export function findExpiredMemories(dbPath?: string): Memory[] {
  return listMemories({ deprecated: 0, expires_at_lt: nowIso() }, dbPath);
}

// ─── Re-exported from shared/db ───────────────────────────────────────────────

export { getDb, DEFAULT_DB } from "../shared/db";

// ─── Types from runtime/db ─────────────────────────────────────────────────

export interface GcCollectResult {
  expiredMemories: Record<string, unknown>[];
  deprecatedMemories: Record<string, unknown>[];
  totalChunks: number;
}

export interface GcSoftDeleteResult {
  expiredMemories: number;
  chunks: number;
}

export interface GcPurgeResult {
  memories: number;
  chunks: number;
}

export interface RetrieveRow extends Record<string, unknown> {
  path: string;
  category: string;
  priority?: string;
  type?: string;
  status?: string;
  deprecated: number;
  expires_at?: string;
  created_at: string;
  updated_at: string;
  chunk_id: string;
  start_line?: number;
  end_line?: number;
  chunk_hash?: string;
  content?: string;
}

export interface RetrieveFilter {
  path?: string;
  category?: string | string[];
  priority?: string | string[];
  status?: string | string[];
  type?: string | string[];
  deprecated?: number;
  expires_at?: string | null | Record<string, string>;
  [key: string]: unknown;
}

// ─── Init DB ─────────────────────────────────────────────────────────────────

/**
 * Initialize database with files/chunks/remx_lifecycle tables.
 * Virtual vector table (vec0) requires sqlite-vec extension loaded first.
 */
export function initDb(dbPath: string, dimensions = 1024, reset = false): void {
  const d = getDb(dbPath);
  try {
    const vecExt = findVecExtension();
    if (vecExt) {
      try { d.loadExtension(vecExt); } catch { /* vec0 unavailable */ }
    }

    if (reset) {
      d.exec(`
        DROP TABLE IF EXISTS chunks;
        DROP TABLE IF EXISTS remx_lifecycle;
        DROP TABLE IF EXISTS files;
      `);
    }

    d.exec(`CREATE TABLE IF NOT EXISTS files (
path TEXT PRIMARY KEY,
source TEXT NOT NULL DEFAULT 'remx',
hash TEXT NOT NULL,
mtime INTEGER NOT NULL,
size INTEGER NOT NULL
)`);
    d.exec(`CREATE TABLE IF NOT EXISTS chunks (
id TEXT PRIMARY KEY,
path TEXT NOT NULL,
source TEXT NOT NULL DEFAULT 'remx',
start_line INTEGER NOT NULL,
end_line INTEGER NOT NULL,
hash TEXT NOT NULL,
model TEXT NOT NULL DEFAULT 'remx',
text TEXT NOT NULL,
embedding TEXT,
updated_at INTEGER NOT NULL,
deprecated INTEGER DEFAULT 0,
FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
)`);
    d.exec(`CREATE TABLE IF NOT EXISTS remx_lifecycle (
path TEXT PRIMARY KEY,
category TEXT NOT NULL,
priority TEXT DEFAULT 'P2',
type TEXT,
status TEXT DEFAULT 'open',
deprecated INTEGER DEFAULT 0,
expires_at TEXT,
created_at TEXT,
updated_at TEXT,
FOREIGN KEY (path) REFERENCES files(path) ON DELETE CASCADE
)`);
    d.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dimensions}])`
    );

    d.exec(`CREATE INDEX IF NOT EXISTS idx_files_hash        ON files(hash)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_files_source      ON files(source)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path        ON chunks(path)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_hash        ON chunks(hash)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_deprecated  ON chunks(deprecated)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_lifecycle_category  ON remx_lifecycle(category)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_lifecycle_status     ON remx_lifecycle(status)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_lifecycle_deprecated ON remx_lifecycle(deprecated)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_lifecycle_expires_at ON remx_lifecycle(expires_at)`);

    // Topology tables
    d.exec(`
CREATE TABLE IF NOT EXISTS memory_nodes (
    id          TEXT PRIMARY KEY,
    category    TEXT NOT NULL,
    chunk       TEXT NOT NULL,
    created_at  INTEGER DEFAULT (unixepoch('now', 'subsec'))
)`);
    d.exec(`
CREATE TABLE IF NOT EXISTS memory_relations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    rel_type    TEXT NOT NULL CHECK (rel_type IN (
        '因果关系', '相关性', '对立性', '流程顺序性', '组成性', '依赖性'
    )),
    context     TEXT DEFAULT NULL,
    description TEXT,
    created_at  INTEGER DEFAULT (unixepoch('now', 'subsec'))
)`);
    d.exec(`
CREATE TABLE IF NOT EXISTS memory_relation_participants (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    relation_id INTEGER NOT NULL REFERENCES memory_relations(id) ON DELETE CASCADE,
    node_id     TEXT NOT NULL REFERENCES memory_nodes(id) ON DELETE CASCADE,
    role        TEXT NOT NULL,
    UNIQUE(relation_id, node_id, role)
)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_participants_node ON memory_relation_participants(node_id)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_participants_rel  ON memory_relation_participants(relation_id)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_relations_context ON memory_relations(context)`);
  } finally {
    d.close();
  }
}

// ─── Vector Upsert ─────────────────────────────────────────────────────────

/**
 * Upsert a chunk embedding into chunks_vec (vec0 virtual table, Float32 Buffer).
 */
export function upsertVector(dbPath: string, chunkId: string, embedding: number[]): void {
  const d = getDb(dbPath);
  try {
    const vec = Float32Array.from(embedding);
    d.prepare(
      `INSERT OR REPLACE INTO chunks_vec (id, embedding) VALUES (?, ?)`
    ).run(chunkId, vec);
  } finally {
    d.close();
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function expiresAtTtl(ttlHours: number): string {
  return new Date(Date.now() + ttlHours * 3600 * 1000).toISOString();
}

export function expiresAtStale(days: number, updatedAt?: string): string {
  const ref = updatedAt ? new Date(updatedAt) : new Date();
  return new Date(ref.getTime() + days * 86400 * 1000).toISOString();
}

// ─── GC: Collect ──────────────────────────────────────────────────────────────

/**
 * Query deprecated/expired records for GC report.
 */
export function gcCollect(
  dbPath: string,
  scopePath?: string
): GcCollectResult {
  const d = getDb(dbPath);
  try {
    const n = nowIso();

    let expiredSql = `SELECT lc.*, f.hash, f.mtime, f.size FROM remx_lifecycle lc JOIN files f ON f.path = lc.path WHERE lc.expires_at IS NOT NULL AND lc.expires_at < ? AND lc.deprecated = 0`;
    const expiredParams: unknown[] = [n];

    if (scopePath) {
      expiredSql += ` AND lc.path LIKE ?`;
      expiredParams.push(`${scopePath}%`);
    }

    const expiredRows = d.prepare(expiredSql).all(...expiredParams) as Record<string, unknown>[];

    let deprecatedSql = `SELECT lc.*, f.hash, f.mtime, f.size FROM remx_lifecycle lc JOIN files f ON f.path = lc.path WHERE lc.deprecated = 1`;
    const deprecatedParams: unknown[] = [];

    if (scopePath) {
      deprecatedSql += ` AND lc.path LIKE ?`;
      deprecatedParams.push(`${scopePath}%`);
    }

    const deprecatedRows = d
      .prepare(deprecatedSql)
      .all(...deprecatedParams) as Record<string, unknown>[];

    const chunkCountRow = d
      .prepare(
        `SELECT COUNT(*) as cnt FROM chunks c JOIN remx_lifecycle lc ON lc.path = c.path WHERE lc.deprecated = 1`
      )
      .get() as { cnt: number };

    return {
      expiredMemories: expiredRows,
      deprecatedMemories: deprecatedRows,
      totalChunks: chunkCountRow.cnt,
    };
  } finally {
    d.close();
  }
}

// ─── GC: Soft-Delete ─────────────────────────────────────────────────────────

/**
 * Soft-delete expired/deprecated memories and their chunks.
 */
export function gcSoftDelete(
  dbPath: string,
  scopePath?: string
): GcSoftDeleteResult {
  const d = getDb(dbPath);
  try {
    const n = nowIso();

    const conditions = [`expires_at IS NOT NULL`, `expires_at < ?`, `deprecated = 0`];
    const params: unknown[] = [n];

    if (scopePath) {
      conditions.push(`path LIKE ?`);
      params.push(`${scopePath}%`);
    }

    const where = conditions.join(` AND `);

    const updateMem = d.prepare(
      `UPDATE remx_lifecycle SET deprecated = 1, updated_at = ? WHERE ${where}`
    );
    const memResult = updateMem.run(n, ...params);
    const expiredCount = memResult.changes;

    const updateChunks = d.prepare(
      `UPDATE chunks SET deprecated = 1, updated_at = ? WHERE path IN (SELECT path FROM remx_lifecycle WHERE deprecated = 1)`
    );
    const chunkResult = updateChunks.run(n);
    const chunkCount = chunkResult.changes;

    return { expiredMemories: expiredCount, chunks: chunkCount };
  } finally {
    d.close();
  }
}

// ─── GC: Purge ───────────────────────────────────────────────────────────────

/**
 * Physically delete all deprecated records and VACUUM.
 */
export function gcPurge(dbPath: string): GcPurgeResult {
  const d = getDb(dbPath);
  try {
    const chunkResult = d.prepare(`DELETE FROM chunks WHERE deprecated = 1`).run();
    const chunkCount = chunkResult.changes;

    d.prepare(`DELETE FROM chunks_vec WHERE id NOT IN (SELECT id FROM chunks)`).run();

    const memResult = d.prepare(`DELETE FROM remx_lifecycle WHERE deprecated = 1`).run();
    const memoryCount = memResult.changes;

    d.exec(`VACUUM`);

    return { memories: memoryCount, chunks: chunkCount };
  } finally {
    d.close();
  }
}

// ─── Retrieve ────────────────────────────────────────────────────────────────

/**
 * Retrieve memories by filter dict → SQL WHERE translation.
 */
export function retrieve(
  dbPath: string,
  filter: RetrieveFilter,
  includeContent = true,
  limit = 50
): RetrieveRow[] {
  const d = getDb(dbPath);
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if ("expires_at" in filter) {
      const val = filter["expires_at"];
      delete filter["expires_at"];

      if (val === null) {
        conditions.push(`expires_at IS NULL`);
      } else if (typeof val === "object") {
        for (const [op, v] of Object.entries(val as Record<string, string>)) {
          conditions.push(`expires_at ${op} ?`);
          params.push(v);
        }
      } else {
        conditions.push(`expires_at = ?`);
        params.push(val);
      }
    }

    for (const [key, val] of Object.entries(filter)) {
      if (val === undefined) continue;
      if (val === null) {
        conditions.push(`${key} IS NULL`);
      } else if (Array.isArray(val)) {
        const placeholders = val.map(() => `?`).join(`, `);
        conditions.push(`${key} IN (${placeholders})`);
        params.push(...val);
      } else {
        conditions.push(`${key} = ?`);
        params.push(val);
      }
    }

    const whereClause = conditions.length > 0 ? conditions.join(` AND `) : `1=1`;

    let rows: RetrieveRow[];
    if (includeContent) {
      rows = d
        .prepare(
          `SELECT lc.path, lc.category, lc.priority, lc.type, lc.status, lc.deprecated,
                  lc.expires_at, lc.created_at, lc.updated_at,
                  c.id as chunk_id, c.start_line, c.end_line, c.hash as chunk_hash, c.text as content
           FROM remx_lifecycle lc
           JOIN chunks c ON c.path = lc.path AND c.deprecated = 0
           WHERE lc.deprecated = 0 AND ${whereClause}
           ORDER BY lc.updated_at DESC
           LIMIT ?`
        )
        .all(...params, limit) as RetrieveRow[];
    } else {
      rows = d
        .prepare(
          `SELECT lc.path, lc.category, lc.priority, lc.type, lc.status, lc.deprecated,
                  lc.expires_at, lc.created_at, lc.updated_at
           FROM remx_lifecycle lc
           WHERE lc.deprecated = 0 AND ${whereClause}
           ORDER BY lc.updated_at DESC LIMIT ?`
        )
        .all(...params, limit) as RetrieveRow[];
    }

    return rows;
  } finally {
    d.close();
  }
}

// ─── L2 / Cosine Similarity ─────────────────────────────────────────────────

function l2Distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

function cosineFromL2(query: number[], candidate: number[]): number {
  return 1 / (1 + l2Distance(query, candidate));
}

// ─── Semantic Retrieve ──────────────────────────────────────────────────────

export async function retrieveSemantic(
  dbPath: string,
  queryEmbedding: number[],
  _meta: unknown,
  filter: RetrieveFilter = {},
  includeContent = true,
  limit = 50,
  decayWeight = 0.3
): Promise<RetrieveRow[]> {
  if (queryEmbedding.length === 0) return [];

  const d = getDb(dbPath);
  try {
    const vecRows = d
      .prepare("SELECT id, embedding FROM chunks_vec")
      .all() as Array<{ id: string; embedding: unknown }>;

    if (vecRows.length === 0) return [];

    const scored: Array<{ chunk_id: string; similarity: number }> = [];
    for (const row of vecRows) {
      let embedding: number[];
      try {
        const buf = row.embedding as unknown as Buffer;
        embedding = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
      } catch {
        continue;
      }
      if (embedding.length !== queryEmbedding.length) continue;
      const similarity = cosineFromL2(queryEmbedding, embedding);
      scored.push({ chunk_id: row.id, similarity });
    }

    if (scored.length === 0) return [];

    const conditions: string[] = ["lc.deprecated = 0"];
    const params: unknown[] = [];

    if (filter.category) {
      if (Array.isArray(filter.category)) {
        const placeholders = filter.category.map(() => `?`).join(`, `);
        conditions.push(`lc.category IN (${placeholders})`);
        params.push(...filter.category);
      } else {
        conditions.push(`lc.category = ?`);
        params.push(filter.category);
      }
    }
    if (filter.status) {
      conditions.push(`lc.status = ?`);
      params.push(filter.status);
    }
    if (filter.type) {
      conditions.push(`lc.type = ?`);
      params.push(filter.type);
    }
    if (filter.deprecated !== undefined) {
      conditions.push(`lc.deprecated = ?`);
      params.push(filter.deprecated);
    }

    const filterClause = conditions.length > 0 ? conditions.join(` AND `) : `1=1`;

    const chunkIds = scored.map((s) => s.chunk_id);
    const inClause = chunkIds.map(() => `?`).join(`, `);

    let rows: RetrieveRow[];
    if (includeContent) {
      rows = d
        .prepare(
          `SELECT lc.path, lc.category, lc.priority, lc.type, lc.status, lc.deprecated,
                  lc.expires_at, lc.created_at, lc.updated_at,
                  c.id as chunk_id, c.start_line, c.end_line, c.hash as chunk_hash, c.text as content
           FROM remx_lifecycle lc
           JOIN chunks c ON c.path = lc.path AND c.deprecated = 0
           WHERE c.id IN (${inClause}) AND ${filterClause}
           ORDER BY lc.updated_at DESC`
        )
        .all(...chunkIds, ...params) as RetrieveRow[];
    } else {
      rows = d
        .prepare(
          `SELECT lc.path, lc.category, lc.priority, lc.type, lc.status, lc.deprecated,
                  lc.expires_at, lc.created_at, lc.updated_at,
                  c.id as chunk_id, c.start_line, c.end_line
           FROM remx_lifecycle lc
           JOIN chunks c ON c.path = lc.path AND c.deprecated = 0
           WHERE c.id IN (${inClause}) AND ${filterClause}
           ORDER BY lc.updated_at DESC`
        )
        .all(...chunkIds, ...params) as RetrieveRow[];
    }

    const now = Date.now();

    const cosineMap = new Map(scored.map((s) => [s.chunk_id, s.similarity]));

    function decayFactor(updatedAt: string, expiresAt: string | undefined, category: string): number {
      if (category === "tmp") {
        if (!expiresAt) return 1.0;
        const remaining = new Date(expiresAt).getTime() - now;
        const ttlMs = 24 * 3600 * 1000;
        return Math.max(0.0, Math.min(1.0, remaining / ttlMs));
      }
      if (category === "demand" || category === "issue") {
        const updatedMs = new Date(updatedAt).getTime();
        const daysSince = (now - updatedMs) / (86400 * 1000);
        const staleDays = 7;
        const rate = 0.1;
        if (daysSince <= staleDays) return 1.0;
        return Math.max(0.0, Math.exp(-rate * (daysSince - staleDays)));
      }
      return 1.0;
    }

    const bestPerPath = new Map<string, RetrieveRow>();
    for (const row of rows) {
      const cid = row.chunk_id!;
      const sid = row.path;
      const sim = cosineMap.get(cid) ?? 0;
      const dec = decayFactor(row.updated_at ?? "", row.expires_at as string | undefined, row.category);
      const score = (1 - decayWeight) * sim + decayWeight * dec;

      const existing = bestPerPath.get(sid);
      if (!existing || score > ((existing as unknown as { _score?: number })._score ?? -1)) {
        (row as unknown as { _score?: number })._score = score;
        bestPerPath.set(sid, row);
      }
    }

    const results = Array.from(bestPerPath.values());
    results.sort((a, b) => {
      const sa = (a as unknown as { _score?: number })._score ?? 0;
      const sb = (b as unknown as { _score?: number })._score ?? 0;
      return sb - sa;
    });

    for (const row of results) {
      delete (row as unknown as { _score?: number })._score;
    }

    return results.slice(0, limit);
  } finally {
    d.close();
  }
}

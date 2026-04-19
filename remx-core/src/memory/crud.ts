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

import { getDb, DEFAULT_DB } from "../shared/db";
import { ensureNode } from "./topology";

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

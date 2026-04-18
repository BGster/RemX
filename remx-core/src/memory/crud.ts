/**
 * crud.ts
 * Memory chunk CRUD — RemX v0.3.0 core.
 *
 * Provides typed Create / Read / Update / Delete operations for
 * the main memories table and chunks table (WITHOUT topology tables,
 * which are handled in topology.ts and triple-store.ts).
 */

import { join } from "path";
import Database from "better-sqlite3";

// ─── Types ───────────────────────────────────────────────────────────────────

export type Priority = "P0" | "P1" | "P2" | "P3";
export type MemoryStatus = "active" | "archived" | "deprecated";
export type MemoryType = "note" | "demand" | "issue" | "principle" | "knowledge" | "tmp";

export interface Memory {
  id: string;
  category: string;
  priority: Priority | null;
  status: MemoryStatus | null;
  type: MemoryType | null;
  file_path: string;
  chunk_count: number;
  created_at: string;   // ISO 8601
  updated_at: string;  // ISO 8601
  expires_at: string | null; // ISO 8601 or null
  deprecated: number;  // 0 or 1
}

export interface Chunk {
  chunk_id: string;
  parent_id: string;
  chunk_index: number;
  content: string;
  content_hash: string | null;
  embedding: Buffer | null;
  created_at: string;
  updated_at: string;
  deprecated: number;
}

export interface MemoryWithChunks extends Memory {
  chunks: Chunk[];
}

export interface CreateMemoryOptions {
  id: string;
  category: string;
  priority?: Priority;
  status?: MemoryStatus;
  type?: MemoryType;
  file_path: string;
  chunk_count?: number;
  created_at?: string;
  updated_at?: string;
  expires_at?: string | null;
}

export interface CreateChunkOptions {
  chunk_id: string;
  parent_id: string;
  chunk_index: number;
  content: string;
  content_hash?: string | null;
  embedding?: Buffer | null;
  created_at?: string;
  updated_at?: string;
}

export interface UpdateMemoryOptions {
  id: string;
  priority?: Priority;
  status?: MemoryStatus;
  type?: MemoryType;
  expires_at?: string | null;
  deprecated?: boolean;
  updated_at?: string;
}

export interface DeleteOptions {
  hard?: boolean;  // false = soft-delete (default), true = physical delete
}

// ─── DB Setup ────────────────────────────────────────────────────────────────

const DEFAULT_DB_PATH = join(process.env.HOME ?? "", ".openclaw", "memory", "main.sqlite");

export function getDb(dbPath?: string): Database.Database {
  const d = new Database(dbPath ?? DEFAULT_DB_PATH);
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  return d;
}

function now(): string {
  return new Date().toISOString();
}

// ─── Schema ─────────────────────────────────────────────────────────────────

export const MEMORIES_COLUMNS = [
  "id", "category", "priority", "status", "type",
  "file_path", "chunk_count",
  "created_at", "updated_at", "expires_at", "deprecated",
] as const;

export const CREATE_MEMORIES_SQL = `
CREATE TABLE IF NOT EXISTS memories (
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
)`;

export const CREATE_CHUNKS_SQL = `
CREATE TABLE IF NOT EXISTS chunks (
    chunk_id      TEXT PRIMARY KEY,
    parent_id     TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    chunk_index   INTEGER,
    content       TEXT NOT NULL,
    content_hash  TEXT,
    embedding     BLOB,
    created_at    TEXT,
    updated_at    TEXT,
    deprecated    INTEGER DEFAULT 0
)`;

export const CREATE_INDEXES_SQL = [
  "CREATE INDEX IF NOT EXISTS idx_memories_category   ON memories(category)",
  "CREATE INDEX IF NOT EXISTS idx_memories_status     ON memories(status)",
  "CREATE INDEX IF NOT EXISTS idx_memories_expires_at ON memories(expires_at)",
  "CREATE INDEX IF NOT EXISTS idx_memories_deprecated ON memories(deprecated)",
  "CREATE INDEX IF NOT EXISTS idx_memories_file_path  ON memories(file_path)",
  "CREATE INDEX IF NOT EXISTS idx_chunks_parent       ON chunks(parent_id)",
  "CREATE INDEX IF NOT EXISTS idx_chunks_deprecated    ON chunks(deprecated)",
  "CREATE INDEX IF NOT EXISTS idx_chunks_content_hash  ON chunks(content_hash)",
];

export function initSchema(dbPath?: string): void {
  const d = getDb(dbPath);
  try {
    d.exec(CREATE_MEMORIES_SQL);
    d.exec(CREATE_CHUNKS_SQL);
    for (const idx of CREATE_INDEXES_SQL) d.exec(idx);
  } finally {
    d.close();
  }
}

// ─── Memory CRUD ─────────────────────────────────────────────────────────────

/**
 * Create a new memory record (no chunks).
 */
export function createMemory(opts: CreateMemoryOptions, dbPath?: string): Memory {
  const d = getDb(dbPath);
  const t = now();
  try {
    d.prepare(
      `INSERT INTO memories (id, category, priority, status, type, file_path, chunk_count, created_at, updated_at, expires_at, deprecated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      opts.id,
      opts.category,
      opts.priority ?? null,
      opts.status ?? null,
      opts.type ?? null,
      opts.file_path,
      opts.chunk_count ?? 0,
      opts.created_at ?? t,
      opts.updated_at ?? t,
      opts.expires_at ?? null,
    );
    return getMemoryById(opts.id, dbPath)!;
  } finally {
    d.close();
  }
}

/**
 * Retrieve a memory by ID.
 */
export function getMemoryById(id: string, dbPath?: string): Memory | null {
  const d = getDb(dbPath);
  try {
    return (
      (d.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Memory | undefined) ?? null
    );
  } finally {
    d.close();
  }
}

export type MemoryFilter = Partial<Pick<Memory, "category" | "priority" | "status" | "type" | "file_path">> & {
  deprecated?: number;
  expires_at_lt?: string;
  expires_at_gt?: string;
  id_in?: string[];
};

/**
 * List memories with optional filter.
 */
export function listMemories(filter: MemoryFilter = {}, dbPath?: string): Memory[] {
  const d = getDb(dbPath);
  try {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.category != null)      { conditions.push("category = ?");        params.push(filter.category); }
    if (filter.priority != null)      { conditions.push("priority = ?");       params.push(filter.priority); }
    if (filter.status != null)        { conditions.push("status = ?");         params.push(filter.status); }
    if (filter.type != null)          { conditions.push("type = ?");           params.push(filter.type); }
    if (filter.file_path != null)     { conditions.push("file_path = ?");      params.push(filter.file_path); }
    if (filter.deprecated != null)    { conditions.push("deprecated = ?");     params.push(filter.deprecated); }
    if (filter.expires_at_lt != null)  { conditions.push("expires_at < ?");     params.push(filter.expires_at_lt); }
    if (filter.expires_at_gt != null)  { conditions.push("expires_at > ?");     params.push(filter.expires_at_gt); }
    if (filter.id_in != null && filter.id_in.length > 0) {
      conditions.push(`id IN (${filter.id_in.map(() => "?").join(",")})`);
      params.push(...filter.id_in);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    return d
      .prepare(`SELECT * FROM memories ${where} ORDER BY updated_at DESC`)
      .all(...params) as Memory[];
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
    const fields: string[] = [];
    const params: unknown[] = [];

    if (opts.priority != null)    { fields.push("priority = ?");    params.push(opts.priority); }
    if (opts.status != null)       { fields.push("status = ?");      params.push(opts.status); }
    if (opts.type != null)         { fields.push("type = ?");        params.push(opts.type); }
    if (opts.expires_at != null)   { fields.push("expires_at = ?");  params.push(opts.expires_at); }
    if (opts.deprecated != null)   { fields.push("deprecated = ?"); params.push(opts.deprecated ? 1 : 0); }
    if (opts.updated_at != null)   { fields.push("updated_at = ?"); params.push(opts.updated_at); }
    else                           { fields.push("updated_at = ?"); params.push(now()); }

    if (fields.length === 0) return getMemoryById(opts.id, dbPath);

    params.push(opts.id);
    d.prepare(`UPDATE memories SET ${fields.join(", ")} WHERE id = ?`).run(...params);
    return getMemoryById(opts.id, dbPath);
  } finally {
    d.close();
  }
}

/**
 * Soft-delete a memory (set deprecated=1).
 */
export function softDeleteMemory(id: string, dbPath?: string): void {
  updateMemory({ id, deprecated: true, updated_at: now() }, dbPath);
}

/**
 * Hard-delete a memory and all its chunks (physical delete).
 */
export function hardDeleteMemory(id: string, dbPath?: string): void {
  const d = getDb(dbPath);
  try {
    // Delete chunks first (FK not enforced if deferred, but being explicit)
    d.prepare("DELETE FROM chunks WHERE parent_id = ?").run(id);
    d.prepare("DELETE FROM memories WHERE id = ?").run(id);
  } finally {
    d.close();
  }
}

/**
 * Delete a memory (soft by default, hard if opts.hard === true).
 */
export function deleteMemory(id: string, opts: DeleteOptions = {}, dbPath?: string): void {
  if (opts.hard) {
    hardDeleteMemory(id, dbPath);
  } else {
    softDeleteMemory(id, dbPath);
  }
}

// ─── Chunk CRUD ─────────────────────────────────────────────────────────────

/**
 * Create a single chunk.
 */
export function createChunk(opts: CreateChunkOptions, dbPath?: string): Chunk {
  const d = getDb(dbPath);
  const t = now();
  try {
    d.prepare(
      `INSERT INTO chunks (chunk_id, parent_id, chunk_index, content, content_hash, embedding, created_at, updated_at, deprecated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    ).run(
      opts.chunk_id,
      opts.parent_id,
      opts.chunk_index,
      opts.content,
      opts.content_hash ?? null,
      opts.embedding ?? null,
      opts.created_at ?? t,
      opts.updated_at ?? t,
    );
    return getChunkById(opts.chunk_id, dbPath)!;
  } finally {
    d.close();
  }
}

/**
 * Retrieve a chunk by ID.
 */
export function getChunkById(chunkId: string, dbPath?: string): Chunk | null {
  const d = getDb(dbPath);
  try {
    return (
      (d.prepare("SELECT * FROM chunks WHERE chunk_id = ?").get(chunkId) as Chunk | undefined) ??
      null
    );
  } finally {
    d.close();
  }
}

/**
 * List chunks for a parent memory.
 */
export function listChunks(parentId: string, dbPath?: string): Chunk[] {
  const d = getDb(dbPath);
  try {
    return d
      .prepare("SELECT * FROM chunks WHERE parent_id = ? AND deprecated = 0 ORDER BY chunk_index")
      .all(parentId) as Chunk[];
  } finally {
    d.close();
  }
}

/**
 * Update a chunk's content (and optionally its hash).
 */
export function updateChunk(
  chunkId: string,
  content: string,
  contentHash?: string | null,
  embedding?: Buffer | null,
  dbPath?: string
): Chunk | null {
  const d = getDb(dbPath);
  try {
    const fields = ["content = ?", "updated_at = ?"];
    const params: unknown[] = [content, now()];
    if (contentHash != null) { fields.push("content_hash = ?"); params.push(contentHash); }
    if (embedding != null)   { fields.push("embedding = ?");     params.push(embedding); }
    params.push(chunkId);
    d.prepare(`UPDATE chunks SET ${fields.join(", ")} WHERE chunk_id = ?`).run(...params);
    return getChunkById(chunkId, dbPath);
  } finally {
    d.close();
  }
}

/**
 * Soft-delete a chunk.
 */
export function softDeleteChunk(chunkId: string, dbPath?: string): void {
  const d = getDb(dbPath);
  try {
    d.prepare("UPDATE chunks SET deprecated = 1, updated_at = ? WHERE chunk_id = ?").run(now(), chunkId);
  } finally {
    d.close();
  }
}

/**
 * Bulk upsert chunks for a memory (replace all existing non-deprecated chunks).
 */
export function upsertChunks(parentId: string, chunks: CreateChunkOptions[], dbPath?: string): Chunk[] {
  const d = getDb(dbPath);
  const t = now();
  try {
    d.exec("BEGIN");
    // Soft-delete existing chunks
    d.prepare("UPDATE chunks SET deprecated = 1, updated_at = ? WHERE parent_id = ? AND deprecated = 0")
      .run(t, parentId);
    // Insert new chunks
    const insert = d.prepare(
      `INSERT INTO chunks (chunk_id, parent_id, chunk_index, content, content_hash, embedding, created_at, updated_at, deprecated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    );
    for (const ch of chunks) {
      insert.run(
        ch.chunk_id,
        parentId,
        ch.chunk_index,
        ch.content,
        ch.content_hash ?? null,
        ch.embedding ?? null,
        ch.created_at ?? t,
        ch.updated_at ?? t,
      );
    }
    // Update memory's chunk_count
    d.prepare("UPDATE memories SET chunk_count = ?, updated_at = ? WHERE id = ?")
      .run(chunks.length, t, parentId);
    d.exec("COMMIT");
    return listChunks(parentId, dbPath);
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  } finally {
    d.close();
  }
}

// ─── Memory + Chunks (composite) ────────────────────────────────────────────

/**
 * Get a memory with all its non-deprecated chunks.
 */
export function getMemoryWithChunks(id: string, dbPath?: string): MemoryWithChunks | null {
  const mem = getMemoryById(id, dbPath);
  if (!mem) return null;
  return { ...mem, chunks: listChunks(id, dbPath) };
}

/**
 * Create a memory and its chunks atomically.
 */
export function createMemoryWithChunks(
  memOpts: CreateMemoryOptions,
  chunks: CreateChunkOptions[],
  dbPath?: string
): MemoryWithChunks {
  const d = getDb(dbPath);
  const t = now();
  try {
    d.exec("BEGIN");
    createMemory({ ...memOpts, chunk_count: chunks.length, updated_at: t, created_at: t }, dbPath);
    const insert = d.prepare(
      `INSERT INTO chunks (chunk_id, parent_id, chunk_index, content, content_hash, embedding, created_at, updated_at, deprecated)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
    );
    for (const ch of chunks) {
      insert.run(
        ch.chunk_id,
        memOpts.id,
        ch.chunk_index,
        ch.content,
        ch.content_hash ?? null,
        ch.embedding ?? null,
        ch.created_at ?? t,
        ch.updated_at ?? t,
      );
    }
    d.exec("COMMIT");
    return getMemoryWithChunks(memOpts.id, dbPath)!;
  } catch (e) {
    d.exec("ROLLBACK");
    throw e;
  } finally {
    d.close();
  }
}

// ─── Utility ───────────────────────────────────────────────────────────────

/**
 * Compute a simple content hash (SHA-256 via Node crypto).
 * Used for chunk deduplication.
 */
export async function contentHash(content: string): Promise<string> {
  const { createHash } = await import("crypto");
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
 * Find expired memories (for GC).
 */
export function findExpiredMemories(dbPath?: string): Memory[] {
  return listMemories({ deprecated: 0, expires_at_lt: now() }, dbPath);
}

/**
 * runtime/db.ts
 * Garbage collection, retrieval, and init functions for RemX v0.3.0.
 *
 * Ported from db.py (Python) GC functions + init/retrieve.
 * Uses the files/chunks table schema (aligned with OpenClaw global memory).
 */

import { join } from "path";
import Database from "better-sqlite3";
import { getDb, DEFAULT_DB, findVecExtension } from "../shared/db";
export { getDb, DEFAULT_DB };

// ─── Types ────────────────────────────────────────────────────────────────────

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
  // Lifecycle (remx_lifecycle)
  path: string;
  category: string;
  priority?: string;
  type?: string;
  status?: string;
  deprecated: number;
  expires_at?: string;
  created_at: string;
  updated_at: string;
  // Chunks
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

// ─── Schema (Python db.py schema) ────────────────────────────────────────────

// Schema aligned with OpenClaw global memory (files/chunks model)
type RemxLifecycleStatus = "open" | "closed" | "archived";

// lifecycle is stored in remx_lifecycle table, not in chunks

const FILES_COL_DEFS = `
path TEXT PRIMARY KEY,
source TEXT NOT NULL DEFAULT 'remx',
hash TEXT NOT NULL,
mtime INTEGER NOT NULL,
size INTEGER NOT NULL
`.trim();

const CHUNKS_COL_DEFS = `
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
`.trim();

// Lifecycle table (RemX extended fields, separate from OpenClaw files)
const LIFECYCLE_COL_DEFS = `
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
`.trim();

// ─── DB Path ─────────────────────────────────────────────────────────────────

// ─── Init ────────────────────────────────────────────────────────────────────

/**
 * Initialize database with files/chunks/remx_lifecycle tables.
 * Virtual vector table (vec0) requires sqlite-vec extension loaded first.
 */
export function initDb(dbPath: string, dimensions = 1024, reset = false): void {
  const d = getDb(dbPath);
  try {
    // Load sqlite-vec extension before creating virtual tables
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

    d.exec(`CREATE TABLE IF NOT EXISTS files (${FILES_COL_DEFS})`);
    d.exec(`CREATE TABLE IF NOT EXISTS chunks (${CHUNKS_COL_DEFS})`);
    d.exec(`CREATE TABLE IF NOT EXISTS remx_lifecycle (${LIFECYCLE_COL_DEFS})`);
    d.exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[${dimensions}])`
    );

    // Indexes
    d.exec(`CREATE INDEX IF NOT EXISTS idx_files_hash        ON files(hash)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_files_source      ON files(source)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_path        ON chunks(path)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_hash        ON chunks(hash)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_chunks_deprecated  ON chunks(deprecated)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_lifecycle_category  ON remx_lifecycle(category)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_lifecycle_status     ON remx_lifecycle(status)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_lifecycle_deprecated ON remx_lifecycle(deprecated)`);
    d.exec(`CREATE INDEX IF NOT EXISTS idx_lifecycle_expires_at ON remx_lifecycle(expires_at)`);
  } finally {
    d.close();
  }
}

// ─── Vector Upsert ───────────────────────────────────────────────────────────────

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

export function nowIso(): string {
  return new Date().toISOString();
}

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
    const now = nowIso();

    // Expired lifecycle rows
    let expiredSql = `SELECT lc.*, f.hash, f.mtime, f.size FROM remx_lifecycle lc JOIN files f ON f.path = lc.path WHERE lc.expires_at IS NOT NULL AND lc.expires_at < ? AND lc.deprecated = 0`;
    const expiredParams: unknown[] = [now];

    if (scopePath) {
      expiredSql += ` AND lc.path LIKE ?`;
      expiredParams.push(`${scopePath}%`);
    }

    const expiredRows = d.prepare(expiredSql).all(...expiredParams) as Record<string, unknown>[];

    // Deprecated lifecycle rows
    let deprecatedSql = `SELECT lc.*, f.hash, f.mtime, f.size FROM remx_lifecycle lc JOIN files f ON f.path = lc.path WHERE lc.deprecated = 1`;
    const deprecatedParams: unknown[] = [];

    if (scopePath) {
      deprecatedSql += ` AND lc.path LIKE ?`;
      deprecatedParams.push(`${scopePath}%`);
    }

    const deprecatedRows = d
      .prepare(deprecatedSql)
      .all(...deprecatedParams) as Record<string, unknown>[];

    // Chunk count for deprecated
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
    const now = nowIso();

    // Soft-delete expired lifecycle rows → deprecated = 1
    const conditions = [`expires_at IS NOT NULL`, `expires_at < ?`, `deprecated = 0`];
    const params: unknown[] = [now];

    if (scopePath) {
      conditions.push(`path LIKE ?`);
      params.push(`${scopePath}%`);
    }

    const where = conditions.join(` AND `);

    const updateMem = d.prepare(
      `UPDATE remx_lifecycle SET deprecated = 1, updated_at = ? WHERE ${where}`
    );
    const memResult = updateMem.run(now, ...params);
    const expiredCount = memResult.changes;

    // Soft-delete chunks of deprecated lifecycle
    const updateChunks = d.prepare(
      `UPDATE chunks SET deprecated = 1, updated_at = ? WHERE path IN (SELECT path FROM remx_lifecycle WHERE deprecated = 1)`
    );
    const chunkResult = updateChunks.run(now);
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
    // Delete chunks
    const chunkResult = d.prepare(`DELETE FROM chunks WHERE deprecated = 1`).run();
    const chunkCount = chunkResult.changes;

    // Delete orphaned vectors (chunks already deleted above via CASCADE would
    // Clean up orphaned vectors
    d.prepare(`DELETE FROM chunks_vec WHERE id NOT IN (SELECT id FROM chunks)`).run();

    // Delete deprecated lifecycle rows (cascade → files → chunks)
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
 * Supports: category, priority, status, type, file_path, deprecated,
 * expires_at (<, >, =), id.
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

    // Handle special expires_at comparisons
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

/** L2 (Euclidean) distance between two vectors. */
function l2Distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

/** Cosine similarity derived from L2 distance.
 *  similarity = 1 / (1 + distance)
 * This is a monotonically decreasing mapping: distance=0 → similarity=1,
 * distance→∞ → similarity→0.
 */
function cosineFromL2(query: number[], candidate: number[]): number {
  return 1 / (1 + l2Distance(query, candidate));
}

// ─── Semantic Retrieve ──────────────────────────────────────────────────────

/**
 * retrieveSemantic — vector-based semantic retrieval.
 *
 * Pipeline:
 *  1. Load all embeddings from chunks_vec (vec0 virtual table, Float32 Buffer)
 *  2. Compute cosine similarity between queryEmbedding and each stored vector
 *  3. Join with chunks + remx_lifecycle
 *  4. Apply decay scoring: score = (1-decayWeight)*cosine + decayWeight*decay
 *  5. Deduplicate by path (keep best chunk per file)
 *  6. Sort by score DESC, return top `limit` results
 *
 * Vector storage: chunks_vec (vec0 virtual table), loaded via sqlite-vec extension.
 */
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
    // Step 1: Load all (id, embedding) pairs from chunks_vec
    const vecRows = d
      .prepare("SELECT id, embedding FROM chunks_vec")
      .all() as Array<{ id: string; embedding: unknown }>;

    if (vecRows.length === 0) return [];

    // Step 2: Compute similarity scores (vec0 stores as Float32 Buffer)
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

    // Step 3: Build filter conditions for the SQL query
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

    // Build id IN (...) list
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

    // Step 5: Score with hybrid (cosine + decay) and deduplicate by memory_id
    const now = Date.now();

    // cosine map: chunk_id → similarity
    const cosineMap = new Map(scored.map((s) => [s.chunk_id, s.similarity]));

    // Decay function (mirrors recall.ts computeDecayFactor but inline for perf)
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
      return 1.0; // knowledge, principle, etc.
    }

    // Best chunk per file path
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

    // Step 6: Sort by score DESC, apply limit
    const results = Array.from(bestPerPath.values());
    results.sort((a, b) => {
      const sa = (a as unknown as { _score?: number })._score ?? 0;
      const sb = (b as unknown as { _score?: number })._score ?? 0;
      return sb - sa;
    });

    // Remove internal _score field before returning
    for (const row of results) {
      delete (row as unknown as { _score?: number })._score;
    }

    return results.slice(0, limit);
  } finally {
    d.close();
  }
}

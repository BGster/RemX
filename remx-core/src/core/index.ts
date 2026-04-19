/**
 * index.ts
 * Indexing orchestration for RemX v0.3.0 TS CLI.
 *
 * Ported from index.py (Python) → TypeScript.
 *
 * Pipeline:
 *  1. Resolve file context (path + scope + front-matter)
 *  2. Chunk content
 *  3. Build memory + chunk records (with embeddings)
 *  4. Semantic dedup check (optional, for knowledge/principle)
 *  5. Atomic write to DB
 */

import { createHash } from "crypto";
import { existsSync } from "fs";
import { resolve } from "path";

import {
  chunkByHeadings,
  chunkParagraphsSimple,
  countTokens,
  makeChunkId,
  splitParagraphs,
  stripFrontMatter,
  type Chunk,
} from "./chunker";
import { parseFrontMatter } from "./storage";
import { initDb, upsertVector } from "../memory/memory";
import { upsertMemory, upsertChunk, createMemoryWithChunks, contentHash, type Priority, type MemoryStatus, type MemoryType } from "../memory/memory";
import type { Embedder } from "./embedder";
import { MetaYamlModel, type IndexScope } from "./schema";
import { expiresAtStale, expiresAtTtl } from "../memory/memory";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IndexConfig {
  maxTokens: number;
  overlap: number;
  strategy: "heading" | "paragraph";
  headingLevels?: number[];
  dedupThreshold?: number;
  chunkSizeParas?: number;
}

export interface IndexResult {
  memoryId: string;
  category: string;
  chunkCount: number;
  expiresAt?: string;
  filePath: string;
}

interface FileContext {
  filePath: string;
  content: string;
  frontMatter: Record<string, unknown>;
  body: string;
  indexPath: string;
  scope: IndexScope | null;
  category: string;
  priority: string | null;
  status: string;
  docType: string | null;
  createdAt: string;
  now: string;
}

interface ChunkRecord {
  chunk_id: string;
  path: string;             // memory path (FK)
  start_line: number;
  end_line: number;
  content: string;
  content_hash: string;
  embedding: number[] | null;
}

// ─── Path utilities ──────────────────────────────────────────────────────────

function _normalizePath(filePath: string): string {
  if (filePath.includes("..")) {
    throw new Error(`Path with '..' is not allowed: ${filePath}`);
  }
  if (filePath.startsWith("~")) {
    const home = process.env.HOME ?? "";
    return filePath.replace(/^~/, home);
  }
  return filePath;
}

function _isGlobalPath(filePath: string): boolean {
  return filePath.startsWith("~") || filePath.startsWith("/");
}

// ─── Compute Expires At ───────────────────────────────────────────────────────

function _computeExpiresAt(
  meta: MetaYamlModel,
  category: string,
  status?: string | null,
  updatedAt?: string,
): string | undefined {
  const dg = meta.decayGroupFor(category, status ?? undefined);
  if (!dg) return undefined;

  const fn = dg.function;
  const params = dg.params;

  if (fn === "ttl") {
    const ttlHours = (params["ttl_hours"] as number) ?? 24;
    return expiresAtTtl(ttlHours);
  } else if (fn === "stale_after") {
    const days = (params["days"] as number) ?? 30;
    return expiresAtStale(days, updatedAt);
  }
  return undefined;
}

// ─── Step 1: Resolve File Context ─────────────────────────────────────────────

function _resolveFileContext(
  filePath: string,
  metaYamlPath: string,
  meta: MetaYamlModel,
): FileContext {
  // Validate and normalize path
  const resolvedPath = _normalizePath(filePath);
  if (!existsSync(resolvedPath)) {
    throw new Error(`${filePath}: file not found`);
  }

  const metaDir = metaYamlPath.substring(0, metaYamlPath.lastIndexOf("/"));

  // Find matching index_scope
  const scope = meta.findScope(resolvedPath, metaDir);
  let scopeCategory: string | null = null;
  if (scope) {
    scopeCategory = meta.extractCategoryFromScope(scope) ?? null;
  }

  // Compute index_path (display path for chunk_ids)
  let indexPath: string;
  if (scope) {
    const scopeResolved = resolve(metaDir, scope.path);
    try {
      indexPath = resolve(resolvedPath).replace(scopeResolved + "/", "");
    } catch {
      indexPath = resolvedPath;
    }
  } else if (_isGlobalPath(resolvedPath)) {
    const home = process.env.HOME ?? "";
    indexPath = resolvedPath.startsWith(home)
      ? resolvedPath.replace(home, "~")
      : resolvedPath;
  } else {
    indexPath = resolvedPath;
  }

  // Parse front-matter
  const text = require("fs").readFileSync(resolvedPath, "utf-8");
  const { frontMatter, body } = parseFrontMatter(text);

  // Resolve category: front_matter > scope > "unknown"
  const category = (frontMatter["category"] as string)
    ?? scopeCategory
    ?? "unknown";
  const priority = (frontMatter["priority"] as string) ?? null;
  const status = (frontMatter["status"] as string) ?? "open";
  const docType = (frontMatter["type"] as string) ?? "default";

  const now = new Date().toISOString();
  const createdAt = (frontMatter["created_at"] as string) ?? now;

  return {
    filePath: resolvedPath,
    content: text,
    frontMatter,
    body,
    indexPath,
    scope,
    category,
    priority,
    status,
    docType,
    createdAt,
    now,
  };
}

// ─── Step 2: Build Chunks ─────────────────────────────────────────────────────

function _buildChunks(
  body: string,
  indexPath: string,
  meta: MetaYamlModel,
  config: IndexConfig,
): Chunk[] {
  const paragraphs = splitParagraphs(body);
  if (paragraphs.length === 0) return [];

  const ov = config.overlap >= 0 ? config.overlap : meta.chunk.overlap;
  const strategy = config.strategy ?? (meta.chunk.strategy as "heading" | "paragraph");

  if (strategy === "heading") {
    const hl = config.headingLevels ?? meta.chunk.heading_levels;
    return chunkByHeadings(paragraphs, indexPath, config.maxTokens, ov, hl);
  } else {
    const cs = config.chunkSizeParas ?? 1;
    if (cs <= 0) {
      const paraTokensList = paragraphs.map((p) => countTokens(p));
      const avgParaTokens = Math.max(1, Math.floor(paraTokensList.reduce((a, b) => a + b, 0) / Math.max(1, paragraphs.length)));
      const computedCs = Math.max(1, Math.floor(meta.chunk.max_tokens / avgParaTokens));
      return chunkParagraphsSimple(paragraphs, indexPath, computedCs, ov);
    }
    return chunkParagraphsSimple(paragraphs, indexPath, cs, ov);
  }
}

// ─── Step 3: Build Memory + Chunk Records ────────────────────────────────────

function _buildMemoryAndChunks(
  ctx: FileContext,
  chunks: Chunk[],
  meta: MetaYamlModel,
  embedder: Embedder | undefined,
): { memory: Record<string, unknown>; chunkRecords: ChunkRecord[] } {
  // Idempotent memory_id based on file_path
  const memoryId = _makeMemoryId(ctx.filePath, ctx.category);

  // Compute expires_at
  const expiresAt = _computeExpiresAt(meta, ctx.category, ctx.status, ctx.now);

  // Build chunk records
  const chunkRecords: ChunkRecord[] = chunks.map((ch, i) => {
    const contentHashVal = contentHashSync(ch.content);
    return {
      chunk_id: ch.chunk_id,
      path: ctx.filePath,
      start_line: ch.para_indices[0] ?? 0,
      end_line: ch.para_indices[ch.para_indices.length - 1] ?? 0,
      content: ch.content,
      content_hash: contentHashVal,
      embedding: null, // will be filled below if embedder provided
    };
  });

  // "status: deprecated" in front-matter → mark as soft-deleted immediately
  const isDeprecated = ctx.status === "deprecated";

  const memory = {
    path: ctx.filePath,
    category: ctx.category,
    priority: ctx.priority,
    status: isDeprecated ? "open" : (ctx.status ?? "open"),
    type: ctx.docType,
    hash: "",
    mtime: 0,
    chunk_count: chunks.length,
    created_at: ctx.createdAt,
    updated_at: ctx.now,
    expires_at: expiresAt ?? null,
    _deprecated: isDeprecated ? 1 : 0,
  };

  return { memory, chunkRecords };
}

/**
 * Simple synchronous content hash (SHA-256).
 */
function contentHashSync(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * Make a deterministic memory ID from file path + category.
 */
function _makeMemoryId(filePath: string, category: string): string {
  const hash = createHash("sha256").update(filePath, "utf8").digest("hex").slice(0, 16).toUpperCase();
  return `${category.slice(0, 3).toUpperCase()}-${hash}`;
}

// ─── Step 4: Semantic Dedup ──────────────────────────────────────────────────

async function _checkSemanticDedup(
  chunkRecords: ChunkRecord[],
  ctx: FileContext,
  dbPath: string,
  embedder: Embedder,
  meta: MetaYamlModel,
  threshold: number,
): Promise<Array<{ chunkId: string; existingPath: string; similarity: number }>> {
  const checkCategories = new Set(["knowledge", "principle"]);
  if (!checkCategories.has(ctx.category)) return [];

  const dupes: Array<{ chunkId: string; existingPath: string; similarity: number }> = [];

  // Load existing embeddings from chunks_vec (vec0 virtual table, Float32 Buffer)
  const { getDb } = await import("../memory/memory");
  const d = getDb(dbPath);
  try {
    const rows = d
      .prepare("SELECT id, embedding FROM chunks_vec")
      .all() as Array<{ id: string; embedding: unknown }>;

    for (const ch of chunkRecords) {
      if (!ch.embedding) continue;

      for (const row of rows) {
        let existingEmbedding: number[];
        try {
          const buf = row.embedding as Buffer;
          existingEmbedding = Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
        } catch {
          continue;
        }
        if (existingEmbedding.length !== ch.embedding.length) continue;

        // L2 distance → cosine similarity
        const dist = l2Distance(ch.embedding, existingEmbedding);
        const similarity = 1 / (1 + dist);
        if (similarity >= threshold) {
          // Get file path for this chunk
          const chunkRow = d
            .prepare("SELECT path FROM chunks WHERE id = ?")
            .get(row.id) as { path: string } | undefined;
          if (chunkRow && chunkRow.path !== ctx.filePath) {
            dupes.push({ chunkId: ch.chunk_id, existingPath: chunkRow.path, similarity });
          }
        }
      }
    }
  } finally {
    d.close();
  }

  return dupes;
}

function l2Distance(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
}

// ─── Step 5: Write to DB ──────────────────────────────────────────────────────

async function _writeMemoryToDb(
  dbPath: string,
  memory: Record<string, unknown>,
  chunkRecords: ChunkRecord[],
  embedder: Embedder | undefined,
): Promise<void> {
  initDb(dbPath);

  const { upsertMemory, upsertChunk } = await import("../memory/memory");

  // Embed chunks if embedder is provided
  if (embedder) {
    const texts = chunkRecords.map((c) => c.content);
    const embeddings = await embedder.embed(texts);
    for (let i = 0; i < chunkRecords.length; i++) {
      chunkRecords[i].embedding = embeddings[i];
    }
  }

  // If front-matter status was "deprecated", soft-delete the memory immediately
  if ((memory["_deprecated"] as number) === 1) {
    const { deleteMemory } = await import("../memory/memory");
    const path = memory["path"] as string;
    // Write memory first so it exists, then soft-delete
    upsertMemory(
      {
        path: memory["path"] as string,
        category: memory["category"] as string,
        priority: memory["priority"] as Priority | undefined,
        status: "open",
        type: memory["type"] as MemoryType | undefined,
        hash: "",
        mtime: 0,
        chunk_count: memory["chunk_count"] as number,
        created_at: memory["created_at"] as string,
        updated_at: memory["updated_at"] as string,
        expires_at: memory["expires_at"] as string | null,
      },
      dbPath,
    );
    deleteMemory(path, {}, dbPath);
    return;
  }

  // Upsert memory (path IS the file path, used as ID)
  upsertMemory(
    {
      path: memory["path"] as string,
      category: memory["category"] as string,
      priority: memory["priority"] as Priority | undefined,
      status: memory["status"] as MemoryStatus | undefined,
      type: memory["type"] as MemoryType | undefined,
      hash: "",
      mtime: 0,
      chunk_count: memory["chunk_count"] as number,
      created_at: memory["created_at"] as string,
      updated_at: memory["updated_at"] as string,
      expires_at: memory["expires_at"] as string | null,
    },
    dbPath,
  );

  // Upsert chunks + vectors
  for (const ch of chunkRecords) {
    upsertChunk(
      {
        id: ch.chunk_id,
        path: ch.path,
        start_line: ch.start_line,
        end_line: ch.end_line,
        content: ch.content,
        content_hash: ch.content_hash,
      },
      dbPath,
    );

    // Write vector to chunks_vec
    if (ch.embedding) {
      upsertVector(dbPath, ch.chunk_id, ch.embedding);
    }
  }
}

// ─── Main: runIndex ──────────────────────────────────────────────────────────

export async function runIndex(opts: {
  filePath: string;
  metaYamlPath: string;
  dbPath: string;
  config: IndexConfig;
  embedder?: Embedder;
  dedupThreshold?: number;
}): Promise<IndexResult> {
  const { filePath, metaYamlPath, dbPath, config, embedder, dedupThreshold } = opts;

  // Load meta.yaml
  if (!existsSync(metaYamlPath)) {
    throw new Error(`${metaYamlPath}: meta.yaml not found`);
  }
  const meta = MetaYamlModel.load(metaYamlPath);

  // Step 1: Resolve file context
  const ctx = _resolveFileContext(filePath, metaYamlPath, meta);

  // Validate dimension values (warn but allow)
  const categoryVal = ctx.category;
  const priorityVal = ctx.priority;
  const statusVal = ctx.status;
  if (categoryVal && !meta.validateValue("category", categoryVal)) {
    console.warn(`remx index: ${filePath}: warning: category='${categoryVal}' not in meta.yaml config; allowing anyway`);
  }
  if (priorityVal && !meta.validateValue("priority", priorityVal)) {
    console.warn(`remx index: ${filePath}: warning: priority='${priorityVal}' not in meta.yaml config; allowing anyway`);
  }
  if (statusVal && !meta.validateValue("status", statusVal)) {
    console.warn(`remx index: ${filePath}: warning: status='${statusVal}' not in meta.yaml config; allowing anyway`);
  }

  // Step 2: Chunk content
  const chunks = _buildChunks(ctx.body, ctx.indexPath, meta, config);
  if (chunks.length === 0) {
    throw new Error(`${filePath}: no content to index`);
  }

  // Step 3: Build records
  const { memory, chunkRecords } = _buildMemoryAndChunks(ctx, chunks, meta, embedder);

  // Step 4: Semantic dedup check (knowledge/principle only)
  if (dedupThreshold != null && embedder) {
    const dupes = await _checkSemanticDedup(chunkRecords, ctx, dbPath, embedder, meta, dedupThreshold);
    for (const dupe of dupes) {
      console.warn(
        `[remx] DEDUP WARNING: chunk ${dupe.chunkId.slice(0, 20)}... is ${(dupe.similarity * 100).toFixed(1)}% ` +
        `similar to existing file: ${dupe.existingPath}`,
      );
    }
  }

  // Step 5: Atomic write to DB
  await _writeMemoryToDb(dbPath, memory, chunkRecords, embedder);

  return {
    memoryId: memory["path"] as string,
    category: memory["category"] as string,
    chunkCount: memory["chunk_count"] as number,
    expiresAt: memory["expires_at"] as string | undefined,
    filePath: ctx.filePath,
  };
}

/**
 * recall.ts
 * Memory recall + relevance scoring for RemX v0.3.0.
 *
 * Implements:
 * - Semantic recall (via vector similarity — stubbed, requires embedding provider)
 * - Topology-aware expansion (via topology.ts)
 * - Relevance scoring (hybrid: vector + decay + freshness)
 */

import { join } from "path";
import Database from "better-sqlite3";

import { getDb, DEFAULT_DB } from "../shared/db";
import {
  topologyAwareRecall,
  queryRelations,
  getRelatedNodes,
  matchContext,
  DEFAULT_CONTEXT,
  type BaseResult,
} from "./topology";

// ─── Types ────────────────────────────────────────────────────────────────────

export interface RecallOptions {
  dbPath?: string;
  /** Current session context (e.g. 'group_chat', 'main_session') */
  currentContext?: string;
  /** Max topology expansion depth */
  maxDepth?: number;
  /** Max additional entries from topology expansion */
  maxAdditional?: number;
  /** Weight for decay factor in final score (0.0–1.0) */
  decayWeight?: number;
  /** Max results to return */
  limit?: number;
}

export interface RecallResult {
  id: string;
  category: string;
  chunk: string;
  score: number;
  source: "semantic" | "topology";
  depth?: number;        // only for topology-sourced
  relations?: unknown[]; // only for topology-sourced
}

export interface RelevanceScore {
  final: number;
  vector: number;
  decay: number;
  freshness: number;
}

// ─── Decay Scoring ───────────────────────────────────────────────────────────

export interface DecayParams {
  /** Category: controls which decay rule applies */
  category: string;
  /** When the memory was last updated (Unix ms) */
  updatedAt?: number;
  /** When the memory expires (Unix ms) */
  expiresAt?: number;
}

const DECAY_RULES: Record<string, {
  function: "never" | "ttl" | "stale_after";
  params: Record<string, number>;
}> = {
  tmp:     { function: "ttl",        params: { ttl_hours: 24 } },
  demand:  { function: "stale_after", params: { days: 90, stale_days: 7, decay_rate: 0.1 } },
  issue:   { function: "stale_after", params: { days: 60, stale_days: 7, decay_rate: 0.1 } },
  // knowledge and principle default to never
};

export function computeDecayFactor(p: DecayParams): number {
  const rule = DECAY_RULES[p.category] ?? { function: "never" as const, params: {} };

  if (rule.function === "never") return 1.0;

  const now = Date.now();

  if (rule.function === "ttl") {
    if (!p.expiresAt) return 1.0;
    const ttlHours = (rule.params.ttl_hours ?? 24);
    const ttlMs = ttlHours * 3600 * 1000;
    const remaining = p.expiresAt - now;
    return Math.max(0.0, Math.min(1.0, remaining / ttlMs));
  }

  if (rule.function === "stale_after") {
    if (!p.updatedAt) return 1.0;
    const days = rule.params.days ?? 30;
    const staleDays = rule.params.stale_days ?? 7;
    const rate = rule.params.decay_rate ?? 0.1;
    const daysSince = (now - p.updatedAt) / (86400 * 1000);
    if (daysSince <= staleDays) return 1.0;
    return Math.max(0.0, Math.exp(-rate * (daysSince - staleDays)));
  }

  return 1.0;
}

// ─── Freshness Scoring ───────────────────────────────────────────────────────

export function computeFreshness(updatedAt?: number): number {
  if (!updatedAt) return 0.5;
  const ageHours = (Date.now() - updatedAt) / (3600 * 1000);
  // Linear decay from 1.0 (0h) to 0.0 (720h = 30 days)
  return Math.max(0.0, Math.min(1.0, 1.0 - ageHours / 720));
}

// ─── Vector Similarity ────────────────────────────────────────────────────

/**
 * computeVectorSimilarity — cosine similarity between two vectors.
 */
export function computeVectorSimilarity(
  queryEmbedding: number[],
  candidateEmbedding: number[]
): number {
  if (queryEmbedding.length !== candidateEmbedding.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < queryEmbedding.length; i++) {
    dot += queryEmbedding[i] * candidateEmbedding[i];
    normA += queryEmbedding[i] * queryEmbedding[i];
    normB += candidateEmbedding[i] * candidateEmbedding[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * embedQuery — stubbed (returns zero vector).
 * Use embedQueryWithEmbedder for production.
 */
export async function embedQuery(_text: string): Promise<number[]> {
  return Array(1024).fill(0);
}

/**
 * embedQueryWithEmbedder — embed a single text using the provided embedder.
 */
export async function embedQueryWithEmbedder(
  text: string,
  embedder: import("../core/embedder").Embedder
): Promise<number[]> {
  try {
    const results = await embedder.embed([text]);
    return results[0] ?? [];
  } catch {
    return [];
  }
}

// ─── Semantic Recall (Stubbed) ───────────────────────────────────────────────

export interface SemanticRecallOptions extends RecallOptions {
  queryText?: string;
  queryEmbedding?: number[];
  category?: string;
}

/**
 * semanticRecall — stubbed skeleton.
 *
 * In production this will:
 * 1. Embed queryText → queryEmbedding
 * 2. Search vector table (memories_vec) for top-k candidates
 * 3. Score with hybrid (vector + decay + freshness)
 * 4. Return sorted results
 *
 * Currently returns an empty array — replace body with real implementation.
 */
export async function semanticRecall(
  _opts: SemanticRecallOptions = {}
): Promise<BaseResult[]> {
  // TODO: Implement real semantic search:
  //  1. If !queryEmbedding and queryText → embedQuery(queryText)
  //  2. Build SQL with vec0 distance search on memories_vec JOIN chunks JOIN memories
  //  3. Apply category filter if provided
  //  4. Score each result: (1-decayWeight)*cosine + decayWeight*decay + freshness*freshnessWeight
  //  5. Sort by score DESC, return top limit
  return [];
}

// ─── Topology Recall ─────────────────────────────────────────────────────────

/**
 * topologyRecall — expand a set of base results via graph traversal.
 * See topologyAwareRecall in topology.ts for the actual implementation.
 */
export function topologyRecall(
  baseResults: BaseResult[],
  opts: RecallOptions = {}
): Array<Record<string, unknown> & { source: "topology"; depth: number }> {
  return topologyAwareRecall(baseResults, {
    dbPath: opts.dbPath ?? DEFAULT_DB,
    currentContext: opts.currentContext,
    maxDepth: opts.maxDepth ?? 2,
    maxAdditional: opts.maxAdditional ?? 10,
  });
}

// ─── Unified Recall ──────────────────────────────────────────────────────────

export interface UnifiedRecallOptions extends RecallOptions {
  queryText?: string;
  queryEmbedding?: number[];
  category?: string;
  /** Perform topology expansion on semantic results */
  expandTopology?: boolean;
  /** Weight for freshness in score (0.0–1.0) */
  freshnessWeight?: number;
}

/**
 * unifiedRecall — primary recall entrypoint.
 *
 * Combines semantic search + topology expansion + hybrid scoring.
 *
 * Pipeline:
 *  1. semanticRecall → base results (or empty if no query provided)
 *  2. Optionally: topologyRecall → expanded results
 *  3. Merge, dedupe by id, sort by final score
 *  4. Return top `limit` results
 */
export async function unifiedRecall(
  opts: UnifiedRecallOptions = {}
): Promise<RecallResult[]> {
  const {
    dbPath = DEFAULT_DB,
    currentContext = DEFAULT_CONTEXT,
    limit = 20,
    decayWeight = 0.3,
    freshnessWeight = 0.2,
    expandTopology = true,
    queryText,
    queryEmbedding,
    category,
  } = opts;

  // Step 1: Semantic recall (stubbed for now)
  let baseResults: BaseResult[] = [];
  if (queryText || queryEmbedding) {
    baseResults = await semanticRecall({
      dbPath,
      queryText,
      queryEmbedding,
      category,
      limit,
    });
  }

  // Step 2: Topology expansion
  let topologyResults: Array<Record<string, unknown> & { source: "topology"; depth: number }> = [];
  if (expandTopology) {
    topologyResults = topologyRecall(baseResults.length > 0 ? baseResults : [], {
      dbPath,
      currentContext,
      maxDepth: opts.maxDepth ?? 2,
      maxAdditional: opts.maxAdditional ?? 10,
    });
  }

  // Step 3: Merge results
  const seen = new Set<string>();
  const merged: RecallResult[] = [];

  const addResult = (r: BaseResult, source: "semantic" | "topology", depth?: number) => {
    const id = (r.id ?? r.memory_id) as string;
    if (!id || seen.has(id)) return;
    seen.add(id);

    const chunk = (r.chunk ?? r.content ?? "") as string;
    const cat = (r.category ?? "unknown") as string;

    // Compute scores
    const decay = computeDecayFactor({
      category: cat,
      updatedAt: r.updated_at as number | undefined,
      expiresAt: r.expires_at as number | undefined,
    });
    const freshness = computeFreshness(r.updated_at as number | undefined);
    const vector = (r.score ?? 0.5) as number;

    const final = Math.min(1.0,
      (1.0 - decayWeight - freshnessWeight) * vector +
      decayWeight * decay +
      freshnessWeight * freshness
    );

    merged.push({
      id,
      category: cat,
      chunk,
      score: Math.round(final * 1e6) / 1e6,
      source,
      depth,
      relations: source === "topology" ? ((r.topology_relations as unknown[] | undefined) ?? []) : undefined,
    });
  };

  for (const r of baseResults) addResult(r, "semantic");
  for (const r of topologyResults) addResult(r, "topology", r.depth);

  // Step 4: Sort by score DESC, apply limit
  merged.sort((a, b) => b.score - a.score);
  return merged.slice(0, limit);
}

// ─── Relevance Judgment ─────────────────────────────────────────────────────

export interface RelevanceJudgment {
  nodeId: string;
  score: number;
  reasons: string[];
  context: string | null;
}

/**
 * judgeRelevance — determine if a given memory node is relevant to a query context.
 *
 * Returns a score + human-readable reasons.
 *
 * Factors:
 * - Context match (exact or global)
 * - Category alignment
 * - Recency / freshness
 * - Relation density (how many relations does this node have?)
 */
export function judgeRelevance(
  nodeId: string,
  opts: {
    dbPath?: string;
    currentContext?: string;
    queryCategory?: string;
  } = {}
): RelevanceJudgment {
  const { dbPath = DEFAULT_DB, currentContext = DEFAULT_CONTEXT, queryCategory } = opts;

  const rels = queryRelations(dbPath, nodeId, currentContext);
  const reasons: string[] = [];

  let score = 0.5; // base

  // Context match bonus
  const hasGlobalRel = rels.some((r) => r.context === null || r.context === DEFAULT_CONTEXT);
  const hasContextRel = rels.some((r) => r.context === currentContext);
  if (hasContextRel) {
    score += 0.3;
    reasons.push(`context match: '${currentContext}'`);
  } else if (hasGlobalRel) {
    score += 0.1;
    reasons.push("global context (fallback)");
  } else {
    score -= 0.2;
    reasons.push("no matching context relation");
  }

  // Relation density bonus
  const density = rels.length;
  if (density >= 3) {
    score += 0.2;
    reasons.push(`high relation density (${density} relations)`);
  } else if (density >= 1) {
    score += 0.1;
    reasons.push(`low relation density (${density} relation)`);
  } else {
    reasons.push("isolated (no relations)");
  }

  // Category alignment
  if (queryCategory) {
    const nodeRels = getRelatedNodes(dbPath, nodeId, currentContext, 1);
    const relatedCategories = Object.values(nodeRels).map((d) => d.node.category);
    if (relatedCategories.includes(queryCategory)) {
      score += 0.15;
      reasons.push(`category alignment: '${queryCategory}'`);
    }
  }

  // Relation type bonuses
  const hasCausal = rels.some((r) => r.rel_type === "因果关系");
  const hasSequential = rels.some((r) => r.rel_type === "流程顺序性");
  if (hasCausal) { score += 0.1; reasons.push("has causal relation"); }
  if (hasSequential) { score += 0.05; reasons.push("has sequential relation"); }

  return {
    nodeId,
    score: Math.max(0.0, Math.min(1.0, score)),
    reasons,
    context: currentContext,
  };
}

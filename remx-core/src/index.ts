/**
 * remx-core — RemX v0.3.0 unified memory system (TypeScript)
 *
 * Exports:
 *   memory/  — topology, recall, crud
 *   runtime/ — triple-store
 */

// Memory layer — topology (rename internal getDb to avoid collision)
export {
  REL_TYPES_ARRAY,
  REL_ROLES_ARRAY,
  REL_TYPES,
  REL_ROLES,
  DEFAULT_CONTEXT,
  type RelType,
  type RelRole,
  type MemoryNode,
  type MemoryRelation,
  type RelationParticipant,
  type RelationWithParticipants,
  type RelatedNodeData,
  type BaseResult,
  ensureNode,
  listNodes,
  deleteNode as deleteTopologyNode,
  insertRelation,
  deleteRelation,
  queryRelations,
  getRelatedNodes,
  matchContext,
  topologyAwareRecall,
} from "./memory/topology";

// memory/recall
export {
  computeDecayFactor,
  computeFreshness,
  computeVectorSimilarity,
  embedQuery,
  embedQueryWithEmbedder,
  semanticRecall,
  topologyRecall,
  unifiedRecall,
  judgeRelevance,
  type RecallOptions,
  type RecallResult,
  type RelevanceScore,
  type UnifiedRecallOptions,
} from "./memory/recall";

// memory/crud — aligned with OpenClaw files/chunks model
// Removed: initSchema (now part of initDb), createChunk, updateChunk (replaced by upsertChunk)
export {
  getMemoryById,
  listMemories,
  createMemory,
  updateMemory,
  deleteMemory,
  softDeleteMemory,
  hardDeleteMemory,
  createMemoryWithChunks,
  getMemoryWithChunks,
  upsertChunks,
  upsertChunk,
  listChunks,
  getChunkById,
  softDeleteChunk,
  contentHash,
  contentHashSync,
  expiresAtTTL,
  isExpired,
  findExpiredMemories,
  type Memory,
  type Chunk,
  type MemoryWithChunks,
  type CreateMemoryOptions,
  type CreateChunkOptions,
  type UpdateMemoryOptions,
  type DeleteOptions,
  type MemoryFilter,
} from "./memory/crud";

// Runtime layer
export {
  insertTriple,
  queryTriples,
  deleteTriple,
  listTriples,
  parseParticipants,
  cliRun,
  upsertNode,
  type InsertTripleOptions,
  type QueryTriplesOptions,
  type TripleRow,
} from "./runtime/triple-store";

// core/schema
export {
  MetaYamlModel,
  DEFAULT_DECAY_GROUPS,
  DEFAULT_EMBEDDER_CONFIG,
  DEFAULT_VECTOR_CONFIG,
  DEFAULT_CHUNK_CONFIG,
  DEFAULT_NORMAL_DIMENSIONS,
  type EmbedderConfig,
  type NormalDimension,
  type DecayDimension,
  type NormalDimensions,
  type DecayGroup,
  type IndexScope,
  type VectorConfig,
  type ChunkConfig,
  type MetaYaml,
} from "./core/schema";

// runtime/db
export {
  initDb,
  gcCollect,
  gcSoftDelete,
  gcPurge,
  retrieve,
  retrieveSemantic,
  nowIso,
  expiresAtTtl,
  expiresAtStale,
  type GcCollectResult,
  type GcSoftDeleteResult,
  type GcPurgeResult,
  type RetrieveRow,
  type RetrieveFilter,
} from "./runtime/db";

/**
 * remx-core — RemX v0.3.0 unified memory system (TypeScript)
 *
 * Exports:
 *   memory/  — graph, recall, memory
 */

// Memory layer — graph (topology.ts renamed)
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
} from "./memory/graph";

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

// memory/memory — aligned with OpenClaw files/chunks model (merged from crud + db)
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
} from "./memory/memory";

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

// memory/memory (merged from runtime/db)
export {
  initDb,
  gcCollect,
  gcSoftDelete,
  gcPurge,
  retrieve,
  retrieveSemantic,
  expiresAtTtl,
  expiresAtStale,
  type GcCollectResult,
  type GcSoftDeleteResult,
  type GcPurgeResult,
  type RetrieveRow,
  type RetrieveFilter,
} from "./memory/memory";

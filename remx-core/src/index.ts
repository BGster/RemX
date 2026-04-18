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
  semanticRecall,
  topologyRecall,
  unifiedRecall,
  judgeRelevance,
  type RecallOptions,
  type RecallResult,
  type RelevanceScore,
  type UnifiedRecallOptions,
} from "./memory/recall";

// memory/crud — hide conflicting names behind an alias
export {
  initSchema as initCrudSchema,
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
  listChunks,
  createChunk,
  getChunkById,
  updateChunk,
  softDeleteChunk,
  contentHash,
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
  initSchema,
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

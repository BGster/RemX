"""remx index command — index a single file into memories + chunks + memories_vec."""
import hashlib
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

from pydantic import BaseModel

from ..core.chunker import chunk_paragraphs_simple, chunk_by_headings, count_tokens, _normalize_path, _is_global_path
from ..core.db import expires_at_stale, expires_at_ttl, now_iso, write_memory
from ..core.embedding import get_embedding
from ..core.schema import IndexScope, MetaYaml
from ..core.storage import parse_front_matter


# ─── Config & Result Models ───────────────────────────────────────────────────

class IndexConfig(BaseModel):
    """Configuration for run_index chunking parameters."""
    chunk_size_paras: int = 1
    overlap_paras: int = 0
    max_tokens: int = 512


class IndexResult(BaseModel):
    """Result of run_index."""
    memory_id: str
    chunk_count: int
    expires_at: Optional[str]
    file_path: Path


# ─── FileContext ──────────────────────────────────────────────────────────────

@dataclass
class FileContext:
    """Validated and parsed file context for indexing."""
    file_path: Path
    content: str                      # raw text (full file)
    front_matter: dict                # parsed front-matter (empty dict if none)
    body: str                          # text after front-matter delimiter
    index_path: str                    # display path used in chunk_ids
    scope: Optional[IndexScope]        # matched scope, or None
    category: str
    priority: Optional[str]
    status: str
    doc_type: Optional[str]
    created_at: str                    # ISO timestamp
    now: str                           # captured at resolution time


# ─── Pure Functions ───────────────────────────────────────────────────────────

def _resolve_file_context(
    file_path: Path,
    meta_yaml_path: Path,
    meta: MetaYaml,
) -> FileContext:
    """Resolve and validate a file against index_scope; parse front-matter.

    Returns FileContext on success.
    Raises ValueError on failure (file not found, not in scope, parse error).
    """
    # Validate and normalize path
    try:
        resolved_path = _normalize_path(str(file_path))
    except ValueError as e:
        raise ValueError(f"{file_path}: {e}")

    if not Path(resolved_path).exists():
        raise ValueError(f"{file_path}: file not found")

    # Find matching index_scope
    scope = meta.find_scope(file_path, meta_yaml_path.parent)
    scope_category = None
    if scope:
        scope_category = meta.extract_category_from_scope(scope)

    # Compute index_path (display path for chunk_ids)
    if scope:
        try:
            scope_resolved = (meta_yaml_path.parent / scope.path).resolve()
            index_path = str(file_path.resolve().relative_to(scope_resolved))
        except ValueError:
            index_path = str(file_path)
    elif _is_global_path(str(file_path)):
        home = str(Path.home())
        index_path = str(file_path).replace(home, "~")
    else:
        index_path = str(file_path)

    # Parse front-matter
    text = file_path.read_text(encoding="utf-8")
    front_matter, body = parse_front_matter(text)

    # Resolve category: front_matter > scope > "unknown"
    category = front_matter.get("category") or scope_category or "unknown"
    priority = front_matter.get("priority")
    status = front_matter.get("status", "open")
    doc_type = front_matter.get("type")

    now = now_iso()
    created_at = front_matter.get("created_at") or now

    return FileContext(
        file_path=file_path,
        content=text,
        front_matter=front_matter,
        body=body,
        index_path=index_path,
        scope=scope,
        category=category,
        priority=priority,
        status=status,
        doc_type=doc_type,
        created_at=created_at,
        now=now,
    )


def _build_chunks(
    body: str,
    index_path: str,
    meta: MetaYaml,
    config: IndexConfig,
) -> list:
    """Split body text into chunks according to meta.yaml strategy.

    Pure function — no I/O, no DB access.
    """
    paragraphs = [p.strip() for p in body.split("\n\n") if p.strip()]
    if not paragraphs:
        return []

    ov = config.overlap_paras if config.overlap_paras >= 0 else meta.chunk.overlap
    strategy = getattr(meta.chunk, "strategy", "heading")

    if strategy == "heading":
        hl = getattr(meta.chunk, "heading_levels", [1, 2, 3])
        return chunk_by_headings(
            paragraphs,
            index_path,
            max_tokens=config.max_tokens,
            overlap_paras=ov,
            heading_levels=hl,
        )
    else:
        cs = config.chunk_size_paras
        if cs <= 0:
            para_tokens_list = [count_tokens(p) for p in paragraphs]
            avg_para_tokens = max(1, sum(para_tokens_list) // max(1, len(paragraphs)))
            cs = max(1, meta.chunk.max_tokens // avg_para_tokens)
        return chunk_paragraphs_simple(paragraphs, index_path, chunk_size_paras=cs, overlap_paras=ov)


def _build_memory_and_chunks(
    ctx: FileContext,
    chunks: list,
    meta: MetaYaml,
    embedder: Optional[Any],
) -> tuple[dict, list[dict]]:
    """Build memory record dict and chunk dicts (with embeddings).

    Returns (memory, chunk_dicts).
    """
    # Idempotent memory_id based on file_path
    file_path_str = str(ctx.file_path)
    memory_id = hashlib.sha256(file_path_str.encode()).hexdigest()[:16].upper()
    memory_id = f"{ctx.category[:3].upper()}-{memory_id}"

    # Compute expires_at (stale_after uses ctx.now as reference)
    expires_at = _compute_expires_at(meta, ctx.category, ctx.status, updated_at=ctx.now)

    # Embed chunks (embedding skipped if content_hash matches existing DB chunk)
    chunk_dicts = []
    for ch in chunks:
        content_hash = hashlib.sha256(ch.content.encode()).hexdigest()[:16]
        embedding = get_embedding(embedder, ch.content, meta.vector.dimensions) if embedder else None
        chunk_dicts.append({
            "chunk_id": ch.chunk_id,
            "chunk_index": int(ch.chunk_id.rsplit("::", 1)[-1]),
            "content": ch.content,
            "content_hash": content_hash,
            "embedding": embedding,
        })

    memory = {
        "id": memory_id,
        "category": ctx.category,
        "priority": ctx.priority,
        "status": ctx.status,
        "type": ctx.doc_type,
        "file_path": file_path_str,
        "chunk_count": len(chunks),
        "created_at": ctx.created_at,
        "updated_at": ctx.now,
        "expires_at": expires_at,
    }

    return memory, chunk_dicts


def check_semantic_dedup(
    chunks: list[dict],
    ctx: FileContext,
    db_path: Path,
    embedder: Any,
    meta: MetaYaml,
    threshold: float = 0.95,
) -> list[tuple[str, str, float]]:
    """Check for cross-file semantic duplicates in knowledge/principle categories.

    For each new chunk, search for similar existing chunks in knowledge/principle
    categories. Returns list of (new_chunk_id, existing_file_path, similarity).
    Only checks categories that typically contain reusable knowledge.
    """
    from ..core.db import get_db, deserialize_vector, serialize_vector
    import struct

    if not embedder:
        return []

    # Only check knowledge and principle categories
    check_categories = {"knowledge", "principle"}
    if ctx.category not in check_categories:
        return []

    conn = get_db(db_path)
    try:
        dupes: list[tuple[str, str, float]] = []

        for ch in chunks:
            if not ch.get("embedding"):
                continue

            # Search for similar chunks in check_categories
            vector_dim = meta.vector.dimensions
            vec_blob = serialize_vector(ch["embedding"])

            rows = conn.execute(
                f"""
                SELECT v.chunk_id, v.distance, m.file_path, c.content
                FROM memories_vec v
                JOIN chunks c ON c.chunk_id = v.chunk_id
                JOIN memories m ON m.id = c.parent_id
                WHERE m.category IN ({', '.join(['?'] * len(check_categories))})
                  AND m.deprecated = 0
                  AND c.deprecated = 0
                LIMIT 10
                """,
                list(check_categories),
            ).fetchall()

            for row in rows:
                # Skip same file
                if row["file_path"] == str(ctx.file_path):
                    continue
                # Convert L2 distance to cosine similarity
                distance = row["distance"]
                similarity = 1.0 / (1.0 + distance)
                if similarity >= threshold:
                    dupes.append((ch["chunk_id"], row["file_path"], round(similarity, 4)))

        return dupes
    finally:
        conn.close()


# ─── Compute Expires At ───────────────────────────────────────────────────────

def _compute_expires_at(
    meta: MetaYaml,
    category: str,
    status: Optional[str] = None,
    updated_at: Optional[str] = None,
) -> Optional[str]:
    """Compute expires_at from matching decay_group, or None.

    For ttl:     expires_at = now + ttl_hours
    For stale_after: expires_at = updated_at + days  (relative to last update)
    """
    dg = meta.decay_group_for(category, status)
    if not dg:
        return None

    fn = dg.function
    params = dg.params

    if fn == "ttl":
        ttl_hours = params.get("ttl_hours", 24)
        return expires_at_ttl(ttl_hours)
    elif fn == "stale_after":
        days = params.get("days", 30)
        return expires_at_stale(days, updated_at)
    else:
        return None


# ─── Main Command ─────────────────────────────────────────────────────────────

def run_index(
    file_path: Path,
    meta_yaml_path: Path,
    db_path: Path,
    config: IndexConfig = IndexConfig(),
    embedder: Optional[Any] = None,
    *,
    dedup_threshold: Optional[float] = None,
) -> IndexResult:
    """Index a single file into the database.

    Orchestrator steps:
    1. Load meta.yaml
    2. Resolve file context (path + scope + front-matter)
    3. Chunk content (pure)
    4. Build memory + chunk records (with embedding)
    5. Semantic dedup check (optional, for knowledge/principle)
    6. Atomic write to DB

    Args:
        file_path: file to index
        meta_yaml_path: path to meta.yaml
        db_path: path to SQLite database
        config: IndexConfig with chunking parameters
        embedder: embedding provider (or None to skip vectors)
        dedup_threshold: if set, enable cross-file semantic dedup for
                         knowledge/principle categories (cosine similarity threshold)

    Returns:
        IndexResult on success

    Raises:
        ValueError on file/scope errors
    """
    if not meta_yaml_path.exists():
        raise ValueError(f"{meta_yaml_path}: meta.yaml not found")

    meta = MetaYaml.load(meta_yaml_path)

    # Step 2: Resolve file context
    ctx = _resolve_file_context(file_path, meta_yaml_path, meta)

    # Validate dimension values (warn but allow)
    for dim_name, dim_val in [("category", ctx.category), ("priority", ctx.priority), ("status", ctx.status)]:
        if dim_val and not meta.validate_value(dim_name, str(dim_val)):
            print(f"remx index: {file_path}: warning: {dim_name}='{dim_val}' not in meta.yaml config; allowing anyway",
                  file=sys.stderr)

    # Step 3: Chunk content
    chunks = _build_chunks(ctx.body, ctx.index_path, meta, config)
    if not chunks:
        raise ValueError(f"{file_path}: no content to index")

    # Step 4: Build records
    memory, chunk_dicts = _build_memory_and_chunks(ctx, chunks, meta, embedder)

    # Step 5: Semantic dedup check (knowledge/principle only)
    if dedup_threshold is not None and embedder:
        dupes = check_semantic_dedup(
            chunks=chunk_dicts,
            ctx=ctx,
            db_path=db_path,
            embedder=embedder,
            meta=meta,
            threshold=dedup_threshold,
        )
        for chunk_id, existing_path, similarity in dupes:
            print(
                f"[remx] DEDUP WARNING: chunk {chunk_id[:20]}... is {similarity:.1%} "
                f"similar to existing file: {existing_path}",
                file=sys.stderr,
            )

    # Step 6: Atomic write
    try:
        write_memory(
            db_path=db_path,
            memory=memory,
            chunks=chunk_dicts,
            vector_dimensions=meta.vector.dimensions,
        )
    except Exception as e:
        raise ValueError(f"{file_path}: write error — {e}")

    print(f"remx index: indexed {file_path}")
    print(f"  memory_id: {memory['id']}")
    print(f"  category: {memory['category']}")
    print(f"  chunks: {memory['chunk_count']}")
    if memory.get("expires_at"):
        print(f"  expires_at: {memory['expires_at']}")

    return IndexResult(
        memory_id=memory["id"],
        chunk_count=memory["chunk_count"],
        expires_at=memory.get("expires_at"),
        file_path=file_path,
    )

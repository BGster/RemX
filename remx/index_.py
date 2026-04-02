"""remx index command — index a single file into memories + chunks + memories_vec."""
import json
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from .chunker import chunk_paragraphs_simple, chunk_by_headings, count_tokens, _normalize_path, _is_global_path
from .db import expires_at_stale, expires_at_ttl, now_iso, write_memory
from .embedding import get_embedding
from .schema import MetaYaml
from .storage import parse_front_matter


def run_index(
    file_path: Path,
    meta_yaml_path: Path,
    db_path: Path,
    embedder=None,
    chunk_size_paras: int = 1,
    overlap_paras: int = 0,
    max_tokens: int = 512,
) -> int:
    """Index a single file into the database.

    Steps:
    1. Load meta.yaml
    2. Find matching index_scope
    3. Parse front-matter → extract metadata
    4. Split body into paragraphs, group into chunks
    5. Compute expires_at from decay_groups
    6. Write memory + chunks + vectors atomically

    Args:
        file_path: file to index
        meta_yaml_path: path to meta.yaml
        db_path: path to SQLite database
        embedder: embedding provider (or None to skip vectors)
        chunk_size_paras: paragraphs per chunk (overrides meta.yaml)
        overlap_paras: paragraph overlap (overrides meta.yaml)
        max_tokens: max tokens per chunk (overrides meta.yaml)

    Returns:
        0 on success, 1 on error
    """
    # ── 0. Normalize and validate path ─────────────────────────────────────────
    try:
        resolved_path = _normalize_path(str(file_path))
    except ValueError as e:
        print(f"remx index: {file_path}: {e}", file=sys.stderr)
        return 1

    if not Path(resolved_path).exists():
        print(f"remx index: {file_path}: file not found", file=sys.stderr)
        return 1

    if not meta_yaml_path.exists():
        print(f"remx index: {meta_yaml_path}: meta.yaml not found", file=sys.stderr)
        return 1

    # ── 1. Load meta.yaml ──────────────────────────────────────────────────────
    try:
        meta = MetaYaml.load(meta_yaml_path)
    except Exception as e:
        print(f"remx index: {meta_yaml_path}: parse error — {e}", file=sys.stderr)
        return 1

    # ── 2. Find index_scope ────────────────────────────────────────────────────
    scope = meta.find_scope(file_path, meta_yaml_path.parent)
    category = None
    if scope:
        category = meta.scope_category(scope)

    # ── 2b. Compute chunk_id path component ─────────────────────────────────────
    # project memory: relative to scope path;  global memory: ~-prefixed display path
    if scope:
        try:
            scope_resolved = (meta_yaml_path.parent / scope.path).resolve()
            index_path = str(file_path.resolve().relative_to(scope_resolved))
        except ValueError:
            # file_path is not relative to scope.path — use as-is
            index_path = str(file_path)
    elif _is_global_path(str(file_path)):
        # Global memory: display path with home replaced by ~
        home = str(Path.home())
        index_path = str(file_path).replace(home, "~")
    else:
        # Relative path not under any scope — treat as project
        index_path = str(file_path)

    # ── 3. Parse front-matter ──────────────────────────────────────────────────
    text = file_path.read_text(encoding="utf-8")
    front_matter, body = parse_front_matter(text)

    # Infer category from front-matter or scope
    category = front_matter.get("category") or category or "unknown"
    priority = front_matter.get("priority")
    status = front_matter.get("status", "open")
    doc_type = front_matter.get("type")

    # Validate dimension values
    for dim_name, dim_val in [("category", category), ("priority", priority), ("status", status)]:
        if dim_val and not meta.validate_value(dim_name, str(dim_val)):
            print(f"remx index: {file_path}: warning: {dim_name}='{dim_val}' not in meta.yaml config; allowing anyway",
                  file=sys.stderr)

    # ── 4. Chunk content ───────────────────────────────────────────────────────
    paragraphs = [p.strip() for p in body.split("\n\n") if p.strip()]

    # Use meta.yaml overlap (by paragraph count)
    ov = overlap_paras if overlap_paras >= 0 else meta.chunk.overlap

    # Choose chunking strategy from meta.yaml
    strategy = meta.chunk.strategy if hasattr(meta.chunk, 'strategy') else "heading"

    if strategy == "heading":
        # Heading-level semantic chunking (default)
        hl = meta.chunk.heading_levels if hasattr(meta.chunk, 'heading_levels') else [1, 2, 3]
        chunks = chunk_by_headings(
            paragraphs,
            index_path,
            max_tokens=max_tokens,
            overlap_paras=ov,
            heading_levels=hl,
        )
    else:
        # Paragraph-level fallback
        cs = chunk_size_paras
        if cs <= 0:
            avg_para_tokens = max(1, sum(count_tokens(p) for p in paragraphs) // max(1, len(paragraphs)))
            cs = max(1, meta.chunk.max_tokens // avg_para_tokens)
        chunks = chunk_paragraphs_simple(paragraphs, index_path, chunk_size_paras=cs, overlap_paras=ov)

    if not chunks:
        print(f"remx index: {file_path}: no content to index", file=sys.stderr)
        return 1

    # ── 5. Compute expires_at ───────────────────────────────────────────────────
    expires_at = _compute_expires_at(meta, category, status)

    # ── 6. Generate memory id ───────────────────────────────────────────────────
    # Idempotent: based on file_path to avoid duplicates on re-index
    import hashlib
    memory_id = hashlib.sha256(str(file_path).encode()).hexdigest()[:16].upper()
    # Prefix with category for readability
    memory_id = f"{category[:3].upper()}-{memory_id}"

    # ── 7. Embed chunks ─────────────────────────────────────────────────────────
    chunk_dicts = []
    for ch in chunks:
        embedding = None
        if embedder:
            embedding = get_embedding(embedder, ch.content, meta.vector.dimensions)
        chunk_dicts.append({
            "chunk_id": ch.chunk_id,
            "chunk_index": int(ch.chunk_id.rsplit("::", 1)[-1]),
            "content": ch.content,
            "embedding": embedding,
        })

    # ── 8. Build memory record ─────────────────────────────────────────────────
    now = now_iso()
    memory = {
        "id": memory_id,
        "category": category,
        "priority": priority,
        "status": status,
        "type": doc_type,
        "file_path": str(file_path),
        "chunk_count": len(chunks),
        "created_at": front_matter.get("created_at") or now,
        "updated_at": now,
        "expires_at": expires_at,
    }

    # ── 9. Atomic write ────────────────────────────────────────────────────────
    try:
        write_memory(
            db_path=db_path,
            memory=memory,
            chunks=chunk_dicts,
            vector_dimensions=meta.vector.dimensions,
        )
    except Exception as e:
        print(f"remx index: {file_path}: write error — {e}", file=sys.stderr)
        return 1

    print(f"remx index: indexed {file_path}")
    print(f"  memory_id: {memory_id}")
    print(f"  category: {category}")
    print(f"  chunks: {len(chunks)}")
    if expires_at:
        print(f"  expires_at: {expires_at}")

    return 0


def _compute_expires_at(
    meta: MetaYaml,
    category: str,
    status: Optional[str] = None,
) -> Optional[str]:
    """Compute expires_at from matching decay_group, or None."""
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
        return expires_at_stale(days)
    else:
        return None

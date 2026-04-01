"""Chunking logic for Project-Manager v2.

Splits a markdown file into paragraphs, then groups paragraphs into chunks
respecting max_tokens (soft limit) with paragraph-level overlap.

chunk_id format:
  global::{display_path}::{chunk_index}   -- global memory (~ or / prefix)
  project::{relative_path}::{chunk_index} -- project memory (relative path)

Security: paths containing '..' are rejected to prevent directory escape.
"""
import re
import tiktoken
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .storage import parse_front_matter


# ─── Path utilities ──────────────────────────────────────────────────────────

def _normalize_path(path: str) -> str:
    """Normalize a file path, expanding ~ to home directory.
    
    Raises ValueError if path contains '..' (directory escape attempt).
    """
    if ".." in path:
        raise ValueError(f"Path with '..' is not allowed: {path}")
    if path.startswith("~"):
        return str(Path(path).expanduser().resolve())
    return path


def _is_global_path(path: str) -> bool:
    """Return True if path is global (starts with ~ or /)."""
    return path.startswith("~") or path.startswith("/")


def make_chunk_id(file_path: str, chunk_index: int) -> str:
    """Generate a chunk_id with global:: or project:: prefix.
    
    chunk_id format:
      global::{display}::{chunk_index}   -- ~ or / prefix
      project::{relative}::{chunk_index} -- relative path
    """
    home = str(Path.home())
    if _is_global_path(file_path):
        # Display path: replace home with ~
        display = file_path.replace(home, "~") if file_path.startswith(home) else file_path
        return f"global::{display}::{chunk_index}"
    else:
        return f"project::{file_path}::{chunk_index}"


@dataclass
class Chunk:
    chunk_id: str
    content: str
    para_indices: list[int] = field(default_factory=list)  # which paragraphs this chunk covers
    token_count: int = 0
    heading_level: int = 0    # 0=none, 1=H1, 2=H2, 3=H3
    heading_text: str = ""    # heading content (empty if no heading)


# Markdown heading pattern: lines starting with 1-6 # characters
_HEADING_RE = re.compile(r"^(#{1,6})\s+(.+)$", re.MULTILINE)
# Code fence pattern
_CODE_FENCE_RE = re.compile(r"^```", re.MULTILINE)
# Sentence-ending characters for fallback sentence splitting
_SENTENCE_END_RE = re.compile(r"[。？！；\n]")


def count_tokens(text: str, model: str = "cl100k_base") -> int:
    """Count tokens using tiktoken (GPT-4 / cl100k_base encoding)."""
    try:
        enc = tiktoken.get_encoding(model)
        return len(enc.encode(text))
    except Exception:
        # Fallback: naive word count * 1.3 as rough token estimate
        return int(len(text.split()) * 1.3)


def split_paragraphs(text: str) -> list[str]:
    """Split text into paragraphs on \\n\\n boundaries, stripping empty ones."""
    paras = []
    for para in text.split("\n\n"):
        stripped = para.strip()
        if stripped:
            paras.append(stripped)
    return paras


def split_sentences(text: str) -> list[str]:
    """Split a paragraph into sentences on sentence-ending punctuation."""
    parts = _SENTENCE_END_RE.split(text)
    return [p.strip() for p in parts if p.strip()]


def chunk_file(
    file_path: Path,
    max_tokens: int = 512,
    overlap_paras: int = 0,
) -> list[Chunk]:
    """Split a file into chunks by paragraphs with optional overlap.

    Algorithm:
    1. Parse front-matter → strip it, keep body text
    2. Split body into paragraphs (\n\n)
    3. Walk through paragraphs, accumulating tokens
    4. When token count >= max_tokens, finalize current chunk,
       start next with overlap_paras from previous
    5. If a single para exceeds max_tokens, split by sentences

    Args:
        file_path: path to the file to chunk
        max_tokens: soft max token count per chunk
        overlap_paras: number of trailing paragraphs to include as overlap

    Returns:
        List of Chunk objects
    """
    text = file_path.read_text(encoding="utf-8")
    _, body = parse_front_matter(text)
    paragraphs = split_paragraphs(body)
    return _make_chunks(paragraphs, str(file_path), max_tokens, overlap_paras)


def chunk_content(
    content: str,
    file_path: str,
    max_tokens: int = 512,
    overlap_paras: int = 0,
) -> list[Chunk]:
    """Chunk raw content text (no front-matter stripping)."""
    paragraphs = split_paragraphs(content)
    return _make_chunks(paragraphs, file_path, max_tokens, overlap_paras)


def _make_chunks(
    paragraphs: list[str],
    file_path: str,
    max_tokens: int,
    overlap_paras: int,
) -> list[Chunk]:
    if not paragraphs:
        return []

    chunks: list[Chunk] = []
    chunk_index = 0
    current_paras: list[str] = []
    current_token_count = 0
    start_para_idx = 0  # tracks the paragraph index of the first para in current chunk

    for para_idx, para in enumerate(paragraphs):
        para_tokens = count_tokens(para)

        # Handle super-long single paragraph
        if para_tokens > max_tokens:
            # First, flush current chunk if non-empty
            if current_paras:
                chunk_text = "\n\n".join(current_paras)
                chunk_id = make_chunk_id(file_path, chunk_index)
                chunks.append(Chunk(
                    chunk_id=chunk_id,
                    content=chunk_text,
                    para_indices=list(range(start_para_idx, para_idx)),
                    token_count=current_token_count,
                ))
                chunk_index += 1
                current_paras = []
                current_token_count = 0

            # Split the long paragraph by sentences
            sentences = split_sentences(para)
            sub_paras: list[str] = []
            sub_token_count = 0
            for sent in sentences:
                sent_tokens = count_tokens(sent)
                if sub_token_count + sent_tokens >= max_tokens and sub_paras:
                    # Emit sub-chunk
                    sub_text = "".join(sub_paras)
                    sub_chunk_id = make_chunk_id(file_path, chunk_index)
                    chunks.append(Chunk(
                        chunk_id=sub_chunk_id,
                        content=sub_text,
                        para_indices=[para_idx],
                        token_count=sub_token_count,
                    ))
                    chunk_index += 1
                    sub_paras = []
                    sub_token_count = 0
                sub_paras.append(sent)
                sub_token_count += sent_tokens
            if sub_paras:
                current_paras = sub_paras
                current_token_count = sub_token_count
                start_para_idx = para_idx
            continue

        # Normal paragraph — check if adding it exceeds max_tokens
        if current_token_count + para_tokens > max_tokens and current_paras:
            # Finalize current chunk
            chunk_text = "\n\n".join(current_paras)
            chunk_id = make_chunk_id(file_path, chunk_index)
            chunks.append(Chunk(
                chunk_id=chunk_id,
                content=chunk_text,
                para_indices=list(range(start_para_idx, para_idx)),
                token_count=current_token_count,
            ))
            chunk_index += 1

            # Start new chunk with overlap paragraphs
            overlap_start = max(0, len(current_paras) - overlap_paras)
            current_paras = current_paras[overlap_start:]
            current_token_count = sum(count_tokens(p) for p in current_paras)
            start_para_idx = para_idx - len(current_paras) + overlap_start

        current_paras.append(para)
        current_token_count += para_tokens

    # Flush remaining
    if current_paras:
        chunk_text = "\n\n".join(current_paras)
        chunk_id = make_chunk_id(file_path, chunk_index)
        chunks.append(Chunk(
            chunk_id=chunk_id,
            content=chunk_text,
            para_indices=list(range(start_para_idx, len(paragraphs))),
            token_count=current_token_count,
        ))

    return chunks


# ─── Heading-level chunking ────────────────────────────────────────────────

def chunk_by_headings(
    paragraphs: list[str],
    file_path: str,
    max_tokens: int,
    overlap_paras: int,
    heading_levels: list[int] = None,
) -> list[Chunk]:
    """Split markdown content by H1/H2/H3 headings as semantic units.

    Algorithm:
    1. Scan paragraphs, identify heading lines (matching heading_levels)
    2. Each heading + subsequent content = one semantic unit
    3. If unit token count > max_tokens, split within by sentences
    4. Units are emitted as chunks, respecting overlap via overlap_paras
    """
    import sys
    if heading_levels is None:
        heading_levels = [1, 2, 3]

    if not paragraphs:
        return []

    chunks: list[Chunk] = []
    chunk_index = 0

    # ── Step 1: Group paragraphs into semantic sections ──────────────────
    sections: list[dict] = []  # list of {heading_level, heading_text, paras: []}
    current: dict = {"heading_level": 0, "heading_text": "", "paras": []}

    for para_idx, para in enumerate(paragraphs):
        # Detect heading
        heading_match = _HEADING_RE.match(para.strip())
        if heading_match:
            lvl = len(heading_match.group(1))
            heading_txt = heading_match.group(2).strip()
            if lvl in heading_levels:
                # Save previous section only if it has content
                if current["paras"]:
                    sections.append(current)
                # Start new section
                current = {
                    "heading_level": lvl,
                    "heading_text": heading_txt,
                    "paras": [],
                }
            else:
                # Heading level not in scope — treat as normal paragraph
                current["paras"].append(para)
        else:
            current["paras"].append(para)

    # Don't forget last section
    if current["paras"]:
        sections.append(current)

    # ── Step 2: If no sections (no headings found), fall back to paragraph ──
    if not sections:
        return _make_chunks(paragraphs, file_path, max_tokens, overlap_paras)

    # ── Step 3: Emit chunks — each heading section = one chunk ─────────────
    # Overlap: for heading strategy, overlap means the last N section content blocks
    # are prepended to the NEXT chunk (preserving heading context from previous chunk)
    _chunk_index = 0
    overlap_buffer: list[str] = []   # content blocks kept for next chunk's start
    overlap_tokens: int = 0
    overlap_heading_level: int = 0
    overlap_heading_text: str = ""

    def _emit(chunk_paras: list, tokens: int, lvl: int, htxt: str) -> None:
        nonlocal _chunk_index
        chunk_text = "\n\n".join(chunk_paras)
        chunks.append(Chunk(
            chunk_id=make_chunk_id(file_path, _chunk_index),
            content=chunk_text,
            para_indices=[],
            token_count=tokens,
            heading_level=lvl,
            heading_text=htxt,
        ))
        _chunk_index += 1

    for sec in sections:
        heading = sec["heading_text"]
        heading_lvl = sec["heading_level"]
        sec_paras = sec["paras"]
        heading_block = (f"{'#' * heading_lvl} {heading}" + "\n\n") if heading else ""
        sec_text = "\n\n".join(sec_paras) if sec_paras else ""
        sec_content = heading_block + sec_text
        sec_tokens = count_tokens(sec_content)

        if sec_tokens > max_tokens:
            # Section itself too big — flush overlap buffer, split by sentences
            if overlap_buffer:
                _emit(overlap_buffer, overlap_tokens, overlap_heading_level, overlap_heading_text)
                overlap_buffer = []
                overlap_tokens = 0
            sub_chunks = _split_by_sentences(sec_text, file_path, max_tokens, heading_lvl, heading)
            for sc in sub_chunks:
                chunks.append(sc)
                _chunk_index += 1
            continue

        # Each section = one chunk; prepend overlap from previous chunk
        chunk_paras = overlap_buffer + [sec_content]
        chunk_tokens = overlap_tokens + sec_tokens

        if chunk_tokens > max_tokens and overlap_buffer:
            # Overlap too big to fit with this section — emit overlap as its own chunk
            _emit(overlap_buffer, overlap_tokens, overlap_heading_level, overlap_heading_text)
            chunk_paras = [sec_content]
            chunk_tokens = sec_tokens

        # Emit this section as a chunk
        _emit(chunk_paras, chunk_tokens, heading_lvl, heading)

        # Update overlap buffer with last `overlap_paras` paragraphs from this section
        # (so next chunk's start has context)
        if overlap_paras > 0 and len(sec_paras) > 0:
            # Keep last N paragraphs from this section as overlap
            keep_paras = sec_paras[-overlap_paras:]
            keep_content = "\n\n".join(keep_paras)
            keep_tokens = count_tokens(keep_content)
            overlap_buffer = [keep_content]
            overlap_tokens = keep_tokens
            overlap_heading_level = heading_lvl
            overlap_heading_text = heading
        else:
            overlap_buffer = []
            overlap_tokens = 0

    return chunks


def _split_by_sentences(
    text: str,
    file_path: str,
    max_tokens: int,
    heading_level: int,
    heading_text: str,
) -> list[Chunk]:
    """Split a long section into chunks by sentence boundaries."""
    chunks: list[Chunk] = []
    sentences = _SENTENCE_END_RE.split(text)
    current: list[str] = []
    current_tokens = 0
    chunk_index = 0

    for sent in sentences:
        sent = sent.strip()
        if not sent:
            continue
        sent_tokens = count_tokens(sent)

        if current_tokens + sent_tokens >= max_tokens and current:
            chunk_text = "".join(current)
            chunk_id = make_chunk_id(file_path, chunk_index)
            chunks.append(Chunk(
                chunk_id=chunk_id,
                content=chunk_text,
                para_indices=[],
                token_count=current_tokens,
                heading_level=heading_level,
                heading_text=heading_text,
            ))
            chunk_index += 1
            current = []
            current_tokens = 0

        current.append(sent)
        current_tokens += sent_tokens

    if current:
        chunk_text = "".join(current)
        chunk_id = make_chunk_id(file_path, chunk_index)
        chunks.append(Chunk(
            chunk_id=chunk_id,
            content=chunk_text,
            para_indices=[],
            token_count=current_tokens,
            heading_level=heading_level,
            heading_text=heading_text,
        ))

    return chunks


# ─── Simple index-style paragraph grouping ──────────────────────────────────

def chunk_paragraphs_simple(
    paragraphs: list[str],
    file_path: str,
    chunk_size_paras: int = 1,
    overlap_paras: int = 0,
) -> list[Chunk]:
    """Simple paragraph-count-based chunking (alternative to token-based).

    Each chunk contains exactly chunk_size_paras paragraphs (or fewer for the last).
    overlap_paras paragraphs from the end of the previous chunk are prepended.
    """
    import sys
    chunks: list[Chunk] = []
    if not paragraphs:
        return []

    # Guard: overlap must be less than chunk size to avoid no-progress loop
    if overlap_paras >= chunk_size_paras:
        print(f"[pm chunker] WARNING: overlap_paras ({overlap_paras}) >= chunk_size_paras "
              f"({chunk_size_paras}); setting overlap to 0", file=sys.stderr)
        effective_overlap = 0
    else:
        effective_overlap = overlap_paras
    step = max(1, chunk_size_paras - effective_overlap)

    start = 0
    chunk_index = 0
    while start < len(paragraphs):
        end = min(start + chunk_size_paras, len(paragraphs))
        chunk_paras = paragraphs[start:end]
        chunk_text = "\n\n".join(chunk_paras)
        chunk_id = make_chunk_id(file_path, chunk_index)
        chunks.append(Chunk(
            chunk_id=chunk_id,
            content=chunk_text,
            para_indices=list(range(start, end)),
            token_count=count_tokens(chunk_text),
        ))
        chunk_index += 1
        start += step
        if start >= len(paragraphs):
            break

    return chunks

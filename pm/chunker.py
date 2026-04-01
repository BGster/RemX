"""Chunking logic for Project-Manager v2.

Splits a markdown file into paragraphs, then groups paragraphs into chunks
respecting max_tokens (soft limit) with paragraph-level overlap.

chunk_id format: {file_path}::{chunk_index}
"""
import re
import tiktoken
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from .storage import parse_front_matter


@dataclass
class Chunk:
    chunk_id: str
    content: str
    para_indices: list[int] = field(default_factory=list)  # which paragraphs this chunk covers
    token_count: int = 0


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
                chunk_id = f"{file_path}::{chunk_index}"
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
                    sub_chunk_id = f"{file_path}::{chunk_index}"
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
            chunk_id = f"{file_path}::{chunk_index}"
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
        chunk_id = f"{file_path}::{chunk_index}"
        chunks.append(Chunk(
            chunk_id=chunk_id,
            content=chunk_text,
            para_indices=list(range(start_para_idx, len(paragraphs))),
            token_count=current_token_count,
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
        chunk_id = f"{file_path}::{chunk_index}"
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

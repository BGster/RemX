"""RemX v2 CLI — Engine Layer (Phase 1).

Implements 6 commands:
  remx parse < meta.yaml
  remx init [--reset] [--db <path>] [--meta <path>]
  remx index <path> [--db <path>] [--meta <path>] [--dedup-threshold <float>]
  remx gc [--scope <path>] [--dry-run] [--purge] [--db <path>]
  remx retrieve [--filter <json>] [--query <text>] [--db <path>] [--limit <n>]
  remx stats [--db <path>] [--meta <path>]

Usage as library:
  from remx.commands.parse import run_parse
  from remx.commands.init import run_init
  from remx.commands.index import run_index
  from remx.commands.gc import run_gc
  from remx.commands.retrieve import run_retrieve
  from remx.commands.stats import run_stats
"""
import contextvars
import json
import sys
from pathlib import Path
from typing import Any, Optional

import typer

from . import __version__
from .core.embedding import create_embedder
from .core.schema import MetaYaml
from .commands.gc import run_gc as gc_run
from .commands.index import run_index as index_run, IndexConfig
from .commands.init import run_init as init_run
from .commands.parse import run_parse as parse_run
from .commands.relate import run_relate as relate_run
from .commands.retrieve import run_retrieve as retrieve_run
from .commands.stats import run_stats as stats_run

app = typer.Typer(name="remx", no_args_is_help=True, invoke_without_command=False)
console = typer.echo

# Cached stdin content (set by __main__.py before typer runs) — use contextvar for thread safety
_stdin_cache_var: contextvars.ContextVar[Optional[str]] = contextvars.ContextVar(
    "_stdin_cache_var", default=None
)


def _set_stdin_cache(content: str) -> None:
    """Set the stdin cache (called by __main__.py before typer runs)."""
    _stdin_cache_var.set(content)


def _get_stdin_content() -> str:
    """Get cached stdin content or fall back to reading directly."""
    content = _stdin_cache_var.get()
    if content is not None:
        # Clear cache after use to prevent re-use in subsequent commands
        _stdin_cache_var.set(None)
        return content
    if not sys.stdin.isatty():
        return sys.stdin.read()
    return ""


# ─── Entry Points ─────────────────────────────────────────────────────────────

@app.command("parse")
def parse_cmd(
    meta: Optional[Path] = typer.Argument(None, help="Path to meta.yaml (use '-' or --stdin to read from stdin)"),
    stdin: bool = typer.Option(False, "--stdin", help="Read meta.yaml content from stdin"),
):
    """Validate meta.yaml and output structured JSON."""
    if stdin or meta is None or str(meta) == "-":
        # Read from cached stdin
        try:
            text = _get_stdin_content()
            import tempfile, yaml
            with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as tf:
                tf.write(text)
                tmp_path = Path(tf.name)
            try:
                rc = parse_run(tmp_path)
            finally:
                tmp_path.unlink(missing_ok=True)
            raise typer.Exit(code=rc)
        except typer.Exit:
            raise
        except Exception as e:
            print(f"remx parse: stdin error — {e}", file=sys.stderr)
            raise typer.Exit(code=1)
    else:
        rc = parse_run(meta)
        raise typer.Exit(code=rc)


@app.command("init")
def init_cmd(
    reset: bool = typer.Option(False, "--reset", help="Drop and recreate all tables"),
    db: Path = typer.Option(Path("memory.db"), "--db", help="Database path"),
    meta: Path = typer.Option(Path("meta.yaml"), "--meta", help="meta.yaml path"),
):
    """Create or rebuild all tables and vector indexes from meta.yaml."""
    rc = init_run(meta, db, reset=reset)
    raise typer.Exit(code=rc)


@app.command("index")
def index_cmd(
    path: Path = typer.Argument(..., help="File to index"),
    db: Path = typer.Option(Path("memory.db"), "--db", help="Database path"),
    meta: Path = typer.Option(Path("meta.yaml"), "--meta", help="meta.yaml path"),
    chunk_size: int = typer.Option(0, "--chunk-size", help="Paragraphs per chunk (0=auto from meta.yaml)"),
    overlap: int = typer.Option(-1, "--overlap", help="Paragraph overlap (default from meta.yaml)"),
    max_tokens: int = typer.Option(512, "--max-tokens", help="Max tokens per chunk"),
    no_embed: bool = typer.Option(False, "--no-embed", help="Skip embedding generation"),
    dedup_threshold: Optional[float] = typer.Option(
        None, "--dedup-threshold", help="Enable semantic dedup for knowledge/principle (cosine similarity, e.g. 0.95)",
    ),
):
    """Index a single file into memories + chunks + memories_vec."""
    try:
        meta_cfg = MetaYaml.load(meta)
    except Exception as e:
        print(f"remx index: {meta}: parse error — {e}", file=sys.stderr)
        raise typer.Exit(code=1)

    embedder = None
    if not no_embed:
        emb_cfg = meta_cfg.embedder
        embedder = create_embedder(
            provider=emb_cfg.provider if emb_cfg else "ollama",
            model=emb_cfg.model if emb_cfg else "bge-m3",
            dimension=meta_cfg.vector.dimensions,
            base_url=emb_cfg.base_url if emb_cfg else "http://localhost:11434",
            timeout=emb_cfg.timeout if emb_cfg else 60,
            api_key=emb_cfg.api_key if emb_cfg else None,
        )

    cs = chunk_size if chunk_size > 0 else 1
    ov = overlap if overlap >= 0 else meta_cfg.chunk.overlap

    config = IndexConfig(chunk_size_paras=cs, overlap_paras=ov, max_tokens=max_tokens)

    try:
        index_run(
            file_path=path,
            meta_yaml_path=meta,
            db_path=db,
            config=config,
            embedder=embedder,
            dedup_threshold=dedup_threshold,
        )
    except Exception:
        raise typer.Exit(code=1)
    raise typer.Exit(code=0)


@app.command("gc")
def gc_cmd(
    scope: Optional[Path] = typer.Option(None, "--scope", help="Limit to files under this path"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Preview without modifying"),
    purge: bool = typer.Option(False, "--purge", help="Physically delete deprecated records"),
    db: Path = typer.Option(Path("memory.db"), "--db", help="Database path"),
):
    """Decay recall cleanup — soft-delete expired records (--purge for physical delete)."""
    rc = gc_run(db, scope_path=scope, dry_run=dry_run, purge=purge)
    raise typer.Exit(code=rc)


@app.command("retrieve")
def retrieve_cmd(
    filter: Optional[str] = typer.Option(None, "--filter", help="JSON filter object"),
    db: Path = typer.Option(Path("memory.db"), "--db", help="Database path"),
    meta: Path = typer.Option(Path("meta.yaml"), "--meta", help="meta.yaml path"),
    no_content: bool = typer.Option(False, "--no-content", help="Skip chunk content in output"),
    limit: int = typer.Option(50, "--limit", help="Max results"),
    query: Optional[str] = typer.Option(None, "--query", help="Natural language query for semantic search"),
    decay_weight: float = typer.Option(0.5, "--decay-weight", help="Decay weight in semantic score (0=no decay, 1=no vector)"),
    no_embed: bool = typer.Option(False, "--no-embed", help="Skip embedding (use with --filter only)"),
):
    """Retrieve memories by filter and/or semantic query, return JSON array.

    Semantic search: --query <text> [--decay-weight 0.0-1.0]
    Filter only: --filter '{"category": "demand"}'
    Combined: both filter and query
    """
    if not filter and not query:
        print("remx retrieve: must provide --filter or --query (or both)", file=sys.stderr)
        raise typer.Exit(code=1)

    filter_dict = None
    if filter:
        try:
            filter_dict = json.loads(filter)
        except json.JSONDecodeError as e:
            print(f"remx retrieve: invalid --filter JSON — {e}", file=sys.stderr)
            raise typer.Exit(code=1)

    embedder = None
    if query and not no_embed:
        try:
            meta_cfg = MetaYaml.load(meta)
        except Exception as e:
            print(f"remx retrieve: {meta}: parse error — {e}", file=sys.stderr)
            raise typer.Exit(code=1)
        emb_cfg = meta_cfg.embedder
        embedder = create_embedder(
            provider=emb_cfg.provider if emb_cfg else "ollama",
            model=emb_cfg.model if emb_cfg else "bge-m3",
            dimension=meta_cfg.vector.dimensions,
            base_url=emb_cfg.base_url if emb_cfg else "http://localhost:11434",
            timeout=emb_cfg.timeout if emb_cfg else 60,
            api_key=emb_cfg.api_key if emb_cfg else None,
        )

    rc = retrieve_run(
        db,
        filter=filter_dict,
        include_content=not no_content,
        limit=limit,
        query=query,
        meta_yaml_path=meta if query else None,
        embedder=embedder,
        decay_weight=decay_weight,
    )
    raise typer.Exit(code=rc)


@app.command("stats")
def stats_cmd(
    db: Path = typer.Option(Path("memory.db"), "--db", help="Database path"),
    meta: Path = typer.Option(Path("meta.yaml"), "--meta", help="meta.yaml path"),
):
    """Show database statistics and health info."""
    rc = stats_run(db, meta)
    raise typer.Exit(code=rc)


@app.command("version")
def version_cmd():
    """Print version."""
    print(f"remx v{__version__}")


@app.command("relate")
def relate_cmd(
    action: str = typer.Argument(..., help="Action: insert, delete, query, nodes, graph, expand"),
    db: Path = typer.Option(Path("memory.db"), "--db", help="Database path"),
    node_id: Optional[str] = typer.Option(None, "--node-id", help="Node ID(s), comma-separated for insert"),
    rel_type: Optional[str] = typer.Option(None, "--rel-type", help="Relation type"),
    context: Optional[str] = typer.Option(None, "--context", help="Context tag (e.g. group_chat, main_session)"),
    description: Optional[str] = typer.Option(None, "--description", help="Human-readable description"),
    roles: Optional[str] = typer.Option(None, "--roles", help="Comma-separated roles (cause,effect,component,whole,related,opponent)"),
    current_context: Optional[str] = typer.Option(None, "--current-context", help="Current session context for filtering"),
    max_depth: int = typer.Option(2, "--max-depth", help="Max BFS depth for graph/expand"),
    max_additional: int = typer.Option(10, "--max-additional", help="Max additional entries from topology"),
    limit: int = typer.Option(50, "--limit", help="Max nodes to list"),
):
    """Manage topology relations between memory entries.

    Actions:
      insert   Insert a relation: --node-id id1,id2 --rel-type 因果关系 [--roles cause,effect] [--context group_chat]
      delete   Delete a relation: --node-id <relation_id>
      query    Query relations for a node: --node-id <entry_id> [--current-context <ctx>]
      nodes    List all nodes: [--limit <n>]
      graph    BFS traversal: --node-id <entry_id> [--max-depth <n>] [--current-context <ctx>]
      expand   Expand semantic results via topology (reads base results from stdin JSON)
    """
    rc = relate_run(
        db_path=db,
        action=action,
        node_id=node_id,
        rel_type=rel_type,
        context=context,
        description=description,
        roles=roles,
        current_context=current_context,
        max_depth=max_depth,
        max_additional=max_additional,
        limit=limit,
    )
    raise typer.Exit(code=rc)

"""RemX v2 CLI — Engine Layer (Phase 1).

Implements 5 commands:
  remx parse < meta.yaml
  remx init [--reset] [--db <path>] [--meta <path>]
  remx index <path> [--db <path>] [--meta <path>]
  remx gc [--scope <path>] [--dry-run] [--purge] [--db <path>]
  remx retrieve --filter <json> [--db <path>] [--no-content] [--limit <n>]

Usage as library:
  from pm.parse import run_parse
  from pm.init_ import run_init
  from pm.index_ import run_index
  from pm.gc_ import run_gc
  from pm.retrieve_ import run_retrieve
"""
import json
import sys
from pathlib import Path
from typing import Any, Optional

import typer

from . import __version__
from .embedding import create_embedder
from .gc_ import run_gc as gc_run
from .index_ import run_index as index_run
from .init_ import run_init as init_run
from .parse import run_parse as parse_run
from .retrieve_ import run_retrieve as retrieve_run
from .schema import MetaYaml

app = typer.Typer(name="remx", no_args_is_help=True, invoke_without_command=False)
console = typer.echo


def _db_path(ctx: typer.Context) -> Path:
    return ctx.params.get("db", Path("memory.db"))


def _meta_path(ctx: typer.Context) -> Path:
    return ctx.params.get("meta", Path("meta.yaml"))


# ─── Entry Points ─────────────────────────────────────────────────────────────

@app.command("parse")
def parse_cmd(
    meta: Optional[Path] = typer.Argument(None, help="Path to meta.yaml (use '-' or --stdin to read from stdin)"),
    stdin: bool = typer.Option(False, "--stdin", help="Read meta.yaml content from stdin"),
):
    """Validate meta.yaml and output structured JSON."""
    if stdin or meta is None or str(meta) == "-":
        # Read from stdin
        try:
            text = sys.stdin.read()
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

    rc = index_run(
        file_path=path,
        meta_yaml_path=meta,
        db_path=db,
        embedder=embedder,
        chunk_size_paras=cs,
        overlap_paras=ov,
        max_tokens=max_tokens,
    )
    raise typer.Exit(code=rc)


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
    filter: str = typer.Option(..., "--filter", help="JSON filter object"),
    db: Path = typer.Option(Path("memory.db"), "--db", help="Database path"),
    no_content: bool = typer.Option(False, "--no-content", help="Skip chunk content in output"),
    limit: int = typer.Option(50, "--limit", help="Max results"),
):
    """Retrieve memories by filter, return JSON array."""
    try:
        filter_dict = json.loads(filter)
    except json.JSONDecodeError as e:
        print(f"remx retrieve: invalid --filter JSON — {e}", file=sys.stderr)
        raise typer.Exit(code=1)

    rc = retrieve_run(db, filter_dict, include_content=not no_content, limit=limit)
    raise typer.Exit(code=rc)


@app.command("version")
def version_cmd():
    """Print version."""
    print(f"remx v{__version__}")

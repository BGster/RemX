"""Shared add logic for memory entries."""
import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

from rich.console import Console

from ..config import Config
from ..db import add_memory, gc_expired as db_gc_expired
from ..embedding import create_embedder, get_embedding
from ..gc import gc_expired_files
from ..idgen import get_next_id
from ..storage import append_to_daily_log, write_memory_file

console = Console()


def _get_project_root(config_path: Path) -> Path:
    """Get project root from config."""
    config = Config.load(config_path)
    return config_path.parent.resolve()


def _run_gc(root: Path, user_id: str) -> None:
    """Run lazy GC on tmp directory."""
    tmp_dir = root / user_id / "tmp"
    db_path = root / "memory.db"

    # Try DB-based GC first
    try:
        removed = db_gc_expired(db_path, tmp_dir)
        if removed:
            console.print(f"[dim]🗑 Cleaned {len(removed)} expired tmp files[/dim]")
    except Exception:
        pass

    # Always run file-based GC as backup
    try:
        removed = gc_expired_files(tmp_dir)
        if removed:
            console.print(f"[dim]🗑 Removed {len(removed)} expired tmp files[/dim]")
    except Exception:
        pass


def add_log(
    config_path: Path,
    content: str,
    date: Optional[str] = None,
) -> None:
    """Add a daily log entry."""
    root = _get_project_root(config_path)
    config = Config.load(config_path)
    user_id = config.user.id

    if not user_id:
        console.print("[red]Error: No user configured. Run 'pm init --user <name>' first.[/red]")
        return

    _run_gc(root, user_id)

    if date is None:
        date = datetime.now().strftime("%Y-%m-%d")

    file_path = root / user_id / "daily" / f"{date}.md"
    time_str = datetime.now().strftime("%H:%M")
    append_to_daily_log(file_path, time_str, content)

    # Record in DB
    try:
        from ..db import add_memory
        title = f"Daily log - {date}"
        add_memory(
            db_path=root / "memory.db",
            id=get_next_id(root / "memory.db", "daily"),
            category="daily",
            user_id=user_id,
            title=title,
            content=f"[{time_str}] {content}",
            file_path=str(file_path.relative_to(root)),
        )
    except Exception as e:
        console.print(f"[dim]Warning: DB write failed: {e}[/dim]")

    console.print(f"[bold]📝 Log added[/bold]")
    console.print(f"  Date: {date}")
    console.print(f"  File: {file_path.relative_to(root)}")
    console.print(f"  Content: {content[:60]}{'...' if len(content) > 60 else ''}")


def add_demand(
    config_path: Path,
    content: str,
    priority: str = "P2",
    status: str = "open",
    title: Optional[str] = None,
    extension_str: str = "{}",
) -> None:
    """Add a demand/task."""
    root = _get_project_root(config_path)
    config = Config.load(config_path)
    user_id = config.user.id

    if not user_id:
        console.print("[red]Error: No user configured.[/red]")
        return

    _run_gc(root, user_id)

    db_path = root / "memory.db"
    mem_id = get_next_id(db_path, "demand")
    slug = _slugify(content[:40])
    file_path = root / user_id / "demands" / f"{mem_id}-{slug}.md"

    if title is None:
        title = content[:40]

    try:
        extension = json.loads(extension_str)
    except Exception:
        extension = {}

    # Write file
    write_memory_file(
        file_path=file_path,
        title=title,
        content=content,
        category="demand",
        id=mem_id,
        priority=priority,
        status=status,
        user_id=user_id,
        extension=extension,
    )

    # Get embedding
    embedder = create_embedder(
        provider=config.embedder.provider,
        model=config.embedder.model,
        dimension=config.embedder.dimension,
        ollama_base_url=config.embedder.ollama_base_url,
        ollama_timeout=config.embedder.ollama_timeout,
        openai_api_key=config.embedder.openai_api_key,
        openai_model=config.embedder.openai_model,
    )
    embedding = get_embedding(embedder, content, config.embedder.dimension)

    # Write DB
    try:
        add_memory(
            db_path=db_path,
            id=mem_id,
            category="demand",
            user_id=user_id,
            title=title,
            content=content,
            file_path=str(file_path.relative_to(root)),
            priority=priority,
            status=status,
            extension=extension,
            embedding=embedding,
        )
    except Exception as e:
        console.print(f"[dim]Warning: DB write failed: {e}[/dim]")

    console.print(f"[bold]✓ Demand created[/bold]")
    console.print(f"  ID: {mem_id}")
    console.print(f"  Priority: {priority}")
    console.print(f"  Status: {status}")
    console.print(f"  File: {file_path.relative_to(root)}")


def add_issue(
    config_path: Path,
    content: str,
    priority: str = "P2",
    status: str = "open",
    type: str = "bug",
    extension_str: str = "{}",
) -> None:
    """Add an issue/risk."""
    root = _get_project_root(config_path)
    config = Config.load(config_path)
    user_id = config.user.id

    _run_gc(root, user_id or "share")

    db_path = root / "memory.db"
    mem_id = get_next_id(db_path, "issue")
    slug = _slugify(content[:40])
    file_path = root / "share" / "issues" / f"{mem_id}-{slug}.md"

    try:
        extension = json.loads(extension_str)
    except Exception:
        extension = {}

    write_memory_file(
        file_path=file_path,
        title=content[:60],
        content=content,
        category="issue",
        id=mem_id,
        priority=priority,
        status=status,
        user_id=None,
        type=type,
        extension=extension,
    )

    embedder = create_embedder(
        provider=config.embedder.provider,
        model=config.embedder.model,
        dimension=config.embedder.dimension,
        ollama_base_url=config.embedder.ollama_base_url,
        ollama_timeout=config.embedder.ollama_timeout,
        openai_api_key=config.embedder.openai_api_key,
        openai_model=config.embedder.openai_model,
    )
    embedding = get_embedding(embedder, content, config.embedder.dimension)

    try:
        add_memory(
            db_path=db_path,
            id=mem_id,
            category="issue",
            user_id=None,
            title=content[:60],
            content=content,
            file_path=str(file_path.relative_to(root)),
            priority=priority,
            status=status,
            type=type,
            extension=extension,
            embedding=embedding,
        )
    except Exception as e:
        console.print(f"[dim]Warning: DB write failed: {e}[/dim]")

    console.print(f"[bold]✓ Issue created[/bold]")
    console.print(f"  ID: {mem_id}")
    console.print(f"  Type: {type}")
    console.print(f"  Priority: {priority}")
    console.print(f"  Status: {status}")
    console.print(f"  File: {file_path.relative_to(root)}")


def add_principle(
    config_path: Path,
    content: str,
    type: str = "principle",
    status: str = "active",
    extension_str: str = "{}",
) -> None:
    """Add a development principle or ADR."""
    root = _get_project_root(config_path)
    config = Config.load(config_path)
    user_id = config.user.id

    if not user_id:
        console.print("[red]Error: No user configured.[/red]")
        return

    _run_gc(root, user_id)

    db_path = root / "memory.db"
    category = "principle" if type == "principle" else "adr"
    mem_id = get_next_id(db_path, category)
    slug = _slugify(content[:40])
    file_path = root / user_id / "principles" / f"{mem_id}-{slug}.md"

    try:
        extension = json.loads(extension_str)
    except Exception:
        extension = {}

    write_memory_file(
        file_path=file_path,
        title=content[:60],
        content=content,
        category=category,
        id=mem_id if type == "adr" else None,
        status=status,
        user_id=user_id,
        type=type,
        extension=extension,
    )

    embedder = create_embedder(
        provider=config.embedder.provider,
        model=config.embedder.model,
        dimension=config.embedder.dimension,
        ollama_base_url=config.embedder.ollama_base_url,
        ollama_timeout=config.embedder.ollama_timeout,
        openai_api_key=config.embedder.openai_api_key,
        openai_model=config.embedder.openai_model,
    )
    embedding = get_embedding(embedder, content, config.embedder.dimension)

    try:
        add_memory(
            db_path=db_path,
            id=mem_id if type == "adr" else f"PRN-{mem_id.split('-')[-1]}",
            category=category,
            user_id=user_id,
            title=content[:60],
            content=content,
            file_path=str(file_path.relative_to(root)),
            status=status,
            type=type,
            extension=extension,
            embedding=embedding,
        )
    except Exception as e:
        console.print(f"[dim]Warning: DB write failed: {e}[/dim]")

    console.print(f"[bold]✓ Principle recorded[/bold]")
    console.print(f"  Type: {type}")
    console.print(f"  File: {file_path.relative_to(root)}")


def add_knowledge(
    config_path: Path,
    content: str,
    title: Optional[str] = None,
    tags_str: str = "",
    type: str = "note",
    extension_str: str = "{}",
) -> None:
    """Add a knowledge entry."""
    root = _get_project_root(config_path)
    config = Config.load(config_path)
    user_id = config.user.id

    _run_gc(root, user_id or "share")

    db_path = root / "memory.db"
    mem_id = get_next_id(db_path, "knowledge")
    title = title or content[:50]
    slug = _slugify(title[:40])
    file_path = root / "share" / "knowledge" / f"{mem_id}-{slug}.md"

    tags = [t.strip() for t in tags_str.split(",") if t.strip()]

    try:
        extension = json.loads(extension_str)
    except Exception:
        extension = {}

    write_memory_file(
        file_path=file_path,
        title=title,
        content=content,
        category="knowledge",
        id=mem_id,
        user_id=None,
        type=type,
        tags=tags,
        extension=extension,
    )

    embedder = create_embedder(
        provider=config.embedder.provider,
        model=config.embedder.model,
        dimension=config.embedder.dimension,
        ollama_base_url=config.embedder.ollama_base_url,
        ollama_timeout=config.embedder.ollama_timeout,
        openai_api_key=config.embedder.openai_api_key,
        openai_model=config.embedder.openai_model,
    )
    embedding = get_embedding(embedder, content, config.embedder.dimension)

    try:
        add_memory(
            db_path=db_path,
            id=mem_id,
            category="knowledge",
            user_id=None,
            title=title,
            content=content,
            file_path=str(file_path.relative_to(root)),
            type=type,
            tags=tags,
            extension=extension,
            embedding=embedding,
        )
    except Exception as e:
        console.print(f"[dim]Warning: DB write failed: {e}[/dim]")

    console.print(f"[bold]✓ Knowledge added[/bold]")
    console.print(f"  ID: {mem_id}")
    console.print(f"  Type: {type}")
    console.print(f"  Tags: {tags}")
    console.print(f"  File: {file_path.relative_to(root)}")


def add_tmp(
    config_path: Path,
    content: str,
    ttl: int = 24,
) -> None:
    """Add a temporary note (not stored in DB, expires after TTL)."""
    root = _get_project_root(config_path)
    config = Config.load(config_path)
    user_id = config.user.id

    if not user_id:
        console.print("[red]Error: No user configured.[/red]")
        return

    _run_gc(root, user_id)

    mem_id = get_next_id(root / "memory.db", "tmp")
    now = datetime.now(timezone.utc)
    expires_at = now + timedelta(hours=ttl)
    now_str = now.strftime("%Y-%m-%d %H:%M")
    expires_str = expires_at.strftime("%Y-%m-%d %H:%M")
    file_path = root / user_id / "tmp" / f"{mem_id}.md"

    file_content = f"""# Tmp Note - {now_str}

## 内容

{content}

## 元信息

- **创建时间**: {now.isoformat()}
- **过期时间**: {expires_at.isoformat()}
- **TTL**: {ttl}h
- **ID**: {mem_id}
"""
    file_path.parent.mkdir(parents=True, exist_ok=True)
    file_path.write_text(file_content, encoding="utf-8")

    console.print(f"[bold]✓ Tmp note created[/bold]")
    console.print(f"  ID: {mem_id}")
    console.print(f"  Expires: {expires_str} ({ttl}h)")
    console.print(f"  File: {file_path.relative_to(root)}")


def _slugify(text: str) -> str:
    """Convert text to a URL-safe slug."""
    import re
    text = text.lower()
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[-\s]+", "-", text)
    return text[:40].strip("-")

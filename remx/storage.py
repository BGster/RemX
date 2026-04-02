"""File storage with YAML front-matter for RemX."""
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

import yaml


def read_front_matter(file_path: Path) -> tuple[dict, str]:
    """Read a markdown file and split front-matter from content."""
    if not file_path.exists():
        return {}, ""
    text = file_path.read_text(encoding="utf-8")
    return parse_front_matter(text)


def parse_front_matter(text: str) -> tuple[dict, str]:
    """Parse YAML front-matter from markdown text."""
    if not text.startswith("---"):
        return {}, text
    parts = text.split("---", 2)
    if len(parts) < 3:
        return {}, text
    fm = yaml.safe_load(parts[1]) or {}
    return fm, parts[2].lstrip("\n")


def write_memory_file(
    file_path: Path,
    title: str,
    content: str,
    front_matter: Optional[dict] = None,
    category: Optional[str] = None,
    id: Optional[str] = None,
    priority: Optional[str] = None,
    status: str = "open",
    tags: Optional[list] = None,
    extension: Optional[dict] = None,
    user_id: Optional[str] = None,
    created_at: Optional[str] = None,
    updated_at: Optional[str] = None,
    expires_at: Optional[str] = None,
    type: Optional[str] = None,
) -> None:
    """Write a memory file with YAML front-matter."""
    file_path.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()

    fm = front_matter or {}
    fm.setdefault("title", title)
    if id:
        fm["id"] = id
    if category:
        fm["category"] = category
    if priority:
        fm["priority"] = priority
    fm["status"] = status
    if tags:
        fm["tags"] = tags
    if extension:
        fm["extension"] = extension
    if user_id:
        fm["user_id"] = user_id
    fm["created_at"] = fm.get("created_at") or created_at or now
    fm["updated_at"] = now
    if expires_at:
        fm["expires_at"] = expires_at
    if type:
        fm["type"] = type

    # Build markdown
    lines = ["---"]
    lines.append(yaml.safe_dump(fm, allow_unicode=True, sort_keys=False).rstrip())
    lines.append("---")
    lines.append("")
    lines.append(f"# {title}")
    lines.append("")
    lines.append(content)
    file_path.write_text("\n".join(lines), encoding="utf-8")


def append_to_daily_log(
    file_path: Path,
    time_str: str,
    content: str,
) -> None:
    """Append a log entry to a daily log file."""
    file_path.parent.mkdir(parents=True, exist_ok=True)
    now = datetime.now(timezone.utc)

    if file_path.exists():
        fm, existing_content = read_front_matter(file_path)
    else:
        fm = {
            "date": file_path.stem,
            "created_at": now.isoformat(),
        }
        existing_content = ""

    entry = f"## {time_str}\n- {content}\n"

    if existing_content.strip():
        new_content = existing_content.rstrip() + "\n" + entry
    else:
        new_content = f"# 开发日志 - {file_path.stem}\n\n{entry}"

    lines = ["---", yaml.safe_dump(fm, allow_unicode=True, sort_keys=False).rstrip(), "---"]
    lines.append("")
    lines.append(new_content)
    file_path.write_text("\n".join(lines), encoding="utf-8")

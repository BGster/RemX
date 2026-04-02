"""ID generation for RemX memory entries."""
import random
import string
from pathlib import Path
from typing import Optional

from .db import get_db


# Category → ID prefix mapping
CATEGORY_PREFIXES = {
    "issue": "ISC",
    "demand": "DMD",
    "knowledge": "KNW",
    "project": "PRJ",
    "milestone": "MS",
    "principle": "PRN",
    "adr": "ADR",
    "meeting": "MTG",
    "tmp": "TMP",
}


def get_next_id(db_path: Path, category: str) -> str:
    """Generate the next ID for a given category."""
    prefix = CATEGORY_PREFIXES.get(category, category.upper()[:3])

    if category == "tmp":
        return f"TMP-{_generate_short_id()}"

    if category == "daily":
        from datetime import datetime
        return datetime.now().strftime("%Y-%m-%d")

    conn = get_db(db_path)
    try:
        row = conn.execute(
            "SELECT id FROM memories WHERE category=? AND id LIKE ? ORDER BY id DESC LIMIT 1",
            (category, f"{prefix}-%")
        ).fetchone()
        if row:
            num = _extract_num(row["id"])
            next_num = num + 1
        else:
            next_num = 1
    finally:
        conn.close()

    return f"{prefix}-{next_num:03d}"


def _extract_num(id_str: str) -> int:
    """Extract numeric part from ID like ISC-001."""
    try:
        return int(id_str.rsplit("-", 1)[-1])
    except (ValueError, IndexError):
        return 0


def _generate_short_id(length: int = 8) -> str:
    """Generate a random short alphanumeric ID."""
    chars = string.ascii_lowercase + string.digits
    return "".join(random.choice(chars) for _ in range(length))

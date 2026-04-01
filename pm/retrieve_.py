"""pm retrieve command — filter-based retrieval, returns JSON array."""
import json
import sys
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from .db import retrieve


def run_retrieve(
    db_path: Path,
    filter: dict[str, Any],
    include_content: bool = True,
    limit: int = 50,
) -> int:
    """Retrieve memories matching filter, output JSON array.

    Args:
        db_path: path to SQLite database
        filter: dict of field → value for SQL WHERE translation
        include_content: join with chunks table
        limit: max results

    Returns:
        0 on success, 1 on error
    """
    if not db_path.exists():
        print(f"pm retrieve: {db_path}: database not found", file=sys.stderr)
        return 1

    # Parse JSON filter if passed as string
    if isinstance(filter, str):
        try:
            filter = json.loads(filter)
        except json.JSONDecodeError as e:
            print(f"pm retrieve: invalid filter JSON — {e}", file=sys.stderr)
            return 1

    if not isinstance(filter, dict):
        print(f"pm retrieve: filter must be a JSON object", file=sys.stderr)
        return 1

    try:
        rows = retrieve(db_path, filter, include_content=include_content, limit=limit)
    except Exception as e:
        print(f"pm retrieve: query error — {e}", file=sys.stderr)
        return 1

    # Serialize datetime/None values for JSON
    def _sanitize(row: dict) -> dict:
        out = {}
        for k, v in row.items():
            if isinstance(v, (datetime,)):
                out[k] = v.isoformat()
            elif v is None:
                out[k] = None
            elif isinstance(v, (int, float, str, bool, list, dict)):
                out[k] = v
            else:
                out[k] = str(v)
        return out

    output = [_sanitize(r) for r in rows]
    print(json.dumps(output, indent=2, ensure_ascii=False))
    return 0

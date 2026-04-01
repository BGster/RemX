"""remx init command — create / rebuild all tables and vector index."""
import sys
from pathlib import Path

from .db import init_db
from .schema import MetaYaml


def run_init(
    meta_yaml_path: Path,
    db_path: Path,
    reset: bool = False,
) -> int:
    """Initialize (or rebuild) database schema from meta.yaml.

    Args:
        meta_yaml_path: path to meta.yaml
        db_path: path to SQLite database
        reset: if True, drop existing tables before creating

    Returns:
        0 on success, 1 on error
    """
    if not meta_yaml_path.exists():
        print(f"remx init: {meta_yaml_path}: file not found", file=sys.stderr)
        return 1

    try:
        meta = MetaYaml.load(meta_yaml_path)
    except Exception as e:
        print(f"remx init: {meta_yaml_path}: parse error — {e}", file=sys.stderr)
        return 1

    dimensions = meta.vector.dimensions

    try:
        init_db(db_path, vector_dimensions=dimensions, reset=reset)
    except Exception as e:
        print(f"remx init: {db_path}: failed to initialize database — {e}", file=sys.stderr)
        return 1

    action = "Rebuilt" if reset else "Created"
    print(f"{action} database at {db_path}")
    print(f"  Tables: memories, chunks")
    print(f"  Vector table: memories_vec (dimensions={dimensions})")
    print(f"  Indexes: created")

    return 0

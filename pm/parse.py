"""pm parse command — validate meta.yaml and output structured JSON."""
import json
import sys
from pathlib import Path

from .schema import MetaYaml


def run_parse(meta_yaml_path: Path) -> int:
    """Parse and validate meta.yaml.

    - On success: print formatted JSON to stdout, return 0
    - On validation error: print error to stderr, return 1
    """
    if not meta_yaml_path.exists():
        print(f"pm parse: {meta_yaml_path}: file not found", file=sys.stderr)
        return 1

    try:
        meta = MetaYaml.load(meta_yaml_path)
    except Exception as e:
        print(f"pm parse: {meta_yaml_path}: parse error — {e}", file=sys.stderr)
        return 1

    # Additional structural checks
    try:
        _validate_meta(meta)
    except ValueError as ve:
        print(f"pm parse: {meta_yaml_path}: validation error — {ve}", file=sys.stderr)
        return 1

    print(meta.to_json())
    return 0


def _validate_meta(meta: MetaYaml) -> None:
    """Additional semantic validation beyond pydantic."""
    if not meta.name:
        raise ValueError("name is required")

    # Ensure decay_groups reference valid dimension names
    decay_dim_names = {d.name for d in (meta.dimensions.decay or [])}
    for dg in meta.decay_groups:
        for key in dg.trigger.keys():
            if key not in decay_dim_names and key not in ("category", "status"):
                raise ValueError(
                    f"decay_group '{dg.name}' references unknown trigger key '{key}'; "
                    f"known decay dimensions: {decay_dim_names}"
                )

    # Each index_scope must have a non-empty path
    for scope in meta.index_scope:
        if not scope.path.strip():
            raise ValueError(f"index_scope entry has empty path")

    # Vector dimensions must be positive
    if meta.vector.dimensions < 1:
        raise ValueError("vector.dimensions must be >= 1")

    # Chunk max_tokens must be positive
    if meta.chunk.max_tokens < 1:
        raise ValueError("chunk.max_tokens must be >= 1")

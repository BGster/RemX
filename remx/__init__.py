"""RemX v2 — data-driven project memory management.

Phase 1: CLI engine layer (parse / init / index / gc / retrieve).
"""
__version__ = "0.2.0"

# Re-export command runners for programmatic use
from .parse import run_parse
from .init_ import run_init
from .index_ import run_index
from .gc_ import run_gc
from .retrieve_ import run_retrieve

# Re-export schema models
from .schema import MetaYaml

__all__ = [
    "run_parse",
    "run_init",
    "run_index",
    "run_gc",
    "run_retrieve",
    "MetaYaml",
]

"""Allow `python -m remx` as entry point."""
import sys

# Cache stdin BEFORE typer processes anything
# This prevents stdin from being consumed by shell commands like `source`
_STDIN_CACHE: Optional[str] = None
if not sys.stdin.isatty():
    _STDIN_CACHE = sys.stdin.read()

from .cli import app

# Make cached stdin available to CLI module
import remx.cli as cli_module
cli_module._STDIN_CACHE = _STDIN_CACHE

app()

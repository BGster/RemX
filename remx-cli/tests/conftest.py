"""Pytest fixtures for RemX tests."""
import tempfile
from pathlib import Path

import pytest

from remx.core.db import get_db


@pytest.fixture
def temp_db():
    """Create a temporary database for testing."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = Path(f.name)
    yield db_path
    db_path.unlink(missing_ok=True)


@pytest.fixture
def db_with_schema(temp_db):
    """Create a temporary database with schema initialized."""
    from remx.commands.init import run_init

    # Create minimal meta.yaml for init
    with tempfile.NamedTemporaryFile(suffix=".yaml", mode="w", delete=False) as f:
        f.write("""
name: test
version: "1"
index_scope:
  - path: "."
    pattern: "*.md"
decay_groups: []
vector:
  dimensions: 768
chunk:
  strategy: heading
  max_tokens: 512
  overlap: 1
  heading_levels: [1, 2, 3]
""")
        meta_path = Path(f.name)

    run_init(meta_yaml_path=meta_path, db_path=temp_db)
    meta_path.unlink(missing_ok=True)

    yield temp_db

    temp_db.unlink(missing_ok=True)


@pytest.fixture
def sample_memory_file(tmp_path):
    """Create a sample memory markdown file."""
    content = """---
category: demand
priority: P1
---
# Test Memory

## Section 1
Content here.

## Section 2
More content.
"""
    file_path = tmp_path / "test-memory.md"
    file_path.write_text(content)
    return file_path

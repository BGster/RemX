"""Schema models for meta.yaml (RemX v2)."""
from pathlib import Path
from typing import Any, Optional

import yaml
from pydantic import BaseModel, Field, field_validator


# ─── Embedder Config ──────────────────────────────────────────────────────────

class EmbedderConfig(BaseModel):
    provider: str = "ollama"          # "ollama" | "openai"
    model: str = "bge-m3"
    ollama_base_url: str = "http://localhost:11434"
    openai_api_key: Optional[str] = None
    openai_model: str = "text-embedding-3-small"


# ─── Normal Dimensions ────────────────────────────────────────────────────────

class NormalDimension(BaseModel):
    name: str
    values: list[str] = Field(default_factory=list)

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("dimension name cannot be empty")
        return v


# ─── Decay Dimensions ─────────────────────────────────────────────────────────

class DecayDimension(BaseModel):
    name: str
    values: list[str] = Field(default_factory=list)


class NormalDimensions(BaseModel):
    normal: list[NormalDimension] = Field(default_factory=list)
    decay: list[DecayDimension] = Field(default_factory=list)


# ─── Decay Groups ─────────────────────────────────────────────────────────────

class DecayGroup(BaseModel):
    name: str
    trigger: dict[str, str] = Field(default_factory=dict)  # e.g. {"category": "tmp"}
    function: str = Field(default="ttl")  # "ttl" or "stale_after"
    params: dict[str, Any] = Field(default_factory=dict)   # e.g. {"ttl_hours": 24}
    apply_fields: list[str] = Field(default_factory=list)  # e.g. ["created_at", "expires_at"]


# ─── Index Scope ──────────────────────────────────────────────────────────────

class IndexScope(BaseModel):
    path: str = ""
    pattern: str = "*.md"

    @field_validator("path")
    @classmethod
    def path_not_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("index_scope path cannot be empty")
        return v


# ─── Vector Config ────────────────────────────────────────────────────────────

class VectorConfig(BaseModel):
    dimensions: int = Field(default=1024, ge=1)
    table: str = Field(default="memories_vec")
    key_column: str = Field(default="chunk_id")
    embedding_column: str = Field(default="embedding")


# ─── Chunk Config ────────────────────────────────────────────────────────────

class ChunkConfig(BaseModel):
    max_tokens: int = Field(default=512, ge=1)
    overlap: int = Field(default=0, ge=0)  # paragraph count
    strategy: str = Field(default="heading")  # "heading" | "paragraph"
    heading_levels: list[int] = Field(default_factory=lambda: [1, 2, 3])
    preserve: list[str] = Field(default_factory=lambda: ["code_blocks", "tables"])


# ─── Root meta.yaml Model ────────────────────────────────────────────────────

class MetaYaml(BaseModel):
    name: str = "project"
    version: str = Field(default="1")
    index_scope: list[IndexScope] = Field(default_factory=list)
    dimensions: NormalDimensions = Field(default_factory=NormalDimensions)
    decay_groups: list[DecayGroup] = Field(default_factory=list)
    vector: VectorConfig = Field(default_factory=VectorConfig)
    chunk: ChunkConfig = Field(default_factory=ChunkConfig)
    embedder: Optional[EmbedderConfig] = None

    # ─── Parsing ──────────────────────────────────────────────────────────────

    @classmethod
    def load(cls, path: Path) -> "MetaYaml":
        """Load and validate a meta.yaml file."""
        text = path.read_text(encoding="utf-8")
        data = yaml.safe_load(text) or {}
        return cls.model_validate(data)

    def to_json(self) -> str:
        """Serialize to formatted JSON string."""
        import json
        return json.dumps(self.model_dump(mode="json"), indent=2, ensure_ascii=False)

    # ─── Lookup helpers ────────────────────────────────────────────────────────

    def find_scope(self, file_path: Path, meta_yaml_dir: Path = None) -> Optional[IndexScope]:
        """Find the first matching index_scope for a file path.
        
        scope.path is resolved relative to meta_yaml_dir (or file_path's parent if not given).
        """
        base = meta_yaml_dir or file_path.parent
        for scope in self.index_scope:
            # Resolve scope path relative to base directory
            if Path(scope.path).is_absolute():
                scope_path = Path(scope.path)
            else:
                scope_path = (base / scope.path).resolve()
            try:
                rel = file_path.resolve().relative_to(scope_path)
                # Match pattern loosely (glob-style)
                import fnmatch
                if fnmatch.fnmatch(rel.name, scope.pattern) or fnmatch.fnmatch(rel.name, "*" + scope.pattern.replace("*.", "")):
                    return scope
            except ValueError:
                continue
        return None

    def scope_category(self, scope: IndexScope) -> Optional[str]:
        """Infer category from index_scope path (convention: last path component)."""
        # Convention: scope path like "demands/" → category = "demand"
        name = Path(scope.path).name.rstrip("/")
        if name:
            # strip common trailing 's' for singular form hint, but keep as-is
            return name
        return None

    def decay_group_for(self, category: str, status: Optional[str] = None) -> Optional[DecayGroup]:
        """Find the first decay_group whose trigger matches category (+ optional status)."""
        for dg in self.decay_groups:
            trigger = dg.trigger
            cat_match = trigger.get("category") == category
            if not cat_match:
                continue
            if "status" in trigger:
                if status is None or trigger.get("status") != status:
                    continue
            return dg
        return None

    def validate_value(self, dim_name: str, value: str, is_decay: bool = False) -> bool:
        """Check if a dimension value is allowed by meta.yaml config."""
        if is_decay:
            dims = self.dimensions.decay or []
        else:
            dims = self.dimensions.normal or []
        for dim in dims:
            if dim.name == dim_name:
                return value in dim.values
        # If dimension not defined, allow any value (open world)
        return True

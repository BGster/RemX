"""Configuration management for RemX."""
from pathlib import Path
from typing import Optional

import yaml
from pydantic import BaseModel, Field


class EmbedderConfig(BaseModel):
    provider: str = "ollama"
    model: str = "bge-m3"
    dimension: int = 1024
    ollama_base_url: str = "http://localhost:11434"
    ollama_timeout: int = 60
    openai_api_key: Optional[str] = None
    openai_model: str = "text-embedding-3-small"


class TmpConfig(BaseModel):
    ttl_hours: int = 24
    gc_interval_minutes: int = 60


class ProjectConfig(BaseModel):
    name: str = "project"
    root: str = "."


class UserConfig(BaseModel):
    id: str = ""
    workspace: str = ""


class Config(BaseModel):
    version: str = "0.1.0"
    project: ProjectConfig = Field(default_factory=ProjectConfig)
    embedder: EmbedderConfig = Field(default_factory=EmbedderConfig)
    tmp: TmpConfig = Field(default_factory=TmpConfig)
    user: UserConfig = Field(default_factory=UserConfig)
    users: list[str] = Field(default_factory=list)

    @classmethod
    def load(cls, path: Path) -> "Config":
        """Load config from YAML file."""
        if not path.exists():
            return cls()
        with open(path) as f:
            data = yaml.safe_load(f) or {}
        return cls.model_validate(data)

    def save(self, path: Path) -> None:
        """Save config to YAML file."""
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            yaml.safe_dump(self.model_dump(), f, sort_keys=False, allow_unicode=True)

    def resolve_root(self, config_path: Path) -> Path:
        """Resolve project root as absolute path."""
        root = self.project.root
        if not root or root == ".":
            return config_path.parent.resolve()
        return (config_path.parent / root).resolve()

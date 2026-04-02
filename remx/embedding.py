"""Embedding provider for vector search."""
from abc import ABC, abstractmethod
from typing import Optional

import httpx


class Embedder(ABC):
    @abstractmethod
    def embed(self, texts: list[str]) -> list[list[float]]:
        raise NotImplementedError


class OllamaEmbedder(Embedder):
    def __init__(
        self,
        base_url: str = "http://localhost:11434",
        model: str = "bge-m3",
        timeout: int = 60,
    ):
        self.base_url = base_url
        self.model = model
        self.timeout = timeout

    def embed(self, texts: list[str]) -> list[list[float]]:
        embeddings = []
        with httpx.Client(timeout=self.timeout) as client:
            for text in texts:
                resp = client.post(
                    f"{self.base_url}/api/embeddings",
                    json={"model": self.model, "prompt": text}
                )
                resp.raise_for_status()
                embeddings.append(resp.json()["embedding"])
        return embeddings


class OpenAIEmbedder(Embedder):
    def __init__(
        self,
        api_key: str,
        model: str = "text-embedding-3-small",
        dimension: int = 1536,
    ):
        self.api_key = api_key
        self.model = model
        self.dimension = dimension
        self._client: Optional[object] = None

    def _get_client(self):
        if self._client is None:
            from openai import OpenAI
            self._client = OpenAI(api_key=self.api_key)
        return self._client

    def embed(self, texts: list[str]) -> list[list[float]]:
        client = self._get_client()
        try:
            from openai import OpenAI
            if isinstance(client, OpenAI):
                response = client.embeddings.create(
                    model=self.model,
                    input=texts,
                )
                return [item.embedding for item in response.data]
        except Exception:
            pass
        # Fallback: return zero vectors
        return [[0.0] * self.dimension for _ in texts]


def create_embedder(
    provider: str = "ollama",
    model: str = "bge-m3",
    dimension: int = 1024,
    base_url: str = "http://localhost:11434",
    timeout: int = 60,
    api_key: Optional[str] = None,
) -> Optional[Embedder]:
    """Create an embedder based on config.

    Args:
        provider: "ollama" or "openai"
        model: Ollama model name (e.g. "bge-m3") or OpenAI model name
        dimension: embedding vector dimension (Ollama: from meta.yaml; OpenAI: 1536)
        base_url: Ollama base URL
        timeout: request timeout in seconds
        api_key: OpenAI API key (required for OpenAI provider)
    """
    try:
        if provider == "ollama":
            return OllamaEmbedder(base_url=base_url, model=model, timeout=timeout)
        elif provider == "openai" and api_key:
            return OpenAIEmbedder(api_key=api_key, model=model, dimension=dimension)
    except Exception:
        pass
    return None


def get_embedding(
    embedder: Optional[Embedder],
    text: str,
    dimension: int = 1024,
) -> Optional[list[float]]:
    """Get embedding for text, returning None if embedder unavailable."""
    if embedder is None:
        return None
    try:
        return embedder.embed([text])[0]
    except Exception:
        return None

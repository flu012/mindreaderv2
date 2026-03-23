"""
Shared utilities for Memory Graph CLI and Worker.
"""

import os
import sys
import json
from pathlib import Path

from graphiti_core import Graphiti
from graphiti_core.llm_client import LLMConfig
from graphiti_core.embedder import OpenAIEmbedder, OpenAIEmbedderConfig
from graphiti_core.cross_encoder import OpenAIRerankerClient
from llm_client import LLMClient


# Monkey-patch: fix Graphiti's json serialization of Neo4j DateTime objects
def _patched_json_default(obj):
    """Handle Neo4j DateTime and other non-serializable types."""
    if hasattr(obj, 'iso_format'):
        return obj.iso_format()
    if hasattr(obj, 'isoformat'):
        return obj.isoformat()
    raise TypeError(f'Object of type {type(obj).__name__} is not JSON serializable')


_original_dumps = json.dumps

def _safe_dumps(*args, **kwargs):
    if 'default' not in kwargs:
        kwargs['default'] = _patched_json_default
    return _original_dumps(*args, **kwargs)

# Patch json.dumps in Graphiti's prompt_helpers module
try:
    import graphiti_core.prompts.prompt_helpers as _ph
    _ph.json.dumps = _safe_dumps
except Exception:
    pass

class TrackedEmbedder(OpenAIEmbedder):
    """OpenAIEmbedder that tracks token usage."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.total_tokens_used = 0
        self.call_count = 0

    async def create(self, input_data):
        result = await self.client.embeddings.create(
            input=input_data, model=self.config.embedding_model
        )
        # Track usage
        if hasattr(result, 'usage') and result.usage:
            self.total_tokens_used += getattr(result.usage, 'total_tokens', 0)
        self.call_count += 1
        return result.data[0].embedding[:self.config.embedding_dim]

    def get_usage(self):
        return {
            "model": self.config.embedding_model,
            "total_tokens": self.total_tokens_used,
            "call_count": self.call_count,
        }

    def reset_usage(self):
        self.total_tokens_used = 0
        self.call_count = 0


# Cache and Queue paths
_cache_base = Path(os.getenv("MINDREADER_CACHE", os.path.expanduser("~/.mindreader/cache")))
CACHE_FILE = _cache_base / ".memory_cache.json"
QUEUE_DIR = _cache_base / "queue"


def validate_env():
    """Validate required environment variables at startup."""
    required = ["NEO4J_URI", "NEO4J_USER", "NEO4J_PASSWORD", "LLM_API_KEY", "EMBEDDER_API_KEY"]
    missing = [v for v in required if not os.getenv(v)]
    if missing:
        print(f"Missing required environment variables: {', '.join(missing)}", file=sys.stderr)
        print("Copy .env.example to .env and configure your settings.", file=sys.stderr)
        sys.exit(1)

    dim = os.getenv("EMBEDDER_DIM", "1536")
    try:
        int(dim)
    except ValueError:
        print(f"EMBEDDER_DIM must be an integer, got: {dim}", file=sys.stderr)
        sys.exit(1)


def make_graphiti():
    validate_env()

    extract_model = os.getenv("LLM_EXTRACT_MODEL", os.getenv("LLM_MODEL", "gpt-4o-mini"))
    base_model = os.getenv("LLM_MODEL", "gpt-4o-mini")

    llm_config = LLMConfig(
        api_key=os.getenv("LLM_API_KEY"),
        base_url=os.getenv("LLM_BASE_URL"),
        model=extract_model,
        small_model=os.getenv("LLM_SMALL_MODEL", base_model),
    )

    llm_client = LLMClient(config=llm_config)

    embedder = TrackedEmbedder(
        config=OpenAIEmbedderConfig(
            api_key=os.getenv("EMBEDDER_API_KEY"),
            base_url=os.getenv("EMBEDDER_BASE_URL"),
            embedding_model=os.getenv("EMBEDDER_MODEL"),
            embedding_dim=int(os.getenv("EMBEDDER_DIM", "1536")),
        )
    )

    reranker_config = LLMConfig(
        api_key=os.getenv("LLM_API_KEY"),
        base_url=os.getenv("LLM_BASE_URL"),
        model=os.getenv("LLM_SMALL_MODEL", base_model),
    )
    cross_encoder = OpenAIRerankerClient(config=reranker_config)

    return Graphiti(
        uri=os.getenv("NEO4J_URI"),
        user=os.getenv("NEO4J_USER"),
        password=os.getenv("NEO4J_PASSWORD"),
        llm_client=llm_client,
        embedder=embedder,
        cross_encoder=cross_encoder,
    )

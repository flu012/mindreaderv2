# MindReader V2 — Technical Reference

## Architecture

MindReader is organized as an npm workspaces monorepo:

```
mindreaderv2/
  packages/
    mindgraph/         # Python core - Graphiti memory engine, CLI, background worker
    mindreader-ui/     # Express server + React UI - visualization & management
      server/
        server.js      # App assembly (~150 lines)
        routes/        # 8 route modules (graph, entity, categories, search, cleanup, audit, tokens, cli)
        lib/           # Shared utilities (daemon, categorizer, LLM client, preprocessor)
      ui/              # React frontend
    openclaw-plugin/   # Optional AI agent integration - auto-recall/capture
```

## How It Works

```
Conversations ──> Capture ──> Preprocessor ──> Neo4j Knowledge Graph ──> Recall ──> AI Context
                    │              │                     │                            │
                    ▼              ▼                     ▼                            ▼
              Filter messages  Classify facts       Auto-categorize            Semantic search
              Extract facts    Attributes → Neo4j   Auto-tag                   Entity profiles
              Find entities    Relationships → Graphiti  Relationship repair    Structured JSON
                                                         │
                                                         ▼
                                                   Self-Evolution
                                                   (web search LLM discovers
                                                    new entities & relationships)
```

1. **Capture** — Conversations are filtered, then an LLM preprocessor extracts and classifies facts before storage
2. **Preprocess** — Each fact is classified as either an *attribute* (written directly to entity tags/summary in Neo4j) or a *relationship* (forwarded to Graphiti for graph storage). This prevents junk entities like "Developer" or "15 Years Experience" from polluting the graph.
3. **Organize** — LLM auto-categorizes, auto-tags, and maintains the graph continuously
4. **Evolve** — Any node can be expanded via web-search-powered research, discovering new entities and connections
5. **Recall** — Semantic search retrieves relevant memories with full entity context

## Smart Storage — Quality Over Quantity

Traditional knowledge graph systems treat everything as entities. Tell it "Dell is a developer with 15 years experience" and you get three entities: "Dell", "Developer", and "15 Years Experience". The last two are attributes, not independent entities — they pollute the graph.

MindReader's **preprocessing pipeline** solves this:

1. **Known entity lookup** — Before classification, the preprocessor searches Neo4j for entities mentioned in the text
2. **LLM classification** — Each fact is classified as an *attribute* (role, skill, trait, preference → direct Neo4j update) or a *relationship* (connection between entities → Graphiti)
3. **Direct attribute writes** — Tags and summary updates are written directly to existing entity nodes, avoiding unnecessary graph traversal
4. **Graceful degradation** — If preprocessing fails, the system falls back to Graphiti with custom extraction instructions that still prevent junk entity creation

Both the manual store path (`memory_store` tool) and the auto-capture path (end-of-conversation hook) go through this pipeline. The auto-capture path additionally extracts key facts from conversation history before classification, filtering out code, debug output, and tool results.

### Preprocessing Modes

| Mode | Behavior | LLM Calls |
|------|----------|-----------|
| `merged` (default) | One LLM call extracts facts + classifies | 1 |
| `two-pass` | Separate extraction and classification steps | 1 + N |

Set via the `PREPROCESS_MODE` environment variable.

## Features Detail

### Smart Search

Search across entity names, summaries, and tags from a single search bar (Ctrl+K).

- **Tag-aware search** — Search "swimmer" finds entities tagged "swimmer" even if the word isn't in the name
- **Context-aware** — On the graph tab, search highlights and zooms to matching nodes
- **Relevance ranking** — Exact name match > prefix match > contains match > tag match

### Auto-Maintenance

| Feature | How It Works |
|---|---|
| **Auto-Categorization** | LLM classifies uncategorized entities using name, summary, and tags |
| **Auto-Tagging** | Extracts descriptive tags (roles, skills, locations, relationships) in the same LLM call |
| **Batch Re-categorization** | Process uncategorized entities in configurable batches with one click |
| **Duplicate Detection** | Scans for entities with similar names and properties |
| **Relationship Repair** | Detects reversed, misspelled, and vague relationships (rule-based + LLM) |
| **Orphan Cleanup** | Finds and removes disconnected entities |

### Multiple Views

| View | Purpose |
|---|---|
| **List** | Browse and search entities with pagination, filter by category |
| **Timeline** | See memories organized chronologically (Today, Yesterday, This Week, Earlier) |
| **Graph** | Interactive visual exploration of entities and relationships |
| **Categories** | Browse and manage entity categories with per-category counts |
| **Activity** | Audit log of captured and recalled memories |
| **Tokens** | Track LLM API usage and costs |
| **Maintenance** | Cleanup tools, relationship repair, batch re-categorization |

### Graph Visualization

- Zoom, pan, click to explore
- Nodes sized by connection count — important entities are larger
- Color-coded by category (person, project, company, etc.)
- Hover for quick preview with category, tags, and summary
- Filter by category to focus on what matters
- **6 layout modes** — Force, ForceAtlas2, Radial, Circular, Cluster, Grid

## Memory Decay — Temporal Lifecycle

Memories decay over time unless reinforced by access. This keeps the knowledge graph fresh and prevents stale data from cluttering recall results.

### How It Works

1. **Strength decay**: Every entity and relationship has a `strength` field (0.0-1.0). Strength decays exponentially based on time since last access: `strength = exp(-lambda * days_since_last_access)`. Default lambda=0.03 gives a ~23-day half-life.

2. **Access reinforcement**: When an entity is accessed (search, recall, detail view), its strength is boosted and `last_accessed_at` is reset. Frequently-used memories stay strong.

3. **Auto-expiry**: When strength drops below the threshold (default 0.1), the item is soft-expired via `expired_at` timestamp. It's hidden from normal queries but preserved for history.

4. **Cascade expiry**: When all relationships of an entity are expired, the entity is auto-expired too.

5. **Contradiction expiry**: Handled by Graphiti — when new info contradicts an existing edge, the old edge is invalidated immediately regardless of strength.

### Configuration

| Variable | Default | Description |
|---|---|---|
| `MEMORY_DECAY_ENABLED` | `true` | Enable/disable the decay system |
| `MEMORY_DECAY_INTERVAL_MS` | `3600000` (1hr) | How often the decay job runs |
| `MEMORY_DECAY_LAMBDA` | `0.03` | Decay rate (~23-day half-life) |
| `MEMORY_DECAY_THRESHOLD` | `0.1` | Auto-expire below this strength |
| `MEMORY_DECAY_REINFORCE_DELTA` | `0.3` | Strength boost on access |

### API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/decay/status` | GET | Decay statistics and config |
| `/api/decay/run` | POST | Manually trigger a decay cycle |
| `/api/decay/restore/:name` | POST | Un-expire an entity and its relationships |

### Time-Travel Support

All expiry is soft-delete. The data model supports future time-travel queries:

```
-- Show the graph as of March 1
WHERE e.created_at <= datetime('2026-03-01')
  AND (e.expired_at IS NULL OR e.expired_at > datetime('2026-03-01'))
```

## Direct Entity API

For systems that require precise, deterministic memory management without LLM processing:

```
POST /api/entities
```

Create or update entities directly in Neo4j with batch support, optional relationships, and upsert behavior.

See **[Direct Entity API Reference](api-direct-entity.md)** for full documentation with examples.

## CLI Tool

Full command-line interface for power users and automation:

```bash
mg search "swimming competitions"     # Semantic search with entity profiles
mg search "Aria" --json               # Machine-readable JSON output
mg tags "Aria Lu"                     # View tags: Aria Lu [person]: swimmer, daughter
mg tags "Aria Lu" --add "competitive" # Add a tag
mg tags --backfill                    # LLM-extract tags for all entities
mg add "Alice is a data scientist"    # Store a new memory
mg entities --limit 20                # List entities
mg maint scan                        # Scan for issues
mg maint fix                         # Auto-fix duplicates and orphans
```

## OpenClaw Integration

MindReader is built as a first-class [OpenClaw](https://github.com/openclaw) extension.

### Plugin Capabilities

- **Auto-capture** (`agent_end` hook) — extracts entities, facts, and relationships from conversations
- **Auto-recall** (`before_agent_start` hook) — retrieves relevant memories and injects into agent context
- **Tool calls** — `memory_search`, `memory_store`, `memory_entities` tools
- **Web UI** — graph explorer served on configurable port (default 18900)
- **Auto-sync** — plugin files automatically sync from monorepo on gateway restart

### Plugin Configuration

Configuration in `openclaw.json` under `plugins.entries.mindreader.config`:

| Key | Description | Default |
|---|---|---|
| `neo4jUri` | Neo4j bolt connection URI | `bolt://localhost:7687` |
| `neo4jUser` | Neo4j username | `neo4j` |
| `neo4jPassword` | Neo4j password | (empty) |
| `llmProvider` | LLM provider (openai/dashscope/anthropic) | (from .env) |
| `llmApiKey` | LLM API key | (from .env) |
| `llmBaseUrl` | LLM API base URL | (from .env) |
| `llmModel` | LLM model name | (from .env) |
| `autoCapture` | Enable auto-capture from conversations | `true` |
| `autoRecall` | Enable auto-recall before agent responses | `true` |
| `recallLimit` | Max memories to recall | `5` |
| `captureMaxChars` | Max chars to capture per conversation | `2000` |
| `uiPort` | Web UI port | `18900` |
| `uiEnabled` | Enable web UI | `true` |

> Values left empty in `openclaw.json` fall through to `.env` variables automatically.

## Configuration

Configuration is stored in `.env` at the monorepo root. The setup wizard generates this automatically.

### Key Environment Variables

| Variable | Description |
|---|---|
| `LLM_PROVIDER` | `openai`, `dashscope`, or `anthropic` |
| `LLM_API_KEY` | API key for the LLM provider |
| `LLM_BASE_URL` | API base URL |
| `LLM_MODEL` | Primary LLM model |
| `LLM_SMALL_MODEL` | Smaller/faster model for extraction |
| `LLM_EVOLVE_MODEL` | Model for evolve feature (ideally with web search) |
| `EMBEDDER_API_KEY` | Embedder API key (defaults to LLM_API_KEY) |
| `EMBEDDER_BASE_URL` | Embedder API base URL |
| `EMBEDDER_MODEL` | Embedding model name |
| `EMBEDDER_DIM` | Embedding dimensions |
| `NEO4J_URI` | Neo4j connection URI |
| `NEO4J_USER` | Neo4j username |
| `NEO4J_PASSWORD` | Neo4j password |
| `UI_PORT` | Web UI port (default: 18900) |
| `SEQ_URL` | Seq structured logging URL (optional) |
| `SEQ_API_KEY` | Seq API key (optional) |

## LLM Providers

| Provider | Status | Default Model | Web Search | Notes |
|---|---|---|---|---|
| OpenAI | Supported | `gpt-4o-mini` | No | Most widely available |
| DashScope (Alibaba) | Supported | `qwen3.5-flash` | Yes (built-in) | Best for evolve feature |
| Anthropic | Supported (native) | `claude-sonnet-4-6` | No | Uses native Anthropic SDK |
| Ollama | Supported | `llama3.2` | No | Free, local, no API key. Embeddings via `nomic-embed-text` |

## Development

```bash
# Dev mode (server + UI with hot reload)
npm run dev

# Build the UI for production
npm run build

# Run setup wizard
npm run setup

# CLI tool
mg --help   # or: python3 packages/mindgraph/python/mg_cli.py --help
```

### Cross-Platform Support

MindReader runs on Linux, macOS, and Windows. The setup wizard detects the platform and uses the appropriate script (bash on Unix, PowerShell on Windows). The Python daemon uses platform-specific stdin handling (asyncio pipes on Unix, threaded readline on Windows).

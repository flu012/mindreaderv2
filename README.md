<div align="center">

# MindReader V2

**Give your AI a memory it can see, manage, and evolve.**

[English](README.md) | [中文](README.zh.md)

![MindReader Graph View](docs/images/mind%20graph%20view.png)

</div>

---

## The Problem with AI Memory Today

AI assistants forget everything between conversations. The emerging solutions — vector stores, RAG pipelines, memory plugins — all share the same fundamental problems:

| Pain Point | What Happens |
|---|---|
| **No visibility** | Your memories are buried in a vector database. You can't see what's stored, how things connect, or what's wrong. |
| **No control** | You can't edit, merge, categorize, or delete individual memories. It's a black box. |
| **No self-maintenance** | Memories pile up with duplicates, contradictions, and outdated facts. Nobody cleans them up. |
| **No self-evolution** | The system only knows what you explicitly tell it. It never learns on its own. |

MindReader V2 solves all of this.

## What is MindReader V2?

MindReader is a **personal knowledge graph** that captures, organizes, and recalls information from your AI conversations. Unlike flat memory stores, it builds a structured graph of entities and relationships — and gives you a full visual interface to see and manage everything.

### Key Principles

- **See everything** — Interactive graph visualization shows your entire memory landscape
- **Control everything** — Edit entities, manage tags, merge duplicates, create relationships manually
- **Self-maintaining** — LLM-powered auto-categorization, auto-tagging, relationship cleanup, and deduplication
- **Self-evolving** — Nodes autonomously research and expand their own knowledge via web search

---

## Features

### Self-Evolution — Memory That Grows on Its Own

This is what makes MindReader fundamentally different from every other AI memory system. Your knowledge graph doesn't just store what you tell it — **it actively researches and expands itself**.

Select any node and hit **Evolve**. MindReader sends the entity to a web-search-capable LLM that:

1. **Researches** the entity using live web search — finding up-to-date facts, connections, and context
2. **Discovers new entities** — people, organizations, projects, concepts related to the original node
3. **Maps relationships** — automatically creates typed connections (works_at, developed_by, part_of, etc.)
4. **Streams results live** — watch new nodes and edges appear in real-time on an interactive graph
5. **Saves to your graph** — review the discoveries, then save them directly into your knowledge base

The evolve graph shows existing nodes (blue) alongside newly discovered entities (color-coded by category), letting you see exactly what the LLM found before committing anything.

https://github.com/user-attachments/assets/4a93cef0-e48e-464d-a70c-1759d16c5de2

> *A single evolve pass typically discovers 10-25 new entities and their relationships, turning a lonely node into a rich knowledge cluster.*

This means your memory graph becomes **compounding** — each evolve pass creates new nodes that can themselves be evolved, building an ever-expanding web of knowledge without you having to manually input anything.

---

### Visual Knowledge Graph

Explore your memories as an interactive force-directed graph. Nodes represent entities (people, projects, tools, locations), edges represent relationships and facts.

- Zoom, pan, click to explore
- Nodes sized by connection count — important entities are larger
- Color-coded by category (person, project, company, etc.)
- Hover for quick preview with category, tags, and summary
- Filter by category to focus on what matters

![Graph Visualization](docs/images/mind%20graph%20view.png)

### Entity Management

Click any entity to open the detail panel with full control over your memories:

- **Tags** — Add descriptive tags (auto-extracted by LLM, manually editable)
- **Categories** — 12 built-in categories, fully customizable
- **Summary** — Click-to-edit summaries with AI-generated explanations
- **Evolve** — Research and expand any node's knowledge via web search
- **Link** — Manually create relationships between entities
- **Merge** — Combine duplicate entities, preserving all relationships
- **Delete** — Remove with impact preview (shows affected relationships)

<p align="center">
<img src="docs/images/manual%20link%20memory.png" width="300" alt="Link entities">
<img src="docs/images/manual%20merge%20memory.png" width="300" alt="Merge entities">
</p>

### Smart Search

Search across entity names, summaries, and tags from a single search bar (Ctrl+K).

- **Tag-aware search** — Search "swimmer" finds entities tagged "swimmer" even if the word isn't in the name
- **Context-aware** — On the graph tab, search highlights and zooms to matching nodes
- **Relevance ranking** — Exact name match > prefix match > contains match > tag match

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

<p align="center">
<img src="docs/images/node%20list%20view.png" width="400" alt="List View">
<img src="docs/images/node%20creatioon%20timeline.png" width="400" alt="Timeline View">
</p>

![Categories View](docs/images/node%20categorisation%20view.png)

### Auto-Maintenance

MindReader doesn't just store memories — it keeps them clean.

| Feature | How It Works |
|---|---|
| **Auto-Categorization** | LLM classifies uncategorized entities using name, summary, and tags |
| **Auto-Tagging** | Extracts descriptive tags (roles, skills, locations, relationships) in the same LLM call |
| **Batch Re-categorization** | Process uncategorized entities in configurable batches with one click |
| **Duplicate Detection** | Scans for entities with similar names and properties |
| **Relationship Repair** | Detects reversed, misspelled, and vague relationships (rule-based + LLM) |
| **Orphan Cleanup** | Finds and removes disconnected entities |

![Maintenance Hub](docs/images/memory%20automastically%20clean%20up.png)

### CLI Tool

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

### AI Agent Integration

MindReader integrates with AI agent frameworks (OpenClaw) to provide automatic memory:

- **Auto-recall** — Relevant memories injected into agent prompts before execution
- **Auto-capture** — Facts extracted from agent conversations and stored automatically
- **Tools** — Agents can search, store, and list memories via tool calls

---

## Quick Start

```bash
# Clone the repo
git clone https://github.com/flu012/mindreaderv2.git
cd mindreaderv2

# Run the interactive setup wizard
./scripts/setup.sh

# Start the server
npm start
```

Open `http://localhost:18900` to access the web UI.

## Requirements

- Node.js 18+
- Python 3.11+
- Neo4j 5.x (Docker setup included, or bring your own)
- An LLM API key (OpenAI, Anthropic via proxy, or DashScope)
- For self-evolution: a web-search-capable model (e.g. Qwen qwen3.5-plus via DashScope)

## Architecture

MindReader is organized as an npm workspaces monorepo:

```
mindreaderv2/
  packages/
    mindgraph/         # Python core - Graphiti memory engine, CLI, background worker
    mindreader-ui/     # Express server + React UI - visualization & management
    openclaw-plugin/   # Optional AI agent integration - auto-recall/capture
```

### How It Works

```
Conversations ──> Capture ──> Neo4j Knowledge Graph ──> Recall ──> AI Context
                    │                    │                           │
                    ▼                    ▼                           ▼
              Entity extraction    Auto-categorize           Semantic search
              Fact extraction      Auto-tag                  Entity profiles
              Dedup detection      Relationship repair       Structured JSON
                                         │
                                         ▼
                                   Self-Evolution
                                   (web search LLM discovers
                                    new entities & relationships)
```

1. **Capture** — Conversations are processed into entities and relationships, stored in Neo4j
2. **Organize** — LLM auto-categorizes, auto-tags, and maintains the graph continuously
3. **Evolve** — Any node can be expanded via web-search-powered research, discovering new entities and connections
4. **Recall** — Semantic search retrieves relevant memories with full entity context

## LLM Providers

| Provider | Status | Default Model | Web Search |
|---|---|---|---|
| OpenAI | Supported | `gpt-4o-mini` | No |
| DashScope (Alibaba) | Supported | `qwen3.5-flash` | Yes (built-in) |
| Anthropic | Supported (via proxy) | Requires OpenAI-compatible proxy | Depends on proxy |

> For the self-evolve feature, a model with built-in web search (like DashScope's Qwen models) produces significantly richer results.

## Configuration

Configuration is stored in `.env` at the monorepo root. The setup wizard generates this automatically, or configure manually:

```bash
cp .env.example .env
```

Key variables: `LLM_PROVIDER`, `LLM_API_KEY`, `NEO4J_URI`, `NEO4J_USER`, `NEO4J_PASSWORD`.

## Development

```bash
# Dev mode (server + UI with hot reload)
npm run dev

# Build the UI for production
npm run build

# CLI tool
mg --help   # or: python3 packages/mindgraph/python/mg_cli.py --help
```

## License

MIT

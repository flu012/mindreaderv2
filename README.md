<div align="center">

# MindReader V2

**Give your AI a memory system it can see, manage, and self-evolve.**

[English](README.md) | [中文](README.zh.md)

![MindReader Graph View](docs/images/mind%20graph%20view.png)

</div>

---

## The Problem with AI Memory

AI assistants forget everything between conversations. Existing solutions — vector databases, RAG pipelines, memory plugins — all share the same problems:

- **Invisible** — memories are buried in databases you can't see or inspect
- **Uncontrollable** — no way to edit, merge, or delete individual memories
- **Messy** — duplicates, contradictions, and outdated info pile up with no cleanup
- **Static** — the system only knows what you explicitly tell it

## How MindReader Is Different

MindReader is a **personal knowledge graph** that gives you full visibility and control over your AI's memory.

### Visual Memory Graph

See your entire memory landscape as an interactive graph. Nodes are entities (people, projects, tools), edges are relationships. Zoom, filter, click to explore. No more black boxes.

![Graph Visualization](docs/images/mind%20graph%20view.png)

### Full Manual Control

Click any entity to edit its summary, tags, and category. Merge duplicates. Create or delete relationships. Preview blast radius before deleting. Your memory, your rules.

<p align="center">
<img src="docs/images/manual%20link%20memory.png" width="300" alt="Link Entities">
<img src="docs/images/manual%20merge%20memory.png" width="300" alt="Merge Entities">
</p>

### Self-Evolve — Memory That Grows Itself

Select any node and click **Evolve**. MindReader sends it to a web-search-capable LLM that researches the entity, discovers related people/projects/concepts, and builds relationships — all streamed live onto the graph.

https://github.com/user-attachments/assets/4a93cef0-e48e-464d-a70c-1759d16c5de2

> *A single evolve typically discovers 10-25 new entities and relationships, turning an isolated node into a rich knowledge cluster.*

### Memory Decay & Time Travel

Memories naturally decay over time unless reinforced by frequent use. Every entity and relationship has a **strength** score that decays exponentially — frequently accessed memories stay vivid, unused ones fade and eventually expire.

- **Visual decay** — node opacity reflects memory strength, faded nodes indicate aging knowledge
- **"Show Decay" mode** — color the graph by strength (green → yellow → red)
- **Time Travel** — drag a slider to see the graph at any point in time. Nodes that didn't exist yet disappear, expired ones reappear as ghosts. Hit **Auto Play** to watch your knowledge graph grow from scratch.
- **Restore** — one-click restore any expired entity

### Automatic Maintenance

LLM-powered background maintenance keeps the graph clean: auto-categorization, auto-tagging, duplicate detection, relationship repair, orphan cleanup — no manual intervention needed.

![Maintenance Hub](docs/images/memory%20automastically%20clean%20up.png)

### Multiple View Modes

Browse your knowledge as a list, timeline, graph, categories, or activity log.

<p align="center">
<img src="docs/images/node%20list%20view.png" width="400" alt="List View">
<img src="docs/images/node%20creatioon%20timeline.png" width="400" alt="Timeline View">
</p>

![Category View](docs/images/node%20categorisation%20view.png)

---

## How It Works with OpenClaw

MindReader is a first-class extension for [OpenClaw](https://github.com/openclaw). Install once, then every conversation automatically builds your knowledge graph.

- **Auto-capture** — silently extracts entities, facts, and relationships from conversations
- **Auto-recall** — before the agent responds, retrieves relevant memories and injects them as context
- **Tool calls** — agents can explicitly search, store, and list memories
- **Web UI** — access the full graph explorer anytime at `http://localhost:18900`

> Just talk to your agent naturally. MindReader handles the rest.

### MCP Server — Works with Claude Code & Cursor

MindReader includes an [MCP server](https://github.com/flu012/mindreader-mcp) for integration with Claude Code, Cursor, or any MCP-compatible client. Six tools: search, store, create, recall, list entities, and stats.

```json
{
  "mcpServers": {
    "mindreader": {
      "command": "node",
      "args": ["/path/to/mindreader-mcp/src/index.js"]
    }
  }
}
```

---

## Quick Start

```bash
git clone https://github.com/flu012/mindreaderv2.git
cd mindreaderv2
npm run setup    # interactive wizard
npm start        # http://localhost:18900
```

> **[Full installation guide →](docs/quickstart.md)**

### Prerequisites

- **Node.js** 18+
- **Python** 3.11+
- **Docker** (for Neo4j database)
- **LLM API key** (any of the providers below)

### Supported LLM Providers

| Provider | Default Model | Web Search | Notes |
|---|---|---|---|
| OpenAI | `gpt-4o-mini` | No | Most widely available |
| DashScope (Alibaba) | `qwen3.5-flash` | Yes (built-in) | Best choice for self-evolve |
| Anthropic | `claude-sonnet-4-6` | No | Native API support |
| Ollama | `llama3.2` | No | Free, fully local, no API key needed |

> Self-evolve works significantly better with models that support built-in web search (e.g. DashScope's Qwen series). Ollama is ideal for privacy-first setups where all data stays local.

### Direct Entity API

For systems that need precise, deterministic memory management without LLM processing:

```bash
curl -X POST http://localhost:18900/api/entities -H "Content-Type: application/json" \
  -d '{"entities":[{"name":"Alice","category":"person","tags":["engineer"]}]}'
```

Supports batch creation, upserts, and relationship management. See the [API reference](docs/api-direct-entity.md).

---

## Documentation

- **[Quick Start Guide](docs/quickstart.md)** — step-by-step install, provider setup, OpenClaw integration, troubleshooting
- **[Technical Reference](docs/technical.md)** — architecture, preprocessing pipeline, configuration, CLI reference, development

---

## Disclaimer

MindReader V2 is an experimental project for personal use and research. Provided as-is with no guarantees of data integrity, security, or availability. Memory data is stored in local Neo4j — back up your database regularly. LLM-generated content (auto-categorization, evolve results, extracted facts) may contain inaccuracies — review important memories manually. API keys and credentials in `.env` are stored in plaintext — do not commit this file to version control.

## License

MIT

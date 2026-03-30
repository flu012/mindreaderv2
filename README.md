<div align="center">

# MindReader V2

**Give your AI a memory it can see, manage, and evolve.**

[English](README.md) | [中文](README.zh.md)

![MindReader Graph View](docs/images/mind%20graph%20view.png)

</div>

---

## The Problem with AI Memory

AI assistants forget everything between conversations. The solutions that exist today — vector stores, RAG pipelines, memory plugins — all share the same problems:

- **Invisible** — memories buried in a database you can't see or inspect
- **Uncontrollable** — no way to edit, merge, or delete individual memories
- **Messy** — duplicates, contradictions, and outdated facts pile up with no cleanup
- **Static** — the system only knows what you explicitly tell it

## What Makes MindReader Different

MindReader is a **personal knowledge graph** that gives you full visibility and control over your AI's memory.

### Visual Memory Graph

See your entire memory landscape as an interactive graph. Nodes are entities (people, projects, tools), edges are relationships. Zoom, filter, click to explore. No more black boxes.

![Graph Visualization](docs/images/mind%20graph%20view.png)

### Full Manual Control

Click any entity to edit its summary, tags, and category. Merge duplicates. Create or remove relationships. Delete with impact preview. Your memory, your rules.

<p align="center">
<img src="docs/images/manual%20link%20memory.png" width="300" alt="Link entities">
<img src="docs/images/manual%20merge%20memory.png" width="300" alt="Merge entities">
</p>

### Self-Evolution — Memory That Grows on Its Own

Select any node and hit **Evolve**. MindReader sends it to a web-search-capable LLM that researches the entity, discovers related people/projects/concepts, and maps relationships — all streamed live onto the graph.

https://github.com/user-attachments/assets/4a93cef0-e48e-464d-a70c-1759d16c5de2

> *A single evolve pass typically discovers 10-25 new entities and relationships, turning a lonely node into a rich knowledge cluster.*

### Memory Decay & Time Travel

Memories fade over time unless reinforced by use. Each entity and relationship has a **strength** score that decays exponentially — frequently accessed memories stay vivid, unused ones gradually fade and eventually expire.

- **Visual decay** — node opacity reflects memory strength; fading nodes signal aging knowledge
- **"Show Decay" mode** — color-codes the graph by strength (green → yellow → red)
- **Time Travel** — drag a slider to see the graph as it was at any point in time. Nodes that didn't exist yet disappear; expired nodes reappear as ghosts. Hit **Auto Play** to watch your knowledge graph grow from the beginning.
- **Restore** — bring back any expired entity with one click

### Auto-Maintenance

LLM-powered background maintenance keeps your graph clean: auto-categorization, auto-tagging, duplicate detection, relationship repair, and orphan cleanup — without any manual effort.

![Maintenance](docs/images/memory%20automastically%20clean%20up.png)

### Multiple Views

Browse your knowledge as a list, timeline, graph, by category, or through activity logs.

<p align="center">
<img src="docs/images/node%20list%20view.png" width="400" alt="List View">
<img src="docs/images/node%20creatioon%20timeline.png" width="400" alt="Timeline View">
</p>

![Categories](docs/images/node%20categorisation%20view.png)

---

## How It Works with OpenClaw

MindReader is built as a first-class [OpenClaw](https://github.com/openclaw) extension. Install it once, then every conversation automatically builds your knowledge graph.

- **Auto-capture** — entities, facts, and relationships are silently extracted from conversations
- **Auto-recall** — relevant memories are injected into context before the agent responds
- **Tool calls** — agents can explicitly search, store, and list memories
- **Web UI** — access the full graph explorer anytime at `http://localhost:18900`

> Just talk to your agent naturally. MindReader handles the rest.

---

## Quick Start

```bash
git clone https://github.com/flu012/mindreaderv2.git
cd mindreaderv2
npm run setup    # Interactive wizard
npm start        # http://localhost:18900
```

> **[Full installation guide →](docs/quickstart.md)**

### Prerequisites

- **Node.js** 18+
- **Python** 3.11+
- **Docker** (for Neo4j database)
- **LLM API key** (one of the providers below)

### Supported LLM Providers

| Provider | Default Model | Web Search | Notes |
|---|---|---|---|
| OpenAI | `gpt-4o-mini` | No | Most widely available |
| DashScope (Alibaba) | `qwen3.5-flash` | Yes (built-in) | Best for self-evolve feature |
| Anthropic | `claude-sonnet-4-6` | No | Native API support |
| Ollama | `llama3.2` | No | Free, fully local, no API key needed |

> For the self-evolve feature, a model with built-in web search (like DashScope's Qwen) produces significantly richer results. Ollama is great for privacy-first setups where all data stays on your machine.

---

## Documentation

- **[Quick Start Guide](docs/quickstart.md)** — step-by-step installation, provider setup, OpenClaw integration, troubleshooting
- **[Technical Reference](docs/technical.md)** — architecture, preprocessing pipeline, configuration, CLI reference, development

---

## Disclaimer

MindReader V2 is an experimental project for personal use and research. It is provided as-is, with no guarantees of data integrity, security, or availability. Memory data is stored locally in Neo4j — back up your database regularly. LLM-generated content (auto-categorization, evolve results, extracted facts) may contain inaccuracies. Review important memories manually. API keys and credentials in `.env` are stored in plaintext — do not commit this file to version control.

## License

MIT

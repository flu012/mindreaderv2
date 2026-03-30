# MindReader Quick Start Guide

Step-by-step installation for a fresh machine. Takes about 10 minutes.

## Prerequisites

| Requirement | Why |
|---|---|
| **Node.js 18+** | Server + UI |
| **Python 3.11+** | Knowledge graph engine (Graphiti) |
| **Docker** | Neo4j database (or bring your own Neo4j 5.x) |
| **LLM API key** | OpenAI, Anthropic, DashScope, or Ollama (no key needed) |

> **Anthropic users:** You'll also need an OpenAI or DashScope API key for embeddings — Anthropic doesn't provide an embeddings API.

## Step 1: Clone and Run Setup

Works on **Linux/macOS (bash)**, **WSL**, and **Windows (PowerShell)**:

```bash
git clone https://github.com/flu012/mindreaderv2.git
cd mindreaderv2
npm run setup
```

> `npm run setup` auto-detects your platform — runs the bash wizard on Linux/macOS/WSL, or the PowerShell wizard on Windows.

The interactive wizard walks you through 4 steps:

### 1. Components

- **MindGraph + MindReader UI** — always included
- **OpenClaw Plugin** — select "Yes" if you use [OpenClaw](https://github.com/openclaw). Auto-detects `~/.openclaw/extensions/`

### 2. Neo4j Database

Two options:

| Option | When to use |
|---|---|
| **Docker-managed** (recommended) | Fresh install, no existing Neo4j. Setup handles everything. |
| **Bring your own** | You already have Neo4j 5.x running. Provide URI + credentials. |

Docker-managed Neo4j runs on ports 7474 (browser) and 7687 (bolt).

### 3. LLM Provider

| Provider | Default Model | Web Search | Notes |
|---|---|---|---|
| **OpenAI** | `gpt-4o-mini` | No | Most common choice |
| **Anthropic** | `claude-sonnet-4-6` | No | Needs separate embedder (OpenAI or DashScope) |
| **DashScope** | `qwen3.5-flash` | Yes (built-in) | Best for self-evolve feature |
| **Ollama** | `llama3.2` | No | Free, local, no API key needed |

> For Ollama, install from https://ollama.com, then pull the required models:
> ```bash
> ollama pull llama3.2 && ollama pull nomic-embed-text
> ```

You'll be asked for:
- API key
- Model name (or press Enter for default)
- Optional: Evolve model (for web-search-powered node expansion)
- Embedder provider (defaults to same as LLM, except for Anthropic)

### 4. Verify & Install

The wizard will:
- Test Neo4j connection
- Test LLM API
- Create Python virtual environment + install dependencies
- Install npm packages
- Build the React UI
- Copy OpenClaw plugin (if selected)
- Write `.env` config file

## Step 2: Start MindReader

```bash
npm start
```

You should see:

```
[info] MindReader: Python daemon ready
[info] MindReader: Loaded 12 categories from Neo4j
[info] MindReader UI: http://localhost:18900
```

Open **http://localhost:18900** in your browser.

For development with hot-reload:

```bash
npm run dev
```

## Step 3: Connect to OpenClaw (Optional)

If you selected the OpenClaw plugin during setup, configure OpenClaw to use it:

Edit your OpenClaw config (usually `~/.openclaw/openclaw.json`):

```json
{
  "plugins": {
    "entries": ["mindreader"],
    "slots": {
      "memory": "mindreader"
    }
  }
}
```

Restart OpenClaw:

```bash
openclaw gateway restart
```

Now every conversation with your AI agent automatically builds your knowledge graph.

## Step 4: Verify

1. **Graph UI** — Open http://localhost:18900. An empty graph is normal for a fresh install.
2. **Chat** — Talk to your OpenClaw agent. Memories appear in the graph automatically.
3. **CLI** — Run `mg search "test"` from terminal (if you added the alias during setup).

## Managing Neo4j

If you chose Docker-managed Neo4j:

```bash
# Start
docker compose -f packages/mindgraph/docker/docker-compose.yml up -d

# Stop
docker compose -f packages/mindgraph/docker/docker-compose.yml down

# View logs
docker compose -f packages/mindgraph/docker/docker-compose.yml logs -f

# Neo4j Browser (query explorer)
open http://localhost:7474
```

## Configuration

All settings are in `.env` at the repo root. Key variables:

| Variable | Description |
|---|---|
| `LLM_PROVIDER` | `openai`, `anthropic`, `dashscope`, or `ollama` |
| `LLM_API_KEY` | Your LLM API key |
| `LLM_MODEL` | Model for entity extraction and categorization |
| `LLM_EVOLVE_MODEL` | Model for node evolve (web-search-capable recommended) |
| `EMBEDDER_PROVIDER` | Embedder provider (must be OpenAI or DashScope) |
| `EMBEDDER_API_KEY` | Embedder API key (can differ from LLM key) |
| `NEO4J_URI` | Neo4j bolt URI (default: `bolt://localhost:7687`) |
| `NEO4J_PASSWORD` | Neo4j password |
| `UI_PORT` | Web UI port (default: `18900`) |

### Memory Decay

| Variable | Default | Description |
|---|---|---|
| `MEMORY_DECAY_ENABLED` | `true` | Enable/disable memory decay |
| `MEMORY_DECAY_LAMBDA` | `0.03` | Decay rate (~23-day half-life) |
| `MEMORY_DECAY_THRESHOLD` | `0.1` | Auto-expire below this strength |

To reconfigure, either edit `.env` directly or re-run `npm run setup`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| UI loads but graph is empty | Normal for fresh install. Chat with OpenClaw to populate memories. |
| "Python daemon exited" in logs | Check venv: `cd packages/mindgraph/python && .venv/bin/python -c "import graphiti_core; print('ok')"` |
| Neo4j connection failed | Verify Docker: `docker ps` should show `neo4j` container. Check `NEO4J_PASSWORD` in `.env`. |
| LLM errors at startup | Verify `LLM_API_KEY` and `LLM_PROVIDER` in `.env` |
| Anthropic + embedding errors | Set `EMBEDDER_PROVIDER=openai` and provide a separate `EMBEDDER_API_KEY` in `.env` |
| Port 18900 already in use | Change `UI_PORT` in `.env` or stop the other process |
| `npm run setup` fails | Ensure Node.js 18+ and Python 3.11+ are installed: `node -v && python3 --version` |
| Evolve feature returns nothing | `LLM_EVOLVE_MODEL` should be a web-search-capable model (e.g. DashScope `qwen3.5-plus`) |

## CLI Tool

```bash
mg search "swimming competitions"     # Semantic search
mg search "Aria" --json               # JSON output
mg tags "Aria Lu"                     # View tags
mg tags "Aria Lu" --add "competitive" # Add a tag
mg add "Alice is a data scientist"    # Store a memory
mg entities --limit 20                # List entities
mg maint scan                         # Scan for issues
mg maint fix                          # Auto-fix duplicates
```

If you didn't add the alias during setup:

```bash
alias mg='python3 /path/to/mindreaderv2/packages/mindgraph/python/mg_cli.py'
```

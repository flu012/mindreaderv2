"""
Memory Graph Daemon — long-running process for MindReader CLI commands.

Stays alive between calls, keeping Graphiti + Neo4j connections warm.
Communicates via stdin/stdout JSON protocol:

  Request:  {"id": "abc", "cmd": "search", "args": {"query": "...", "limit": 5, "json_output": true}}
  Response: {"id": "abc", "ok": true, "output": "...", "data": {...}}
  Error:    {"id": "abc", "ok": false, "error": "..."}

Sentinel: a line containing just "PING" returns "PONG" (health check).
"""

import asyncio
import json
import os
import sys
import hashlib
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

_script_dir = Path(__file__).resolve().parent
_monorepo_root = _script_dir.parent.parent.parent
_env_path = os.getenv("MINDREADER_ROOT", str(_monorepo_root))
load_dotenv(Path(_env_path) / ".env")

from shared import make_graphiti, CACHE_FILE, QUEUE_DIR


# ---------------------------------------------------------------------------
# Globals — initialized once, reused across commands
# ---------------------------------------------------------------------------
_graphiti = None
_neo4j_driver = None


def _get_graphiti():
    global _graphiti
    if _graphiti is None:
        _graphiti = make_graphiti()
    return _graphiti


def _get_neo4j_driver():
    global _neo4j_driver
    if _neo4j_driver is None:
        from neo4j import GraphDatabase
        _neo4j_driver = GraphDatabase.driver(
            os.getenv("NEO4J_URI", "bolt://localhost:7687"),
            auth=(os.getenv("NEO4J_USER", "neo4j"), os.getenv("NEO4J_PASSWORD", "")),
        )
    return _neo4j_driver


# ---------------------------------------------------------------------------
# Cache helpers (same as mg_cli.py)
# ---------------------------------------------------------------------------
def load_cache():
    if CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, "r") as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {"entries": {}}


def save_cache(cache):
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(CACHE_FILE, "w") as f:
            json.dump(cache, f, indent=2)
    except Exception:
        pass


def text_hash(text):
    return hashlib.sha256(text.encode()).hexdigest()[:32]


def _unique_profiles(profiles):
    seen, out = set(), []
    for p in profiles.values():
        if p["name"] not in seen:
            seen.add(p["name"])
            out.append(p)
    return out


# ---------------------------------------------------------------------------
# Command handlers — return (output_text, data_dict)
# ---------------------------------------------------------------------------
async def cmd_search(args, tenant_id="master"):
    g = _get_graphiti()
    query = args["query"]
    limit = int(args.get("limit", 10))
    json_output = args.get("json_output", False)
    group = args.get("group")

    group_ids = [group] if group else [tenant_id]
    results = await g.search(query=query, num_results=limit, group_ids=group_ids)

    if not results:
        if json_output:
            return "", {"edges": [], "entities": []}
        return "No results found.", None

    # Collect entity UUIDs
    entity_uuids = set()
    for r in results:
        src = getattr(r, "source_node_uuid", None)
        tgt = getattr(r, "target_node_uuid", None)
        if src:
            entity_uuids.add(src)
        if tgt:
            entity_uuids.add(tgt)

    # Batch-fetch entity profiles
    profiles = {}
    if entity_uuids:
        driver = _get_neo4j_driver()
        with driver.session() as session:
            result = session.run(
                "MATCH (e:Entity) WHERE e.uuid IN $uuids AND e.tenantId = $tenantId "
                "RETURN e.uuid AS uuid, e.name AS name, e.category AS category, e.tags AS tags",
                uuids=list(entity_uuids), tenantId=tenant_id,
            )
            for rec in result:
                profiles[rec["uuid"]] = {
                    "name": rec["name"] or "",
                    "category": rec["category"] or "other",
                    "tags": list(rec["tags"] or []),
                }

    unique = _unique_profiles(profiles)

    if json_output:
        edges = []
        for r in results:
            edges.append({
                "name": getattr(r, "name", ""),
                "fact": getattr(r, "fact", None) or str(r),
                "source_node_uuid": getattr(r, "source_node_uuid", ""),
                "target_node_uuid": getattr(r, "target_node_uuid", ""),
            })
        return "", {"edges": edges, "entities": unique}

    # Human-readable
    lines = [f"Found {len(results)} results:\n"]
    for i, r in enumerate(results, 1):
        fact = getattr(r, "fact", None) or str(r)
        name = getattr(r, "name", "")
        lines.append(f"  {i}. [{name}] {fact}")
    if unique:
        lines.append("\nEntity profiles:")
        for p in sorted(unique, key=lambda x: x["name"]):
            tags_str = ", ".join(p["tags"]) if p["tags"] else "(no tags)"
            lines.append(f"  - {p['name']} [{p['category']}]: {tags_str}")

    return "\n".join(lines), None


async def cmd_entities(args, tenant_id="master"):
    limit = int(args.get("limit", 30))
    driver = _get_neo4j_driver()
    with driver.session() as session:
        result = session.run(
            "MATCH (n:Entity) WHERE n.tenantId = $tenantId "
            "RETURN n.name AS name, n.summary AS summary "
            "ORDER BY n.created_at DESC LIMIT $limit",
            limit=limit, tenantId=tenant_id,
        )
        entities = list(result)

    if not entities:
        return "No entities found.", None

    lines = [f"Entities ({len(entities)}):\n"]
    for e in entities:
        summary = (e["summary"] or "")[:120]
        lines.append(f"  \u2022 {e['name']}: {summary}")

    return "\n".join(lines), None


async def cmd_add(args, tenant_id="master"):
    content = args["content"]
    source = args.get("source", "agent")
    project = args.get("project")
    do_async = args.get("async", False)
    group = args.get("group", "") or tenant_id
    custom_instructions = args.get("custom_instructions")

    # Duplicate check
    cache = load_cache()
    content_hash = text_hash(content)
    if content_hash in cache["entries"]:
        cached = cache["entries"][content_hash]
        return f"Duplicate detected: \"{cached['preview']}...\" (stored {cached['created_at']})", None

    project_content = content
    if project:
        project_content = f"{content}. This is related to the {project} project."

    g = _get_graphiti()

    # Conflict detection
    similar = await g.search(query=project_content, num_results=5, group_ids=[tenant_id])
    new_words = set(project_content.lower().split())
    conflicting = []
    for s in (similar or []):
        if not getattr(s, "uuid", None):
            continue
        fact = getattr(s, "fact", "") or str(s)
        old_words = set(fact.lower().split())
        overlap = len(new_words & old_words)
        shorter_len = min(len(new_words), len(old_words))
        if overlap > 25 and shorter_len > 0 and (overlap / shorter_len) > 0.4:
            conflicting.append(s)

    output_lines = []
    if conflicting:
        output_lines.append(f"Found {len(conflicting)} conflicting memories.")

    if do_async:
        QUEUE_DIR.mkdir(parents=True, exist_ok=True)
        item = {
            "content": project_content,
            "source": source,
            "group_id": group,
            "custom_instructions": custom_instructions,
            "queued_at": datetime.now(timezone.utc).isoformat(),
        }
        queue_file = QUEUE_DIR / f"memory_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{content_hash}.json"
        with open(queue_file, "w") as f:
            json.dump(item, f, indent=2)
        cache["entries"][content_hash] = {
            "content": project_content,
            "preview": project_content[:50],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": source,
            "status": "queued",
        }
        save_cache(cache)
        output_lines.append(f"Memory queued for processing ({queue_file.name})")
    else:
        await g.add_episode(
            name=f"memory-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}",
            episode_body=project_content,
            source_description=source,
            reference_time=datetime.now(timezone.utc),
            group_id=group,
            custom_extraction_instructions=custom_instructions,
        )
        cache["entries"][content_hash] = {
            "content": project_content,
            "preview": project_content[:50],
            "created_at": datetime.now(timezone.utc).isoformat(),
            "source": source,
            "status": "stored",
        }
        if len(cache["entries"]) > 1000:
            sorted_entries = sorted(cache["entries"].items(), key=lambda x: x[1]["created_at"])
            cache["entries"] = dict(sorted_entries[-500:])
        save_cache(cache)

        # Embedding usage
        data = None
        if hasattr(g.embedder, "get_usage"):
            data = {"embedding_usage": g.embedder.get_usage()}

        output_lines.append(f"Memory stored: {project_content[:100]}...")
        return "\n".join(output_lines), data

    return "\n".join(output_lines), None


# ---------------------------------------------------------------------------
# Dispatcher
# ---------------------------------------------------------------------------
COMMANDS = {
    "search": cmd_search,
    "entities": cmd_entities,
    "add": cmd_add,
}


async def handle_request(line):
    line = line.strip()
    if not line:
        return None
    if line == "PING":
        return "PONG\n"

    try:
        req = json.loads(line)
    except json.JSONDecodeError as e:
        return json.dumps({"id": None, "ok": False, "error": f"Invalid JSON: {e}"}) + "\n"

    req_id = req.get("id")
    cmd = req.get("cmd")
    args = req.get("args", {})
    tenant_id = args.pop("tenantId", "master")

    handler = COMMANDS.get(cmd)
    if not handler:
        return json.dumps({"id": req_id, "ok": False, "error": f"Unknown command: {cmd}"}) + "\n"

    try:
        output, data = await handler(args, tenant_id)
        resp = {"id": req_id, "ok": True, "output": output}
        if data is not None:
            resp["data"] = data
        return json.dumps(resp) + "\n"
    except Exception as e:
        return json.dumps({"id": req_id, "ok": False, "error": str(e)}) + "\n"


# ---------------------------------------------------------------------------
# Main loop — reads stdin line-by-line, writes responses to stdout
# ---------------------------------------------------------------------------
async def _read_stdin_line(loop):
    """Read a line from stdin, using a thread on Windows where connect_read_pipe is unsupported."""
    return await loop.run_in_executor(None, sys.stdin.readline)


async def main():
    # Signal readiness
    sys.stdout.write("READY\n")
    sys.stdout.flush()

    loop = asyncio.get_event_loop()

    # On Unix, use asyncio StreamReader for efficient async stdin.
    # On Windows, connect_read_pipe is not supported — fall back to threaded readline.
    use_pipe_reader = sys.platform != "win32"
    reader = None

    if use_pipe_reader:
        try:
            reader = asyncio.StreamReader()
            protocol = asyncio.StreamReaderProtocol(reader)
            await loop.connect_read_pipe(lambda: protocol, sys.stdin)
        except NotImplementedError:
            reader = None
            use_pipe_reader = False

    while True:
        try:
            if use_pipe_reader:
                line_bytes = await reader.readline()
                if not line_bytes:
                    break  # EOF — parent closed stdin
                line = line_bytes.decode("utf-8", errors="replace")
            else:
                line = await _read_stdin_line(loop)
                if not line:
                    break  # EOF

            result = await handle_request(line)
            if result:
                sys.stdout.write(result)
                sys.stdout.flush()
        except Exception as e:
            sys.stderr.write(f"Daemon error: {e}\n")
            sys.stderr.flush()

    # Cleanup
    if _graphiti:
        await _graphiti.close()
    if _neo4j_driver:
        _neo4j_driver.close()


if __name__ == "__main__":
    asyncio.run(main())

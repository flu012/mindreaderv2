"""
Memory Graph CLI — lightweight interface for MindReader.
With async queue processing and duplicate caching.

Usage:
    python mg_cli.py search "query"
    python mg_cli.py add "content" --source agent [--async]
    python mg_cli.py entities --limit 50
    python mg_cli.py status
    python mg_cli.py maint stats
    python mg_cli.py maint relationships [--limit 50]
    python mg_cli.py maint scan
    python mg_cli.py maint fix [--dry-run]
    python mg_cli.py maint recategorize [--scope other] [--batch-size 20]
    python mg_cli.py maint delete-other [--confirm]
"""

import argparse
import asyncio
import os
import sys
import json
import hashlib
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

# Walk up from script location to find monorepo root .env
_script_dir = Path(__file__).resolve().parent
_monorepo_root = _script_dir.parent.parent.parent  # python/ → mindgraph/ → packages/ → root
_env_path = os.getenv("MINDREADER_ROOT", str(_monorepo_root))
load_dotenv(Path(_env_path) / ".env")

from shared import make_graphiti, CACHE_FILE, QUEUE_DIR


def load_cache():
    """Load duplicate detection cache."""
    if CACHE_FILE.exists():
        try:
            with open(CACHE_FILE, 'r') as f:
                return json.load(f)
        except (json.JSONDecodeError, OSError):
            pass
    return {'entries': {}}


def save_cache(cache):
    """Save duplicate detection cache."""
    try:
        CACHE_FILE.parent.mkdir(parents=True, exist_ok=True)
        with open(CACHE_FILE, 'w') as f:
            json.dump(cache, f, indent=2)
    except Exception as e:
        print(f"Warning: Could not save cache: {e}")


def text_hash(text):
    """Generate hash for text content (128-bit collision resistance)."""
    return hashlib.sha256(text.encode()).hexdigest()[:32]


def _get_neo4j_driver():
    """Get a shared Neo4j driver instance for direct DB access commands."""
    from neo4j import GraphDatabase
    return GraphDatabase.driver(
        os.getenv("NEO4J_URI", "bolt://localhost:7687"),
        auth=(os.getenv("NEO4J_USER", "neo4j"), os.getenv("NEO4J_PASSWORD", "")),
    )


def _unique_profiles(profiles):
    """Deduplicate entity profiles by name."""
    seen, out = set(), []
    for p in profiles.values():
        if p["name"] not in seen:
            seen.add(p["name"])
            out.append(p)
    return out


async def cmd_search(args):
    """Search the knowledge graph. Supports --json for machine-readable output."""
    g = make_graphiti()
    try:
        group_ids = [args.group] if args.group else None
        results = await g.search(query=args.query, num_results=args.limit, group_ids=group_ids)
    finally:
        await g.close()

    if not results:
        if getattr(args, "json_output", False):
            print(json.dumps({"edges": [], "entities": []}))
            return
        print("No results found.")
        return

    # Collect entity UUIDs from results
    entity_uuids = set()
    for r in results:
        src = getattr(r, "source_node_uuid", None)
        tgt = getattr(r, "target_node_uuid", None)
        if src:
            entity_uuids.add(src)
        if tgt:
            entity_uuids.add(tgt)

    # Batch-fetch entity profiles from Neo4j
    profiles = {}
    if entity_uuids:
        driver = _get_neo4j_driver()
        try:
            with driver.session() as session:
                result = session.run(
                    "MATCH (e:Entity) WHERE e.uuid IN $uuids "
                    "RETURN e.uuid AS uuid, e.name AS name, e.category AS category, e.tags AS tags",
                    uuids=list(entity_uuids),
                )
                for rec in result:
                    profiles[rec["uuid"]] = {
                        "name": rec["name"] or "",
                        "category": rec["category"] or "other",
                        "tags": list(rec["tags"] or []),
                    }
        finally:
            driver.close()

    unique = _unique_profiles(profiles)

    # JSON output mode
    if getattr(args, "json_output", False):
        edges = []
        for r in results:
            edges.append({
                "name": getattr(r, "name", ""),
                "fact": getattr(r, "fact", None) or str(r),
                "source_node_uuid": getattr(r, "source_node_uuid", ""),
                "target_node_uuid": getattr(r, "target_node_uuid", ""),
            })
        print(json.dumps({"edges": edges, "entities": unique}))
        return

    # Human-readable output
    print(f"Found {len(results)} results:\n")
    for i, r in enumerate(results, 1):
        fact = getattr(r, "fact", None) or str(r)
        name = getattr(r, "name", "")
        print(f"  {i}. [{name}] {fact}")

    if unique:
        print("\nEntity profiles:")
        for p in sorted(unique, key=lambda x: x["name"]):
            tags_str = ", ".join(p["tags"]) if p["tags"] else "(no tags)"
            print(f"  - {p['name']} [{p['category']}]: {tags_str}")


async def cmd_add(args):
    """Add memory with duplicate caching, conflict detection, and auto-invalidation."""

    # === CACHE CHECK ===
    cache = load_cache()
    content_hash = text_hash(args.content)

    if content_hash in cache['entries']:
        cached_entry = cache['entries'][content_hash]
        print(f"⚠️  Duplicate detected: \"{cached_entry['preview']}...\"")
        print(f"   Original stored at: {cached_entry['created_at']}")
        return

    # === PROJECT ASSOCIATION ===
    project_content = args.content
    if args.project:
        project_content = f"{args.content}. This is related to the {args.project} project."
        print(f"📁 Associating with project: {args.project}")

    # === CONFLICT DETECTION ===
    g = make_graphiti()

    def _is_conflict(fact_text, new_text):
        """Check if two texts have enough overlap to be considered a conflict."""
        new_words = set(new_text.lower().split())
        old_words = set(fact_text.lower().split())
        overlap = len(new_words & old_words)
        shorter_len = min(len(new_words), len(old_words))
        return overlap > 25 and shorter_len > 0 and (overlap / shorter_len) > 0.4

    try:
        similar = await g.search(query=project_content, num_results=5)

        conflicting = [
            s for s in (similar or [])
            if getattr(s, "uuid", None) and _is_conflict(getattr(s, "fact", "") or str(s), project_content)
        ]

        for s in conflicting:
            fact = getattr(s, "fact", "") or str(s)
            print(f"🔄 Conflict detected with existing memory:")
            print(f"   Old: \"{fact[:80]}...\"")
            print(f"   New: \"{project_content[:80]}...\"")
            print(f"   → Old memory will be marked as invalid")

        if conflicting:
            print(f"\n⚠️  Found {len(conflicting)} conflicting memories.")
            print(f"   Proceeding to add new memory and invalidate old ones...\n")

        # === ASYNC PROCESSING ===
        if getattr(args, 'do_async', False):
            # Queue for background processing
            QUEUE_DIR.mkdir(parents=True, exist_ok=True)

            item = {
                'content': project_content,
                'source': args.source,
                'group_id': args.group or '',
                'queued_at': datetime.now(timezone.utc).isoformat(),
            }

            queue_file = QUEUE_DIR / f"memory_{datetime.now().strftime('%Y%m%d_%H%M%S')}_{content_hash}.json"
            with open(queue_file, 'w') as f:
                json.dump(item, f, indent=2)

            # Update cache immediately
            cache['entries'][content_hash] = {
                'content': project_content,
                'preview': project_content[:50],
                'created_at': datetime.now(timezone.utc).isoformat(),
                'source': args.source,
                'status': 'queued',
            }
            save_cache(cache)

            print(f"✅ Memory queued for processing (run 'mg worker' to process)")
            print(f"   Queue file: {queue_file.name}")
        else:
            # Synchronous processing (original behavior)
            await g.add_episode(
                name=f"memory-{datetime.now(timezone.utc).strftime('%Y%m%d-%H%M%S')}",
                episode_body=project_content,
                source_description=args.source,
                reference_time=datetime.now(timezone.utc),
                group_id=args.group or "",
            )

            # Update cache
            cache['entries'][content_hash] = {
                'content': project_content,
                'preview': project_content[:50],
                'created_at': datetime.now(timezone.utc).isoformat(),
                'source': args.source,
                'status': 'stored',
            }
            # Keep cache size reasonable
            if len(cache['entries']) > 1000:
                sorted_entries = sorted(cache['entries'].items(),
                                       key=lambda x: x[1]['created_at'])
                cache['entries'] = dict(sorted_entries[-500:])
            save_cache(cache)

            # Report embedding usage as JSON (for machine parsing by index.js)
            if hasattr(g.embedder, 'get_usage'):
                eu = g.embedder.get_usage()
                print(f"EMBEDDING_USAGE:{json.dumps(eu)}")

            print(f"✅ Memory stored: {project_content[:100]}...")
    finally:
        await g.close()


async def cmd_entities(args):
    driver = _get_neo4j_driver()
    try:
        with driver.session() as session:
            result = session.run(
                "MATCH (n:Entity) RETURN n.name AS name, n.summary AS summary "
                "ORDER BY n.created_at DESC LIMIT $limit",
                limit=args.limit,
            )
            entities = list(result)

        if not entities:
            print("No entities found.")
            return

        print(f"Entities ({len(entities)}):\n")
        for e in entities:
            summary = (e["summary"] or "")[:120]
            print(f"  • {e['name']}: {summary}")
    finally:
        driver.close()


async def cmd_status(args):
    """Show cache and queue status."""
    cache = load_cache()

    print("=== Memory Graph Status ===")
    print(f"Cache entries: {len(cache.get('entries', {}))}")

    if QUEUE_DIR.exists():
        pending = list(QUEUE_DIR.glob('*.json'))
        processed = list(QUEUE_DIR.glob('*.processed'))
        errors = list((QUEUE_DIR / 'error').glob('*.json')) if (QUEUE_DIR / 'error').exists() else []

        print(f"Queue pending: {len(pending)}")
        print(f"Queue processed: {len(processed)}")
        print(f"Queue errors: {len(errors)}")
    else:
        print("Queue directory: not created yet")


async def cmd_cleanup(args):
    """Clean up expired memories. Default is dry-run; use --delete to actually remove."""
    driver = _get_neo4j_driver()
    try:
        with driver.session() as session:
            # Count expired memories
            if args.expired_before:
                cutoff = args.expired_before
                result = session.run("""
                    MATCH ()-[e:RELATES_TO]->()
                    WHERE e.expired_at IS NOT NULL AND e.expired_at < datetime($cutoff)
                    RETURN count(e) AS count
                """, cutoff=cutoff)
            else:
                # Default: count all expired
                result = session.run("""
                    MATCH ()-[e:RELATES_TO]->()
                    WHERE e.expired_at IS NOT NULL
                    RETURN count(e) AS count
                """)

            expired_count = result.single()["count"]

            if expired_count == 0:
                print("✅ No expired memories to clean up.")
                return

            if not args.do_delete:
                # Default: dry-run mode
                print(f"🔍 Dry run: Found {expired_count} expired memories.")
                print(f"   Use 'mg cleanup --delete' to actually remove them.")
            else:
                # Delete expired memories
                if args.expired_before:
                    session.run("""
                        MATCH ()-[e:RELATES_TO]->()
                        WHERE e.expired_at IS NOT NULL AND e.expired_at < datetime($cutoff)
                        DELETE e
                    """, cutoff=args.expired_before)
                else:
                    session.run("""
                        MATCH ()-[e:RELATES_TO]->()
                        WHERE e.expired_at IS NOT NULL
                        DELETE e
                    """)

                print(f"✅ Cleaned up {expired_count} expired memories.")
    finally:
        driver.close()


async def cmd_projects(args):
    """List and query projects."""
    driver = _get_neo4j_driver()
    try:
        with driver.session() as session:
            if args.name:
                # Query specific project
                print(f"=== Project: {args.name} ===\n")

                # Search for project-related memories
                result = session.run("""
                    MATCH (e:Entity)
                    WHERE toLower(e.name) CONTAINS toLower($name)
                       OR toLower(e.summary) CONTAINS toLower($name)
                    RETURN e.name AS name, e.summary AS summary, e.created_at AS created_at
                    LIMIT 20
                """, name=args.name)

                entities = list(result)
                if entities:
                    print(f"📁 Related entities ({len(entities)}):")
                    for e in entities:
                        summary = e['summary'] or 'N/A'
                        print(f"  • {e['name']}: {summary[:80]}")
                else:
                    print("  No related entities found.")

                # Search for project-related facts
                result = session.run("""
                    MATCH ()-[r:RELATES_TO]->()
                    WHERE toLower(r.name) CONTAINS toLower($name)
                       OR toLower(r.fact) CONTAINS toLower($name)
                    RETURN r.name AS name, r.fact AS fact, r.valid_at AS valid_at
                    LIMIT 20
                """, name=args.name)

                facts = list(result)
                if facts:
                    print(f"\n📝 Related facts ({len(facts)}):")
                    for f in facts:
                        print(f"  [{f['name']}] {f['fact'][:80]}")
                else:
                    print("\n  No related facts found.")
            else:
                # List all projects
                print("=== All Projects ===\n")

                # Search for project entities
                result = session.run("""
                    MATCH (e:Entity)
                    WHERE toLower(e.name) CONTAINS 'project'
                       OR toLower(e.summary) CONTAINS 'project'
                    RETURN e.name AS name, e.summary AS summary
                    ORDER BY e.name
                """)

                projects = list(result)
                if projects:
                    print(f"Found {len(projects)} projects:\n")
                    for p in projects:
                        print(f"  📁 {p['name']}")
                        if p['summary']:
                            print(f"     {p['summary'][:100]}")
                        print()
                else:
                    print("  No projects found.")
                    print("\n💡 Tip: Add projects with:")
                    print("   mg add \"ProjectName is a project - description\" --source manual")
    finally:
        driver.close()


async def cmd_maint(args):
    """Maintenance commands for the knowledge graph."""
    sub = args.maint_command
    if not sub:
        print("Usage: mg maint {stats|relationships|scan|fix|recategorize|delete-other}")
        return

    driver = _get_neo4j_driver()
    try:
        if sub == "stats":
            await _maint_stats(driver)
        elif sub == "relationships":
            await _maint_relationships(driver, args)
        elif sub == "scan":
            await _maint_scan(driver)
        elif sub == "fix":
            await _maint_fix(driver, args)
        elif sub == "recategorize":
            await _maint_recategorize(driver, args)
        elif sub == "delete-other":
            await _maint_delete_other(driver, args)
        else:
            print(f"Unknown maint command: {sub}")
    finally:
        driver.close()


async def _maint_stats(driver):
    """Show category distribution and graph stats."""
    with driver.session() as session:
        result = session.run("""
            MATCH (e:Entity)
            RETURN e.category AS category, count(e) AS count
            ORDER BY count DESC
        """)
        cats = list(result)

        rel_result = session.run("MATCH ()-[r:RELATES_TO]->() RETURN count(r) AS cnt")
        rel_count = rel_result.single()["cnt"]

        ep_result = session.run("MATCH (e:Episodic) RETURN count(e) AS cnt")
        ep_count = ep_result.single()["cnt"]

    total = sum(c["count"] for c in cats)
    print("=== Knowledge Graph Stats ===\n")
    print(f"  Entities:      {total}")
    print(f"  Relationships: {rel_count}")
    print(f"  Episodes:      {ep_count}")
    print(f"\n  Category Distribution:")
    for c in cats:
        cat = c["category"] or "(uncategorized)"
        pct = (c["count"] / total * 100) if total > 0 else 0
        bar = "█" * int(pct / 2)
        print(f"    {cat:<20s} {c['count']:>4d}  {pct:5.1f}%  {bar}")


async def _maint_relationships(driver, args):
    """List all relationships."""
    limit = getattr(args, 'limit', 50) or 50
    with driver.session() as session:
        result = session.run("""
            MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
            RETURN a.name AS from, r.name AS relation, b.name AS to,
                   substring(coalesce(r.fact, ''), 0, 100) AS fact
            ORDER BY a.name
            LIMIT $limit
        """, limit=limit)
        rels = list(result)

        count_result = session.run("MATCH ()-[r:RELATES_TO]->() RETURN count(r) AS cnt")
        total = count_result.single()["cnt"]

    print(f"=== Relationships (showing {len(rels)} of {total}) ===\n")
    for r in rels:
        print(f"  {r['from']} --[{r['relation']}]--> {r['to']}")
        if r['fact']:
            print(f"    {r['fact']}")
        print()


async def _maint_scan(driver):
    """Scan relationships for structural issues."""
    with driver.session() as session:
        # Self-loops
        self_loops = list(session.run("""
            MATCH (a:Entity)-[r:RELATES_TO]->(a)
            RETURN elementId(r) AS eid, a.name AS entity, r.name AS relation
        """))

        # Long/garbage names
        long_names = list(session.run("""
            MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
            WHERE size(r.name) > 50
            RETURN elementId(r) AS eid, a.name AS from, r.name AS relation, b.name AS to
        """))

        # Exact duplicate edges
        dupes = list(session.run("""
            MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
            WITH a.name AS source, b.name AS target, r.name AS relation,
                 count(r) AS cnt, collect(elementId(r)) AS eids
            WHERE cnt > 1
            RETURN source, target, relation, cnt, eids
        """))

        # Multiple edges between same pair
        multi = list(session.run("""
            MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
            WITH a.name AS source, b.name AS target,
                 collect({relation: r.name, eid: elementId(r)}) AS edges
            WHERE size(edges) > 2
            RETURN source, target, edges
        """))

    issues = 0
    print("=== Relationship Scan Results ===\n")

    if self_loops:
        print(f"🔴 Self-Loops ({len(self_loops)}):")
        for s in self_loops:
            print(f"    {s['entity']} --[{s['relation']}]--> (self)  [eid: {s['eid']}]")
        issues += len(self_loops)
        print()

    if long_names:
        print(f"🔴 Garbage Names ({len(long_names)}):")
        for s in long_names:
            print(f"    {s['from']} --[{s['relation'][:60]}...]--> {s['to']}  [eid: {s['eid']}]")
        issues += len(long_names)
        print()

    if dupes:
        dupe_count = sum(d['cnt'] - 1 for d in dupes)
        print(f"🟡 Duplicate Edges ({dupe_count} duplicates across {len(dupes)} pairs):")
        for d in dupes:
            print(f"    {d['source']} --[{d['relation']}]--> {d['target']}  ({d['cnt']}x)")
        issues += dupe_count
        print()

    if multi:
        print(f"🔵 Multi-Edge Pairs ({len(multi)}):")
        for m in multi:
            edge_names = [e['relation'] for e in m['edges']]
            print(f"    {m['source']} ↔ {m['target']}  ({len(m['edges'])} edges: {', '.join(edge_names)})")
        print()

    if issues == 0:
        print("✅ No structural issues found.")
    else:
        print(f"Found {issues} issues. Run 'mg maint fix' to auto-fix, or 'mg maint fix --dry-run' to preview.")


async def _maint_fix(driver, args):
    """Auto-fix structural relationship issues (self-loops, garbage names, exact duplicates)."""
    dry_run = getattr(args, 'dry_run', False)

    with driver.session() as session:
        # Collect fixable issues
        self_loops = list(session.run("""
            MATCH (a:Entity)-[r:RELATES_TO]->(a)
            RETURN elementId(r) AS eid, a.name AS entity, r.name AS relation
        """))

        long_names = list(session.run("""
            MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
            WHERE size(r.name) > 50
            RETURN elementId(r) AS eid, a.name AS from, r.name AS relation, b.name AS to
        """))

        dupes = list(session.run("""
            MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
            WITH a.name AS source, b.name AS target, r.name AS relation,
                 collect(elementId(r)) AS eids
            WHERE size(eids) > 1
            RETURN source, target, relation, eids
        """))

        # Collect eids to delete
        to_delete = []
        for s in self_loops:
            to_delete.append(("self-loop", s['eid'], f"{s['entity']} --[{s['relation']}]--> (self)"))
        for s in long_names:
            to_delete.append(("garbage", s['eid'], f"{s['from']} --[{s['relation'][:40]}...]--> {s['to']}"))
        for d in dupes:
            # Keep first, delete rest
            for eid in d['eids'][1:]:
                to_delete.append(("duplicate", eid, f"{d['source']} --[{d['relation']}]--> {d['target']}"))

        if not to_delete:
            print("✅ No structural issues to fix.")
            return

        if dry_run:
            print(f"=== Dry Run: Would fix {len(to_delete)} issues ===\n")
            for issue_type, eid, desc in to_delete:
                print(f"  [{issue_type}] DELETE {desc}")
            print(f"\nRun 'mg maint fix' (without --dry-run) to apply.")
        else:
            deleted = 0
            for issue_type, eid, desc in to_delete:
                result = session.run(
                    "MATCH ()-[r:RELATES_TO]->() WHERE elementId(r) = $eid DELETE r RETURN count(r) AS cnt",
                    eid=eid
                )
                cnt = result.single()["cnt"]
                deleted += cnt
                print(f"  ✓ [{issue_type}] Deleted: {desc}")
            print(f"\n✅ Fixed {deleted} relationships.")


async def _maint_recategorize(driver, args):
    """Re-categorize entities using LLM."""
    scope = getattr(args, 'scope', 'other') or 'other'
    batch_size = getattr(args, 'batch_size', 20) or 20

    with driver.session() as session:
        # Get categories
        cat_result = session.run("MATCH (c:Category) RETURN c.key AS key, c.label AS label, c.keywords AS keywords ORDER BY c.order")
        cats = [dict(r) for r in cat_result]
        valid_keys = [c['key'] for c in cats if c['key'] != 'other']

        if not cats:
            print("❌ No categories found in database.")
            return

        # Get entities to recategorize
        if scope == "all":
            cypher = "MATCH (e:Entity) RETURN e.name AS name, e.summary AS summary, elementId(e) AS eid, e.category AS oldCat ORDER BY e.name LIMIT $limit"
        elif scope == "uncategorized":
            cypher = "MATCH (e:Entity) WHERE e.category IS NULL OR e.category = '' RETURN e.name AS name, e.summary AS summary, elementId(e) AS eid, e.category AS oldCat LIMIT $limit"
        else:
            cypher = "MATCH (e:Entity) WHERE e.category = 'other' OR e.category IS NULL OR e.category = '' RETURN e.name AS name, e.summary AS summary, elementId(e) AS eid, e.category AS oldCat LIMIT $limit"

        from neo4j import __version__ as neo4j_version
        result = session.run(cypher, limit=batch_size)
        entities = [dict(r) for r in result]

    if not entities:
        print(f"✅ No entities to recategorize (scope: {scope}).")
        return

    print(f"Recategorizing {len(entities)} entities (scope: {scope})...\n")

    # Build LLM prompt
    cat_list = "\n".join(f"- {c['key']}: {c['label']}" + (f" (e.g. {c['keywords'].split(',')[:3]})" if c.get('keywords') else "") for c in cats if c['key'] != 'other')
    entity_list = "\n".join(f"{i}. \"{e['name']}\" — {(e['summary'] or 'no summary')[:200]}" for i, e in enumerate(entities))

    prompt = f"""Categorize each entity into ONE of these categories, or "other" if none fit.

Categories:
{cat_list}
- other: Does not fit any category (noise, implementation details, UI elements, code artifacts)

Entities:
{entity_list}

Rules:
- Choose the MOST SPECIFIC category that fits
- "other" means the entity is noise and should not be in the knowledge graph
- Be precise: a "Modal dialog" is NOT a project, "TypeScript" is NOT a project
- Only use "project" for actual software projects/repos, not technologies or tools

Return ONLY a JSON array: [{{"idx": 0, "category": "person"}}, ...]"""

    # Call LLM
    try:
        from openai import OpenAI
        client = OpenAI(
            api_key=os.getenv("LLM_API_KEY"),
            base_url=os.getenv("LLM_BASE_URL"),
        )
        model = os.getenv("MG_MODEL") or os.getenv("LLM_EXTRACT_MODEL") or os.getenv("LLM_MODEL", "gpt-4o-mini")

        kwargs = dict(
            model=model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.1,
            max_tokens=2000,
            response_format={"type": "json_object"},
        )
        base_url = os.getenv("LLM_BASE_URL", "")
        if "dashscope" in base_url:
            kwargs["extra_body"] = {"enable_thinking": False}
        resp = client.chat.completions.create(**kwargs)
        text = resp.choices[0].message.content.strip()
        data = json.loads(text)
        if isinstance(data, dict):
            data = data.get("entities", data.get("results", data.get("items", [])))
        if not isinstance(data, list):
            data = []
    except Exception as e:
        print(f"❌ LLM call failed: {e}")
        return

    # Apply changes
    changes = 0
    driver2 = _get_neo4j_driver()
    try:
        with driver2.session() as session:
            for a in data:
                ent = entities[a.get("idx", -1)] if 0 <= a.get("idx", -1) < len(entities) else None
                if not ent:
                    continue
                cat = a.get("category", "")
                if not cat or cat not in [*valid_keys, "other"]:
                    continue
                if cat != (ent["oldCat"] or ""):
                    session.run(
                        "MATCH (e:Entity) WHERE elementId(e) = $eid SET e.category = $cat",
                        eid=ent["eid"], cat=cat,
                    )
                    print(f"  {ent['name']}: {ent['oldCat'] or 'none'} → {cat}")
                    changes += 1
    finally:
        driver2.close()

    print(f"\n✅ Processed {len(entities)}, changed {changes}.")


async def _maint_delete_other(driver, args):
    """Delete entities categorized as 'other' + orphaned Episodic nodes."""
    confirm = getattr(args, 'confirm', False)

    with driver.session() as session:
        other_result = session.run("MATCH (e:Entity) WHERE e.category = 'other' RETURN count(e) AS cnt")
        other_count = other_result.single()["cnt"]

        orphan_result = session.run("MATCH (ep:Episodic) WHERE NOT (ep)-[:MENTIONS]-(:Entity) RETURN count(ep) AS cnt")
        orphan_count = orphan_result.single()["cnt"]

    if other_count == 0 and orphan_count == 0:
        print("✅ Nothing to delete.")
        return

    print(f"Found:")
    print(f"  • {other_count} entities categorized as 'other'")
    print(f"  • {orphan_count} orphaned Episodic nodes")

    if not confirm:
        print(f"\n⚠️  This is irreversible. Run with --confirm to delete.")
        return

    driver2 = _get_neo4j_driver()
    try:
        with driver2.session() as session:
            if other_count > 0:
                session.run("MATCH (e:Entity) WHERE e.category = 'other' DETACH DELETE e")
                print(f"  ✓ Deleted {other_count} 'other' entities")
            if orphan_count > 0:
                session.run("MATCH (ep:Episodic) WHERE NOT (ep)-[:MENTIONS]-(:Entity) DETACH DELETE ep")
                print(f"  ✓ Deleted {orphan_count} orphaned episodes")
    finally:
        driver2.close()

    print(f"\n✅ Cleanup complete.")


def main():
    parser = argparse.ArgumentParser(description="Memory Graph CLI")
    sub = parser.add_subparsers(dest="command")

    # search
    p_search = sub.add_parser("search", help="Search knowledge graph")
    p_search.add_argument("query", help="Search query")
    p_search.add_argument("--limit", type=int, default=10)
    p_search.add_argument("--group", default="")
    p_search.add_argument("--json", dest="json_output", action="store_true",
                          help="Output structured JSON (for machine consumption)")

    # add
    p_add = sub.add_parser("add", help="Add memory")
    p_add.add_argument("content", help="Content to remember")
    p_add.add_argument("--source", default="agent")
    p_add.add_argument("--group", default="")
    p_add.add_argument("--project", dest="project", help="Associate this memory with a project")
    p_add.add_argument("--async", dest="do_async", action="store_true",
                      help="Queue for async processing instead of immediate storage")

    # entities
    p_ent = sub.add_parser("entities", help="List entities")
    p_ent.add_argument("--limit", type=int, default=50)

    # status
    p_status = sub.add_parser("status", help="Show cache and queue status")

    # cleanup
    p_cleanup = sub.add_parser("cleanup", help="Clean up expired memories")
    p_cleanup.add_argument("--expired-before", dest="expired_before",
                          help="Only delete memories expired before this date (ISO format)")
    p_cleanup.add_argument("--delete", dest="do_delete", action="store_true",
                          help="Actually delete expired memories (default: dry-run)")

    # projects
    p_projects = sub.add_parser("projects", help="List and query projects")
    p_projects.add_argument("name", nargs="?", help="Project name to query (optional)")
    p_projects.add_argument("--list", dest="do_list", action="store_true",
                          help="List all projects")

    # maint
    p_maint = sub.add_parser("maint", help="Maintenance commands")
    maint_sub = p_maint.add_subparsers(dest="maint_command")

    maint_sub.add_parser("stats", help="Show category distribution and graph stats")

    p_maint_rels = maint_sub.add_parser("relationships", help="List all relationships")
    p_maint_rels.add_argument("--limit", type=int, default=50)

    maint_sub.add_parser("scan", help="Scan relationships for structural issues")

    p_maint_fix = maint_sub.add_parser("fix", help="Auto-fix structural relationship issues")
    p_maint_fix.add_argument("--dry-run", dest="dry_run", action="store_true",
                            help="Preview fixes without applying")

    p_maint_recat = maint_sub.add_parser("recategorize", help="Re-categorize entities using LLM")
    p_maint_recat.add_argument("--scope", choices=["other", "uncategorized", "all"], default="other",
                              help="Scope: other (default), uncategorized, or all")
    p_maint_recat.add_argument("--batch-size", dest="batch_size", type=int, default=20,
                              help="Number of entities per batch (default: 20)")

    p_maint_del = maint_sub.add_parser("delete-other", help="Delete 'other' entities and orphaned episodes")
    p_maint_del.add_argument("--confirm", action="store_true",
                            help="Actually delete (default: dry-run preview)")

    args = parser.parse_args()

    if args.command == "search":
        asyncio.run(cmd_search(args))
    elif args.command == "add":
        asyncio.run(cmd_add(args))
    elif args.command == "entities":
        asyncio.run(cmd_entities(args))
    elif args.command == "status":
        asyncio.run(cmd_status(args))
    elif args.command == "cleanup":
        asyncio.run(cmd_cleanup(args))
    elif args.command == "projects":
        asyncio.run(cmd_projects(args))
    elif args.command == "maint":
        asyncio.run(cmd_maint(args))
    else:
        parser.print_help()


if __name__ == "__main__":
    main()

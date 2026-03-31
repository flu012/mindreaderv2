"""
Entity Tagger — LLM-based tag extraction for Memory Graph entities.

Used by `mg tags --backfill` to batch-tag entities.
Tags are also extracted during the auto-categorizer LLM loop in server.js.
"""

import os
import json
from neo4j import GraphDatabase


def _get_driver():
    return GraphDatabase.driver(
        os.getenv("NEO4J_URI", "bolt://localhost:7687"),
        auth=(os.getenv("NEO4J_USER", "neo4j"), os.getenv("NEO4J_PASSWORD", "")),
    )


def _build_tag_prompt(entities):
    """Build LLM prompt for tag extraction."""
    entity_list = "\n".join(
        f'{i}. "{e["name"]}" [{e["category"] or "other"}] — {(e["summary"] or "no summary")[:200]}'
        for i, e in enumerate(entities)
    )
    return f"""Extract 1-8 descriptive lowercase tags for each entity.

Tags should capture:
- Roles (engineer, swimmer, manager, owner)
- Relationships (daughter, wife, colleague)
- Skills/interests (swimming, coding)
- Locations (city, country)
- Technologies (Python, React, Docker)
- Business traits (ASX-listed, franchise)

Do not repeat the category as a tag. If the entity is noise or has no meaningful tags, return an empty array.

Entities:
{entity_list}

Return ONLY a JSON array: [{{"idx": 0, "tags": ["swimmer", "daughter"]}}, ...]"""


def _call_llm(prompt):
    """Call LLM and parse JSON array response."""
    from openai import OpenAI
    client = OpenAI(
        api_key=os.getenv("LLM_API_KEY"),
        base_url=os.getenv("LLM_BASE_URL"),
    )
    model = (os.getenv("LLM_EXTRACT_MODEL")
             or os.getenv("LLM_MODEL", "gpt-4o-mini"))
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
    return data if isinstance(data, list) else []


def tag_entities(force=False, batch_size=50, tenant_id="master"):
    """Batch-tag entities using LLM. Paginated.

    Args:
        force: If True, re-tag all entities. If False, only tag entities where tags IS NULL.
        batch_size: Number of entities per LLM batch.
        tenant_id: Tenant to filter entities by.

    Returns:
        Total number of entities tagged.
    """
    driver = _get_driver()
    total_tagged = 0
    batch_num = 0

    try:
        while True:
            batch_num += 1
            with driver.session() as session:
                if force:
                    cypher = (
                        "MATCH (e:Entity) WHERE e.tenantId = $tenantId "
                        "RETURN e.name AS name, e.summary AS summary, "
                        "e.category AS category, elementId(e) AS eid "
                        "ORDER BY e.name "
                        "SKIP $skip LIMIT $limit"
                    )
                else:
                    cypher = (
                        "MATCH (e:Entity) WHERE e.tenantId = $tenantId AND e.tags IS NULL "
                        "RETURN e.name AS name, e.summary AS summary, "
                        "e.category AS category, elementId(e) AS eid "
                        "LIMIT $limit"
                    )
                params = {"limit": batch_size, "skip": (batch_num - 1) * batch_size, "tenantId": tenant_id}
                result = session.run(cypher, params)
                entities = [dict(r) for r in result]

            if not entities:
                break

            print(f"Batch {batch_num}: tagging {len(entities)} entities...")

            prompt = _build_tag_prompt(entities)
            try:
                assignments = _call_llm(prompt)
            except Exception as e:
                print(f"  LLM call failed: {e}")
                break

            with driver.session() as session:
                for a in assignments:
                    idx = a.get("idx", -1)
                    if not (0 <= idx < len(entities)):
                        continue
                    tags = a.get("tags", [])
                    if not isinstance(tags, list):
                        continue
                    # Normalize: lowercase, deduplicate, sort
                    tags = sorted(set(t.lower().strip() for t in tags if isinstance(t, str) and t.strip()))
                    session.run(
                        "MATCH (e:Entity) WHERE elementId(e) = $eid SET e.tags = $tags",
                        eid=entities[idx]["eid"], tags=tags,
                    )
                    total_tagged += 1

            print(f"  Tagged {min(len(assignments), len(entities))} entities.")

            if len(entities) < batch_size:
                break  # Last page
    finally:
        driver.close()

    return total_tagged

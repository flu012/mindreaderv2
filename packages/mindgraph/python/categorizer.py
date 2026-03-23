"""
Entity Categorizer — shared keyword-based classification for Memory Graph.

Mirrors the categorizeEntity() logic in MindReader server.js.
Used as post-hook after Graphiti add_episode() to write `category` field.
"""

import json
import urllib.request
from neo4j import GraphDatabase

# Default keyword rules (fallback if MindReader API unavailable)
DEFAULT_RULES = [
    ("person", ["person", "wife", "husband", "engineer", "developer", "daughter", "son",
                "child", "married", "family", "colleague", "human", "lives in"]),
    ("project", ["project", "is a project"]),
    ("location", ["city", "country", "region", "address", "located in", "based in",
                  "new zealand", "auckland", "wellington", "sydney", "australia", "china",
                  "singapore", "indonesia", "office", "building", "island", "street",
                  "suburb", "district", "province"]),
    ("infrastructure", ["infrastructure", "database", "server", "container", "docker",
                        "logging", "payment", "deploy", "hosting", "neo4j", "sql server",
                        "seq", "stripe", "nginx", "iis", "service bus"]),
    ("agent", ["agent", "bot", "assistant", "monday", "tuesday", "wednesday",
               "thursday", "friday", "saturday", "sunday"]),
    ("companies", ["company", "organisation", "ltd"]),
]

_cached_rules = None


def _fetch_rules_from_api(api_url="http://localhost:18900/api/categories"):
    """Try to fetch category rules from MindReader API."""
    global _cached_rules
    if _cached_rules is not None:
        return _cached_rules
    try:
        resp = urllib.request.urlopen(api_url, timeout=3)
        categories = json.loads(resp.read())
        rules = []
        for cat in sorted(categories, key=lambda c: c.get("order", 99)):
            if cat["key"] == "other":
                continue
            keywords = [kw.strip().lower() for kw in (cat.get("keywords", "") or "").split(",") if kw.strip()]
            if keywords:
                rules.append((cat["key"], keywords))
        if rules:
            _cached_rules = rules
            return rules
    except Exception:
        pass
    return DEFAULT_RULES


def categorize(name: str, summary: str) -> str:
    """Categorize an entity by name and summary using keyword matching."""
    rules = _fetch_rules_from_api()
    combined = f"{(name or '').lower()} {(summary or '').lower()}"
    for key, keywords in rules:
        if any(kw in combined for kw in keywords):
            return key
    return "other"


def categorize_new_entities(neo4j_uri: str, neo4j_user: str, neo4j_password: str):
    """Find entities with NULL/empty category and assign categories.

    Call this after add_episode() to categorize newly created entities.
    Uses sync Neo4j driver. Returns number of entities categorized.
    """
    driver = GraphDatabase.driver(neo4j_uri, auth=(neo4j_user, neo4j_password))
    count = 0
    try:
        with driver.session() as session:
            result = session.run(
                "MATCH (e:Entity) WHERE e.category IS NULL OR e.category = '' "
                "RETURN e.name AS name, e.summary AS summary, elementId(e) AS eid"
            )
            records = list(result)

            for rec in records:
                cat = categorize(rec["name"], rec["summary"])
                session.run(
                    "MATCH (e:Entity) WHERE elementId(e) = $eid SET e.category = $cat",
                    eid=rec["eid"], cat=cat
                )
                count += 1
    finally:
        driver.close()
    return count

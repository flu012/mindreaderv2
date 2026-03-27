# Direct Entity API

Create and update entities directly in Neo4j without LLM processing. Designed for systems that require precise, deterministic memory management.

## Endpoint

```
POST /api/entities
```

**Authentication:** Bearer token (if `apiToken` is configured).

## Request

```json
{
  "entities": [
    {
      "name": "string (required)",
      "summary": "string (optional)",
      "category": "string (optional, defaults to 'other')",
      "tags": ["string array (optional)"],
      "relationships": [
        {
          "target": "string (required) — name of the target entity",
          "type": "string (required) — relationship type (e.g. 'works_at')",
          "fact": "string (optional) — human-readable description"
        }
      ]
    }
  ]
}
```

### Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `name` | string | Yes | Entity name. Used as the primary identifier (case-insensitive matching). |
| `summary` | string | No | Description of the entity. Appended on upsert (max 2000 chars). |
| `category` | string | No | Entity category (e.g. `person`, `project`, `company`, `location`). Defaults to `other`. |
| `tags` | string[] | No | Lowercase descriptive tags. Merged with existing tags on upsert. |
| `relationships` | object[] | No | Array of relationships to create from this entity to other entities. |

### Relationship Fields

| Field | Type | Required | Description |
|---|---|---|---|
| `target` | string | Yes | Name of the target entity. Auto-created if it doesn't exist. |
| `type` | string | Yes | Relationship type (e.g. `works_at`, `leads`, `part_of`, `depends_on`). |
| `fact` | string | No | Human-readable description. Defaults to `"{source} {type} {target}"`. |

### Limits

- Maximum **100 entities** per request.
- Summary capped at **2000 characters** per entity.

### Upsert Behavior

When an entity with the same name already exists (case-insensitive match):
- **Tags** are merged (union of existing + new, deduplicated)
- **Summary** is appended with `. ` separator
- **Category** is updated only if provided in the request

## Response

```json
{
  "created": 2,
  "updated": 1,
  "relationships": 3,
  "errors": [],
  "entities": [
    { "name": "Alice Chen", "status": "created" },
    { "name": "Acme Corp", "status": "updated" },
    { "name": "Payments Team", "status": "created" }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `created` | number | Number of new entities created |
| `updated` | number | Number of existing entities updated |
| `relationships` | number | Number of relationship edges created |
| `errors` | object[] | Per-entity errors (entity name + error message) |
| `entities` | object[] | Per-entity status (`created` or `updated`) |

## Examples

### Create a single entity

```bash
curl -X POST http://localhost:18900/api/entities \
  -H "Content-Type: application/json" \
  -d '{
    "entities": [
      {
        "name": "Alice Chen",
        "summary": "Senior engineer, leads the payments team",
        "category": "person",
        "tags": ["engineer", "team-lead", "payments"]
      }
    ]
  }'
```

### Create entities with relationships

```bash
curl -X POST http://localhost:18900/api/entities \
  -H "Content-Type: application/json" \
  -d '{
    "entities": [
      {
        "name": "Alice Chen",
        "summary": "Senior engineer at Acme Corp",
        "category": "person",
        "tags": ["engineer", "senior"],
        "relationships": [
          {
            "target": "Acme Corp",
            "type": "works_at",
            "fact": "Alice Chen is a senior engineer at Acme Corp"
          },
          {
            "target": "Payments Team",
            "type": "leads",
            "fact": "Alice leads the payments team"
          }
        ]
      },
      {
        "name": "Acme Corp",
        "summary": "Technology company specializing in fintech",
        "category": "company",
        "tags": ["fintech", "tech"]
      }
    ]
  }'
```

Response:
```json
{
  "created": 3,
  "updated": 0,
  "relationships": 2,
  "errors": [],
  "entities": [
    { "name": "Alice Chen", "status": "created" },
    { "name": "Acme Corp", "status": "created" }
  ]
}
```

Note: `Payments Team` was auto-created as a relationship target (3 entities created total).

### Update an existing entity (upsert)

```bash
curl -X POST http://localhost:18900/api/entities \
  -H "Content-Type: application/json" \
  -d '{
    "entities": [
      {
        "name": "Alice Chen",
        "summary": "Promoted to engineering manager in Q1 2026",
        "tags": ["manager"]
      }
    ]
  }'
```

Response:
```json
{
  "created": 0,
  "updated": 1,
  "relationships": 0,
  "errors": [],
  "entities": [
    { "name": "Alice Chen", "status": "updated" }
  ]
}
```

Alice's tags are now `["engineer", "senior", "manager"]` and her summary has the new text appended.

### Batch import from a system

```bash
curl -X POST http://localhost:18900/api/entities \
  -H "Content-Type: application/json" \
  -d '{
    "entities": [
      {
        "name": "ProjectX",
        "summary": "Internal billing system rewrite",
        "category": "project",
        "tags": ["billing", "rewrite", "q1-2026"],
        "relationships": [
          { "target": "Alice Chen", "type": "led_by" },
          { "target": "React", "type": "uses" },
          { "target": "PostgreSQL", "type": "uses" }
        ]
      },
      {
        "name": "React",
        "category": "technology",
        "tags": ["frontend", "javascript"]
      },
      {
        "name": "PostgreSQL",
        "category": "infrastructure",
        "tags": ["database", "sql"]
      }
    ]
  }'
```

### With authentication

```bash
curl -X POST http://localhost:18900/api/entities \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-token" \
  -d '{
    "entities": [
      { "name": "Bob", "category": "person", "tags": ["contractor"] }
    ]
  }'
```

## Error Handling

### Validation errors (400)

```json
{
  "error": "Entity at index 0 is missing a 'name' field."
}
```

### Partial failures

If some entities succeed and others fail, the response includes both:

```json
{
  "created": 2,
  "updated": 0,
  "relationships": 0,
  "errors": [
    { "name": "Bad Entity", "error": "Neo4j constraint violation: ..." }
  ],
  "entities": [
    { "name": "Good Entity 1", "status": "created" },
    { "name": "Good Entity 2", "status": "created" }
  ]
}
```

## Use Cases

- **System integrations** — import entities from CRM, project trackers, or HR systems
- **Seeding** — pre-populate the knowledge graph with known entities before using LLM capture
- **Corrections** — update entity details precisely without relying on LLM interpretation
- **Automation** — scripts that maintain the knowledge graph programmatically
- **Migration** — import data from other memory systems

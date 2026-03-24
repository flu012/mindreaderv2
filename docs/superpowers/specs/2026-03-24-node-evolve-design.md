# Node Evolve — Design Spec

## Goal

Add a "Node Evolve" feature that lets users expand their knowledge graph by researching any entity via an LLM with web search capability. The system analyzes the entity's existing connections, searches the internet for more information, and presents discovered entities and relationships for user review before saving to the graph.

## Architecture

New backend endpoints for evolution (SSE streaming + save), a new React modal component for the evolution UI, and a configuration extension for a dedicated evolve LLM model. The feature uses Server-Sent Events for real-time streaming of discovered entities as the LLM responds. The backend uses the `openai` npm package directly (not the Python subprocess pattern used by other endpoints) to enable native streaming support.

## Constraints

- Single LLM call per evolution (no multi-step pipeline)
- Evolve model configured separately (`LLM_EVOLVE_MODEL`) since it requires web search capability
- Reuses existing `LLM_API_KEY` and `LLM_BASE_URL` — no separate credentials
- Entities with duplicate names are skipped on save (case-insensitive comparison via `toLower`)
- All evolved entities tagged with `source:evolve` and `evolved-from:<target-name>` for traceability
- Only one evolution can run at a time (Evolve button disabled globally while in progress)
- Dashscope/Qwen models require `extra_body: { enable_thinking: false }` to avoid injecting thinking tokens into the stream

---

## 1. Configuration

**File:** `packages/mindreader-ui/server/config.js`

### 1.1 New Environment Variable

```env
LLM_EVOLVE_MODEL=qwen3.5-flash
```

Add `LLM_EVOLVE_MODEL` to config, defaulting to `LLM_MODEL` if not set (same pattern as `LLM_EXTRACT_MODEL`):

```js
evolveModel: process.env.LLM_EVOLVE_MODEL || llmModel
```

### 1.2 Setup Wizard

**File:** `scripts/setup.sh`

Add an optional question after the main LLM provider selection:

> "Which model should be used for Node Evolve? (needs web search capability, default: same as LLM model)"

Write `LLM_EVOLVE_MODEL` to `.env` if the user provides a value.

### 1.3 .env.example

Add `LLM_EVOLVE_MODEL` with a comment:

```env
# LLM_EVOLVE_MODEL=qwen3.5-flash    # Model with web search for Node Evolve (defaults to LLM_MODEL)
```

## 2. Backend API

**File:** `packages/mindreader-ui/server/server.js`

### 2.1 POST /api/entity/:name/evolve (SSE Streaming)

**Request body:**
```json
{
  "focusQuestion": "optional user-typed question"
}
```

**Note on SSE with POST:** The native browser `EventSource` API only supports GET. Since this endpoint accepts a POST body, the frontend uses `fetch()` with a `ReadableStream` reader to consume the SSE stream manually. This is a standard pattern — parse `data:` lines from the response stream.

**LLM SDK:** Uses the `openai` npm package directly from Node.js (not the Python subprocess pattern used by other endpoints). This enables native `stream: true` with async iteration. Add `openai` as a dependency to `packages/mindreader-ui/package.json`.

For Dashscope/Qwen models (detected by checking if `LLM_BASE_URL` contains "dashscope"), pass `extra_body: { enable_thinking: false }` to prevent thinking tokens from polluting the stream.

**Processing steps:**

1. Fetch the target entity from Neo4j (name, summary, category, tags)
2. Fetch all connected entities and relationships (both directions)
3. Build a prompt containing:
   - Entity profile (name, summary, category, tags)
   - All connected nodes and relationship facts
   - Optional focus question (or "Research broadly" if empty)
   - Instructions to search the web and output structured results
4. Call the evolve LLM model with `stream: true` via the `openai` npm SDK
5. Stream response back to client via SSE
6. On client disconnect (`req.on('close')`), abort the LLM request to stop token consumption

**Prompt template:**

The prompt instructs the LLM to:
- Use its web search capability to research the entity
- Output discovered entities and relationships in a line-delimited tagged format
- Each entity line: `[ENTITY] {"name": "...", "category": "...", "summary": "...", "tags": [...]}`
- Each relationship line: `[REL] {"source": "...", "target": "...", "label": "short_label", "fact": "Full sentence describing the relationship"}`
- The `source` is the entity performing the action, `target` is the entity being acted upon (directional)
- Free text between markers is allowed (reasoning/commentary)

**SSE event types:**

| Event | Data | When |
|-------|------|------|
| `token` | `{ text: "..." }` | Each raw text chunk from LLM stream |
| `entity` | `{ name, category, summary, tags }` | When a complete `[ENTITY]` line is parsed |
| `relationship` | `{ source, target, label, fact }` | When a complete `[REL]` line is parsed |
| `done` | `{ totalTokens, promptTokens, completionTokens, entityCount, relationshipCount }` | Stream complete |
| `error` | `{ message: "..." }` | On failure |

**Streaming parser:**

The backend buffers incoming text chunks. When it detects a complete line starting with `[ENTITY]` or `[REL]`, it parses the JSON and emits the corresponding SSE event. All other text is emitted as `token` events for the live feed. Malformed lines are emitted as `token` events and skipped for entity extraction.

**Token tracking:**

After streaming completes, create a `:TokenUsage` node in Neo4j:
```cypher
CREATE (t:TokenUsage {
  date: date(),
  model: $model,
  promptTokens: $promptTokens,
  completionTokens: $completionTokens,
  totalTokens: $totalTokens,
  operation: "evolve",
  timestamp: datetime()
})
```

### 2.2 POST /api/entity/:name/evolve/save

**Request body:**
```json
{
  "entities": [
    { "name": "...", "category": "...", "summary": "...", "tags": ["..."] }
  ],
  "relationships": [
    { "source": "...", "target": "...", "fact": "..." }
  ]
}
```

**Processing:**

1. For each entity:
   - Check if an entity with the same name already exists (case-insensitive: `toLower(e.name) = toLower($name)`)
   - If exists: skip, add to `skipped` list
   - If new: create `:Entity` node with properties + append `source:evolve` and `evolved-from:<target-name>` to tags
2. For each relationship:
   - Create `:RELATES_TO` edge between source and target (match by case-insensitive name)
   - Properties: `name` (from the `label` field in the LLM output), `fact`, `created_at`
   - If either source or target doesn't exist in the graph (was unchecked and not pre-existing), skip the relationship
3. Return summary:

```json
{
  "entitiesCreated": 4,
  "entitiesSkipped": 1,
  "relationshipsCreated": 7,
  "skippedNames": ["Existing Entity"]
}
```

## 3. Evolution Modal UI

**File:** New `packages/mindreader-ui/ui/src/components/EvolveModal.jsx`

### 3.1 Trigger

New "Evolve" button in `DetailPanel.jsx` action bar, alongside Merge, Link, Delete. Clicking opens the `EvolveModal` component.

Style: uses `--accent-cyan` to match the evolve/discovery theme. Icon: ✨ or similar.

### 3.2 Modal Layout

Large modal overlay (80% viewport width, 80% viewport height):

```
┌─────────────────────────────────────────────────┐
│  ✨ Evolve: Aria Lu                         [×] │
├────────────────────────────┬────────────────────┤
│                            │                    │
│   Left side (55%):         │   Right side (45%):│
│   Mini force-directed      │   Stream feed      │
│   graph                    │                    │
│                            │   - LLM text       │
│   Target node (center,     │     streaming in   │
│   highlighted, larger)     │   - Entity cards   │
│                            │     with checkboxes│
│   Discovered nodes appear  │     appearing as   │
│   around it with edges     │     extracted      │
│   as they're extracted     │   - Relationship   │
│                            │     cards with     │
│   Category-colored nodes   │     checkboxes     │
│   matching main graph      │                    │
│                            │                    │
├────────────────────────────┴────────────────────┤
│  Tokens: 1,247 ↑   Entities: 5   Rels: 8       │
├─────────────────────────────────────────────────┤
│  [Focus question input...]          [▶ Evolve]  │
│                                                 │
│  After streaming:                               │
│  [Save All (5)]  [Save Selected (3/5)]  [Cancel]│
└─────────────────────────────────────────────────┘
```

### 3.3 Three Phases

**Phase 1 — Input:**
- Modal opens with focus question text field
- Placeholder: "Leave blank for broad research, or type a focus question..."
- "Evolve" button to start
- Close button [×] to cancel

**Phase 2 — Streaming:**
- Left: Mini Sigma.js graph. Target node appears centered and large (glowing border). As `entity` SSE events arrive, nodes animate into the graph with edges from `relationship` events.
- Right: Scrolling feed showing raw LLM text interspersed with styled entity/relationship cards. Each card has a checkbox (checked by default).
- Footer: Entity and relationship counts ticking up (token count appears only after stream completes).
- Evolve button disabled. Close button shows "Stop" to abort the stream.

**Phase 3 — Review:**
- Streaming complete. User can scroll through the right panel and uncheck unwanted items. Unchecked entities also grey out in the mini-graph.
- Footer shows two buttons:
  - **"Save All (N)"** — primary button, saves everything
  - **"Save Selected (X/N)"** — secondary button, saves only checked items (shown when any items are unchecked)
- **"Cancel"** — closes modal without saving
- After save: brief summary toast ("Created 4 entities, 7 relationships"), modal closes, main graph refreshes.

### 3.4 Mini-Graph

Uses a lightweight Sigma.js instance (separate from the main graph) with:
- ForceAtlas2 layout for auto-positioning (new dependency: `graphology-layout-forceatlas2`)
- Target node: centered, larger size, distinct glow/border
- Discovered nodes: category-colored (same palette as main graph), appear with entrance animation
- Edges: labeled with relationship label (truncated)
- No interactivity needed (no click, no hover) — purely visual

### 3.5 Stream Feed Cards

**Entity card:**
```
┌─────────────────────────────────┐
│ [✓] 🏢 Swim NZ                 │
│     organization                │
│     National swimming body...   │
│     swimmer · sports-org        │
└─────────────────────────────────┘
```

**Relationship card:**
```
┌─────────────────────────────────┐
│ [✓] Aria Lu —member_of→ Swim NZ│
│     "Aria is a registered..."   │
└─────────────────────────────────┘
```

### 3.6 Error Handling & Abort

- If the SSE connection fails or LLM errors: show error message in the stream feed, enable "Retry" button
- If malformed lines appear in stream: show as raw text with a small ⚠️ badge, skip for entity extraction
- If save fails: show error toast, keep modal open so user can retry
- **Stop/abort:** During streaming, the close button shows "Stop". Clicking it aborts the `fetch()` request via `AbortController`. The backend detects the closed connection via `req.on('close')` and aborts the OpenAI stream to stop consuming tokens. Any entities/relationships already parsed are kept in the review panel — user can still save partial results.

## 4. Data Persistence & Tagging

### 4.1 Source Tags

Every entity created via evolve gets two extra tags appended:
- `source:evolve` — identifies all evolved entities
- `evolved-from:<target-name>` — links back to the originating entity (lowercase, e.g., `evolved-from:aria lu`)

These are added server-side in the `/evolve/save` endpoint, not by the LLM.

### 4.2 Duplicate Handling

If an entity with the same name already exists in Neo4j:
- The entity is **skipped** (not overwritten or merged)
- Relationships pointing to/from it are still created (connecting to the existing entity)
- The save response includes `skippedNames` so the UI can inform the user

### 4.3 Finding Evolved Entities

Users can search `source:evolve` in the global search bar to find all entities created by evolution, or `evolved-from:aria lu` to find everything discovered from a specific node. This works because the tag-aware search (from the entity-tags feature) matches these tags.

## 5. Prompt Design

The prompt sent to the evolve LLM:

```
You are a knowledge graph researcher. Your task is to research an entity and discover new related entities and relationships.

## Target Entity
Name: {name}
Category: {category}
Summary: {summary}
Tags: {tags}

## Known Connections
{for each connected entity and relationship:}
- {relationship.fact} → {connected.name} ({connected.category}): {connected.summary}

## Task
{if focusQuestion:}
Research focus: {focusQuestion}
{else:}
Research this entity broadly. Discover important facts, related people, organizations, events, locations, and other entities.
{/if}

Search the web for current information about this entity. Then output your discoveries in this exact format:

For each new entity you discover, output on its own line:
[ENTITY] {"name": "Entity Name", "category": "person|organization|project|location|event|concept|tool|other", "summary": "One sentence description", "tags": ["tag1", "tag2"]}

For each relationship between entities, output on its own line:
[REL] {"source": "Source Entity", "target": "Target Entity", "label": "short_label", "fact": "Describes the relationship in a full sentence"}

The "source" is the entity performing the action, "target" is the entity being acted upon (e.g., source: "Aria Lu", target: "Swim NZ", label: "member_of", fact: "Aria Lu is a registered member of Swim NZ").

You may include reasoning text between these lines. Aim for 3-10 entities and their relationships. Do not rediscover entities that are already in the Known Connections section. Entity names should be proper nouns or specific names, not generic descriptions.
```

## 6. Token Display

### 6.1 Footer Counters (During Streaming)

Small unobtrusive counters in the modal footer:
```
Entities: 5   Rels: 8
```

During streaming, only entity and relationship counts are shown (these update in real-time as items are parsed). Token counts are only available after the stream completes (most OpenAI-compatible APIs only return `usage` in the final response chunk), so the token count appears in the footer only after the `done` SSE event:
```
Tokens: 1,832   Entities: 5   Rels: 8
```

### 6.2 Summary (After Save)

Brief toast notification after saving:
```
✨ Evolution complete — Created 4 entities, 7 relationships (1,832 tokens)
```

---

## File Changes Summary

| File | Change |
|------|--------|
| `packages/mindreader-ui/server/config.js` | Add `evolveModel` config from `LLM_EVOLVE_MODEL` |
| `packages/mindreader-ui/server/server.js` | Add `POST /api/entity/:name/evolve` (SSE) and `POST /api/entity/:name/evolve/save` |
| `packages/mindreader-ui/ui/src/components/EvolveModal.jsx` | New component: full evolution modal with mini-graph, stream feed, review |
| `packages/mindreader-ui/ui/src/components/DetailPanel.jsx` | Add "Evolve" button to action bar |
| `packages/mindreader-ui/ui/src/index.css` | Add evolve modal styles |
| `scripts/setup.sh` | Add optional evolve model question |
| `.env.example` | Add `LLM_EVOLVE_MODEL` |
| `packages/mindreader-ui/package.json` | Add `openai` and `graphology-layout-forceatlas2` dependencies |

## Non-Goals

- No batch evolution (evolve multiple nodes at once)
- No automatic/scheduled evolution (always user-initiated)
- No evolution history view (beyond tag-based search)
- No undo/rollback of saved evolution results
- No editing of discovered entities before save (only check/uncheck)

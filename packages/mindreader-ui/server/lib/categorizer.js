/**
 * Entity categorization module for MindReader.
 *
 * Handles:
 * - Category CRUD + caching from Neo4j
 * - Seeding default categories
 * - Keyword-based categorization (display-time fallback)
 * - LLM-powered auto-categorization of new entities (interval-based)
 */

import { query } from "../neo4j.js";
import { callLLM } from "./llm.js";
import { tenantStore, DEFAULT_TENANT, getTenantId } from "./tenant.js";

// ---------------------------------------------------------------------------
// Category cache
// ---------------------------------------------------------------------------
let cachedCategories = null;
let categoryCacheTime = 0;

async function getCategories(driver, forceRefresh = false) {
  if (!forceRefresh && cachedCategories && Date.now() - categoryCacheTime < 60000) return cachedCategories;
  try {
    const results = await query(driver, "MATCH (c:Category) RETURN c ORDER BY c.order");
    cachedCategories = results.map((r) => {
      const props = r.c.properties || r.c;
      // Convert Neo4j Integer to JS number
      const plain = {};
      for (const [k, v] of Object.entries(props)) {
        plain[k] = (v && typeof v === "object" && v.toNumber) ? v.toNumber() : v;
      }
      return plain;
    });
    categoryCacheTime = Date.now();
  } catch (err) {
    // fallback: return empty array, categorizeEntity will use hardcoded defaults
    if (!cachedCategories) cachedCategories = [];
  }
  return cachedCategories;
}

// ---------------------------------------------------------------------------
// Default category seeding
// ---------------------------------------------------------------------------

/**
 * Seed default categories if they don't exist in Neo4j.
 * Only creates categories that are missing — never overwrites user edits.
 */
async function seedDefaultCategories(driver, logger) {
  const defaults = [
    // Entity-type categories
    { key: "person", label: "Person", color: "#4aff9e", keywords: "person,wife,husband,engineer,developer,daughter,son,child,married,family,colleague,human,lives in", order: 10 },
    { key: "project", label: "Project", color: "#4a9eff", keywords: "project,is a project,repository,codebase,app,application", order: 20 },
    { key: "location", label: "Location", color: "#ffdd4a", keywords: "city,country,region,address,located in,based in,office,building,island,street,suburb,district,province", order: 30 },
    { key: "infrastructure", label: "Infrastructure", color: "#ff9e4a", keywords: "infrastructure,database,server,container,docker,logging,payment,deploy,hosting,neo4j,sql server,seq,stripe,nginx,iis,service bus,api,endpoint,domain", order: 40 },
    { key: "agent", label: "Agent", color: "#9e4aff", keywords: "agent,bot,assistant,monday,tuesday,wednesday,thursday,friday,saturday,sunday", order: 50 },
    { key: "companies", label: "Companies", color: "#ff4a9e", keywords: "company,organisation,ltd,corp,inc,business,startup", order: 60 },
    // Fact-type categories (for capture filtering)
    { key: "credential", label: "Credential", color: "#ff4a4a", keywords: "api key,password,token,secret,connection string,credential,auth", order: 70 },
    { key: "decision", label: "Decision", color: "#4affff", keywords: "decided,chose,switched,migrated,replaced,because,trade-off,why we", order: 80 },
    { key: "event", label: "Event", color: "#ffaa4a", keywords: "launched,deployed,hired,released,completed,milestone,meeting,travel", order: 90 },
    { key: "preference", label: "Preference", color: "#aa9eff", keywords: "prefers,likes,always use,never use,style,priority,workflow", order: 100 },
    { key: "procedure", label: "Procedure", color: "#9eff4a", keywords: "how to,steps to,workflow,process,run,setup,install,configure", order: 110 },
  ];

  for (const cat of defaults) {
    try {
      await query(driver,
        `MERGE (c:Category {key: $key})
         ON CREATE SET c.label = $label, c.color = $color, c.keywords = $keywords, c.order = $order`,
        cat
      );
    } catch (err) {
      logger?.warn?.(`Failed to seed category '${cat.key}': ${err.message}`);
    }
  }
  cachedCategories = null; // Invalidate cache after seeding
}

// ---------------------------------------------------------------------------
// Keyword-based categorization (display-time fallback)
// ---------------------------------------------------------------------------

/**
 * Categorize a node for color coding in the graph.
 */
function categorizeNode(node) {
  // Prefer category (updated by auto-categorizer/manual edits) over group_id (legacy Graphiti field)
  return categorizeEntity(node.name, node.summary, node.category || node.group_id);
}

function categorizeEntity(name, summary, category) {
  // Display-time fallback only — actual categorization is done by LLM via auto-categorizer
  // Only accept category if it matches a known Category key (prevents Graphiti's
  // raw group_id values like "organization", "concept" from leaking through)
  if (category && category.trim() !== "") {
    const key = category.trim().toLowerCase();
    const validKeys = cachedCategories && cachedCategories.length > 0
      ? new Set(cachedCategories.map(c => c.key))
      : new Set(["person", "project", "location", "infrastructure", "agent", "companies", "credential", "decision", "event", "preference", "procedure", "other"]);
    if (validKeys.has(key)) return key;
    // Unknown category (e.g. Graphiti's "organization", "concept") — fall through to keyword matching
  }
  name = (name || "").toLowerCase();
  summary = (summary || "").toLowerCase();
  const combined = name + " " + summary;

  // Use cached categories if available
  if (cachedCategories && cachedCategories.length > 0) {
    // Sort by order, skip "other" (handled last)
    const sorted = [...cachedCategories]
      .filter((c) => c.key !== "other")
      .sort((a, b) => (a.order || 99) - (b.order || 99));
    for (const cat of sorted) {
      if (!cat.keywords) continue;
      const keywords = cat.keywords.split(",").map((k) => k.trim()).filter(Boolean);
      if (keywords.some((kw) => combined.includes(kw))) return cat.key;
    }
    return "other";
  }

  // Hardcoded fallback when cache is not yet populated
  // Must match seedDefaultCategories — sorted by order
  const fallback = [
    ["person", ["person", "wife", "husband", "engineer", "developer", "daughter", "son", "child", "married", "family", "colleague", "human", "lives in"]],
    ["project", ["project", "is a project", "repository", "codebase", "app", "application"]],
    ["location", ["city", "country", "region", "address", "located in", "based in", "office", "building", "island", "street", "suburb", "district", "province"]],
    ["infrastructure", ["infrastructure", "database", "server", "container", "docker", "logging", "payment", "deploy", "hosting", "neo4j", "sql server", "seq", "stripe", "nginx", "iis", "service bus", "api", "endpoint", "domain"]],
    ["agent", ["agent", "bot", "assistant", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"]],
    ["companies", ["company", "organisation", "ltd", "corp", "inc", "business", "startup"]],
    ["credential", ["api key", "password", "token", "secret", "connection string", "credential", "auth"]],
    ["decision", ["decided", "chose", "switched", "migrated", "replaced", "because", "trade-off", "why we"]],
    ["event", ["launched", "deployed", "hired", "released", "completed", "milestone", "meeting", "travel"]],
    ["preference", ["prefers", "likes", "always use", "never use", "style", "priority", "workflow"]],
    ["procedure", ["how to", "steps to", "workflow", "process", "run", "setup", "install", "configure"]],
  ];
  for (const [key, keywords] of fallback) {
    if (keywords.some((kw) => combined.includes(kw))) return key;
  }
  return "other";
}

// ---------------------------------------------------------------------------
// LLM-powered auto-categorizer (interval-based)
// ---------------------------------------------------------------------------

/**
 * Create an auto-categorizer that periodically finds uncategorized entities
 * and uses LLM to assign categories and tags.
 *
 * @param {object} driver - Neo4j driver
 * @param {object} config - Server config (pythonPath, llmApiKey, llmBaseUrl, llmModel, llmExtractModel)
 * @param {object} [logger] - Logger instance
 * @returns {{ start(): void, stop(): void }}
 */
function createAutoCategorizer(driver, config, logger) {
  let _categorizeLock = false;
  let _initialTimeout = null;
  let _interval = null;

  async function autoCategorizeNewEntities() {
    if (_categorizeLock) return; // Prevent overlapping runs
    _categorizeLock = true;
    try {
      const cats = await getCategories(driver);
      const tenantId = getTenantId();
      const session = driver.session();
      try {
        const result = await session.run(
          `MATCH (e:Entity)
           WHERE e.tenantId = $tenantId AND (e.category IS NULL OR e.category = '' OR e.tags IS NULL)
           RETURN e.name AS name, e.summary AS summary, elementId(e) AS eid,
                  e.category AS existingCategory
           LIMIT 20`,
          { tenantId }
        );
        const uncategorized = result.records;
        if (uncategorized.length === 0) return;

        // Build entity list for LLM
        const entities = uncategorized.map((rec, i) => ({
          idx: i,
          name: rec.get("name") || "",
          summary: (rec.get("summary") || "").slice(0, 200),
          eid: rec.get("eid"),
          existingCategory: rec.get("existingCategory") || "",
        }));

        // Build category list from DB
        const validCats = cats.filter(c => c.key !== "other");
        const catList = validCats.map(c => `- ${c.key}: ${c.label}`).join("\n");
        const validKeys = validCats.map(c => c.key);

        const entityList = entities.map(e =>
          `${e.idx}. "${e.name}" — ${e.summary || "no summary"}`
        ).join("\n");

        const prompt = `Categorize each entity and extract descriptive tags.

Categories:
${catList}
- other: Does not fit any category above

For tags, extract 1-8 lowercase descriptive tags per entity covering:
- Roles (engineer, swimmer, manager, owner)
- Relationships (daughter, wife, colleague)
- Skills/interests (swimming, coding)
- Locations (city, country)
- Technologies (Python, React, Docker)
- Business traits (ASX-listed, franchise)
Do not repeat the category as a tag. If the entity is noise, use empty tags.

Entities:
${entityList}

Return ONLY a JSON array: [{"idx": 0, "category": "person", "tags": ["swimmer", "daughter"]}, ...]
The "category" field MUST be one of: ${validKeys.join(", ")}, other`;

        // Call LLM directly via callLLM()
        const llmConfig = { ...config, llmModel: config.llmExtractModel || config.llmModel };
        let assignments;
        try {
          const response = await callLLM({
            prompt,
            config: llmConfig,
            jsonMode: true,
            timeoutMs: 30000,
          });
          assignments = Array.isArray(response)
            ? response
            : (response.entities || response.results || response.items || []);
        } catch (err) {
          logger?.warn?.(`Auto-categorize LLM call failed: ${err.message}`);
          return;
        }

        if (!Array.isArray(assignments)) return;

        let count = 0;
        for (const a of assignments) {
          const entity = entities[a.idx];
          if (!entity) continue;

          const cat = a.category;
          const tags = Array.isArray(a.tags)
            ? [...new Set(a.tags.filter(t => typeof t === "string" && t.trim()).map(t => t.toLowerCase().trim()))].sort()
            : [];

          // Determine what to write
          const needsCat = !entity.existingCategory && cat && [...validKeys, "other"].includes(cat);
          // Always write tags (even []) so entities aren't re-fetched every 60s
          if (needsCat) {
            await session.run(
              `MATCH (e:Entity) WHERE elementId(e) = $eid SET e.category = $cat, e.tags = $tags`,
              { eid: entity.eid, cat, tags }
            );
          } else {
            await session.run(
              `MATCH (e:Entity) WHERE elementId(e) = $eid SET e.tags = $tags`,
              { eid: entity.eid, tags }
            );
          }
          count++;
        }
        if (count > 0) {
          logger?.info?.(`🧠 MindReader: LLM auto-categorized/tagged ${count} entities`);
        }
      } finally {
        await session.close();
      }
    } catch (err) {
      logger?.warn?.(`🧠 MindReader: auto-categorize failed: ${err.message}`);
    } finally {
      _categorizeLock = false;
    }
  }

  return {
    /** Run once after 5s delay, then every 60s */
    start() {
      _initialTimeout = setTimeout(() => {
        tenantStore.run({ tenantId: DEFAULT_TENANT }, autoCategorizeNewEntities);
      }, 5000);
      _interval = setInterval(() => {
        tenantStore.run({ tenantId: DEFAULT_TENANT }, autoCategorizeNewEntities);
      }, 60000);
    },
    /** Stop the interval and clear pending timeout */
    stop() {
      if (_initialTimeout) clearTimeout(_initialTimeout);
      if (_interval) clearInterval(_interval);
      _initialTimeout = null;
      _interval = null;
    },
  };
}

export { getCategories, seedDefaultCategories, categorizeNode, categorizeEntity, createAutoCategorizer };

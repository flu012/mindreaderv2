/**
 * Memory storage preprocessor.
 *
 * Classifies incoming facts as entity attribute updates (written directly to Neo4j)
 * vs new relationships (forwarded to Graphiti add_episode).
 *
 * Two entry points:
 *   preprocessStore(content, ...) — for /api/cli/store
 *   preprocessCapture(messages, ...) — for /api/cli/capture
 *
 * Both return a PreprocessResult: { entityUpdates, forGraphiti }
 */

import { callLLM } from "./llm.js";

// Graphiti custom_extraction_instructions — always injected as last line of defense
export const EXTRACTION_INSTRUCTIONS = `CRITICAL: Attributes are NOT entities. Do NOT create separate entity nodes for:
- Roles, job titles, occupations (e.g. "software engineer", "manager", "CEO")
- Experience levels, years of experience, seniority
- Skills, expertise, proficiencies (e.g. "React expert", "fluent in Python")
- Quantities, measurements, counts, ages
- Statuses, states, conditions (e.g. "active", "deprecated", "in progress")
- Descriptions, adjectives, characteristics (e.g. "large-scale", "high-performance")
- Dates, time periods (e.g. "2024", "last quarter")

These are ATTRIBUTES of their parent entity, not independent entities.
Capture them in the edge 'fact' field or the entity's summary instead.

Only create entity nodes for things with independent identity:
people, organizations, projects, products, technologies, places, events.

CRITICAL: When the text mentions multiple entities, ALWAYS create relationship edges between them.
For example, "Alice generated V5.2 of the Agreement" should create edges:
  Alice --[generated]--> Agreement (with fact mentioning V5.2 in the edge).
Do NOT create isolated entities — every entity must connect to at least one other entity via an edge.`;

// English stopwords to exclude from entity lookup keywords
const STOPWORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "shall", "can", "need", "dare", "ought",
  "used", "to", "of", "in", "for", "on", "with", "at", "by", "from",
  "as", "into", "through", "during", "before", "after", "above", "below",
  "between", "out", "off", "over", "under", "again", "further", "then",
  "once", "here", "there", "when", "where", "why", "how", "all", "each",
  "every", "both", "few", "more", "most", "other", "some", "such", "no",
  "nor", "not", "only", "own", "same", "so", "than", "too", "very",
  "just", "because", "but", "and", "or", "if", "while", "that", "this",
  "these", "those", "what", "which", "who", "whom", "its", "his", "her",
  "their", "our", "my", "your", "about", "also", "like", "been", "get",
  "got", "him", "her", "them", "they", "she", "he", "it", "we", "you",
]);

/**
 * Extract significant keywords from text for entity lookup.
 */
function extractKeywords(text) {
  return [...new Set(
    text.split(/[\s,.;:!?()\[\]{}"']+/)
      .map(w => w.trim())
      .filter(w => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()))
  )].slice(0, 20);
}

/**
 * Find known entities that match keywords from the input text.
 * Returns array of { name, summary, tags, category }.
 */
export async function findKnownEntities(text, driver, timeoutMs = 3000) {
  const words = extractKeywords(text);
  if (words.length === 0) return [];

  try {
    const session = driver.session();
    try {
      const result = await Promise.race([
        session.run(
          `MATCH (e:Entity)
           WHERE ANY(word IN $words WHERE toLower(e.name) CONTAINS toLower(word))
           RETURN e.name AS name, e.summary AS summary, e.tags AS tags, e.category AS category
           ORDER BY size(e.name) ASC
           LIMIT 10`,
          { words }
        ),
        new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), timeoutMs)),
      ]);
      return result.records.map(r => ({
        name: r.get("name"),
        summary: (r.get("summary") || "").slice(0, 200),
        tags: r.get("tags") || [],
        category: r.get("category") || "other",
      }));
    } finally {
      await session.close();
    }
  } catch {
    return [];
  }
}

/**
 * Build the LLM classification prompt.
 */
function buildClassifyPrompt(text, knownEntities) {
  const entityList = knownEntities.length > 0
    ? knownEntities.map(e => {
        const tags = Array.isArray(e.tags) && e.tags.length ? `. Tags: ${e.tags.join(", ")}` : "";
        return `- ${e.name} [${e.category}]: ${e.summary || "no summary"}${tags}`;
      }).join("\n")
    : "(none found)";

  return `You are a knowledge graph preprocessor. Given TEXT and a list of KNOWN ENTITIES from the graph, classify each piece of information.

KNOWN ENTITIES:
${entityList}

TEXT: "${text}"

For each fact in the text, output ONE of:
- "attribute": information that describes an existing entity (role, skill, trait, preference, status). Provide entity_name + add_tags + summary_append.
- "relationship": a connection between two entities that should be stored as a graph edge. Provide the original text.

Return JSON:
{
  "facts": [
    { "type": "attribute", "entity_name": "ExactName", "add_tags": ["lowercase-tag"], "summary_append": "Short sentence." },
    { "type": "relationship", "text": "Original text about the relationship" }
  ]
}

Rules:
- Tags must be lowercase, hyphenated, 1-3 words each
- entity_name MUST exactly match a name from KNOWN ENTITIES
- If the text mentions an entity not in KNOWN ENTITIES, classify as "relationship" (Graphiti will create the new entity)
- If the text mentions TWO OR MORE entities (known or unknown), ALWAYS classify as "relationship" — even if one entity is known
- Only use "attribute" for facts that describe a SINGLE known entity with no other entity involved (e.g. "Alice is a swimmer" → attribute of Alice)
- If the text is noise or has no meaningful facts, return {"facts": []}`;
}

/**
 * Build the merged capture prompt (extract facts + classify in one call).
 */
function buildMergedCapturePrompt(conversationText, knownEntities) {
  const entityList = knownEntities.length > 0
    ? knownEntities.map(e => {
        const tags = Array.isArray(e.tags) && e.tags.length ? `. Tags: ${e.tags.join(", ")}` : "";
        return `- ${e.name} [${e.category}]: ${e.summary || "no summary"}${tags}`;
      }).join("\n")
    : "(none found)";

  return `You are a knowledge graph preprocessor. Extract facts worth remembering long-term from this conversation, then classify each.

KNOWN ENTITIES:
${entityList}

CONVERSATION:
${conversationText}

Step 1: Extract facts worth remembering (max 10). Keep: user preferences, personal info, decisions, project status changes, workflow preferences. Ignore: code details, debugging, tool output, temporary state.

Step 2: For each fact, classify as:
- "attribute": describes an existing KNOWN ENTITY (role, skill, trait, preference). Provide entity_name + add_tags + summary_append.
- "relationship": a connection between two entities. Provide the text.

Return JSON:
{
  "facts": [
    { "type": "attribute", "entity_name": "ExactName", "add_tags": ["tag"], "summary_append": "Short sentence." },
    { "type": "relationship", "text": "Description of the relationship" }
  ]
}

Rules:
- Tags must be lowercase, hyphenated, 1-3 words each
- entity_name MUST exactly match a name from KNOWN ENTITIES
- If the text mentions an entity not in KNOWN ENTITIES, classify as "relationship"
- If the text mentions TWO OR MORE entities (known or unknown), ALWAYS classify as "relationship"
- Only use "attribute" for facts about a SINGLE known entity with no other entity involved
- If nothing is worth remembering, return {"facts": []}`;
}

/**
 * Build the two-pass extraction prompt (extract facts only, no classification).
 */
function buildExtractPrompt(conversationText) {
  return `Extract facts worth remembering long-term from this conversation. One fact per line, max 10.

Keep: user preferences, personal info, decisions, project status changes, workflow preferences, important conclusions.
Ignore: code implementation details, debugging processes, tool output, temporary state, known project structure.

CONVERSATION:
${conversationText}

Return JSON:
{
  "facts": ["fact 1", "fact 2", ...]
}

If nothing worth remembering, return {"facts": []}`;
}

/**
 * Parse LLM classification response into PreprocessResult.
 */
function parseClassifyResponse(response, source, project, knownEntityNames) {
  const result = { entityUpdates: [], forGraphiti: [] };
  const facts = response?.facts;
  if (!Array.isArray(facts)) return result;

  for (const fact of facts) {
    if (fact.type === "attribute" && fact.entity_name && knownEntityNames.has(fact.entity_name)) {
      result.entityUpdates.push({
        name: fact.entity_name,
        addTags: Array.isArray(fact.add_tags) ? fact.add_tags.map(t => String(t).toLowerCase().trim()).filter(Boolean) : [],
        summaryAppend: typeof fact.summary_append === "string" ? fact.summary_append.trim() : "",
      });
    } else if (fact.type === "relationship" && fact.text) {
      result.forGraphiti.push({ content: fact.text, source, project });
    } else if (fact.type === "attribute" && fact.entity_name && !knownEntityNames.has(fact.entity_name)) {
      // LLM classified as attribute but entity is unknown — forward to Graphiti
      // so it can create the entity WITH proper relationships
      const text = fact.summary_append
        ? `${fact.entity_name}: ${fact.summary_append}`
        : fact.entity_name;
      result.forGraphiti.push({ content: text, source, project });
    }
  }
  return result;
}

/**
 * Apply a single entity update to Neo4j (add tags + append summary).
 */
export async function applyEntityUpdate(update, driver) {
  if (!update.name) return false;
  const session = driver.session();
  try {
    // Fetch existing tags for deduplication
    const existing = await session.run(
      `MATCH (e:Entity) WHERE toLower(e.name) = toLower($name)
       RETURN e.tags AS tags, e.summary AS summary`,
      { name: update.name }
    );
    if (existing.records.length === 0) return false; // entity not found

    const oldTags = existing.records[0].get("tags") || [];
    const oldSummary = existing.records[0].get("summary") || "";

    // Deduplicate tags in JS
    const mergedTags = [...new Set([...oldTags, ...update.addTags])];

    // Append summary with separator, cap at 1000 chars
    let newSummary = oldSummary;
    if (update.summaryAppend) {
      const sep = oldSummary ? ". " : "";
      newSummary = (oldSummary + sep + update.summaryAppend).slice(0, 1000);
    }

    await session.run(
      `MATCH (e:Entity) WHERE toLower(e.name) = toLower($name)
       SET e.tags = $tags, e.summary = $summary, e.last_accessed_at = datetime()`,
      { name: update.name, tags: mergedTags, summary: newSummary }
    );
    return true;
  } finally {
    await session.close();
  }
}

/**
 * Execute a PreprocessResult: apply entity updates, then feed items to Graphiti.
 */
export async function executePreprocessResult(result, driver, mgDaemon, config, logger) {
  // 1. Apply entity updates directly to Neo4j; if entity not found, forward to Graphiti
  for (const update of result.entityUpdates) {
    try {
      const applied = await applyEntityUpdate(update, driver);
      if (applied) {
        logger?.info?.(`Preprocessor: updated ${update.name} tags=[${update.addTags}]`);
      } else {
        // Entity not found in Neo4j — forward to Graphiti so it can create it
        logger?.info?.(`Preprocessor: entity "${update.name}" not found, forwarding to Graphiti`);
        const text = update.summaryAppend
          ? `${update.name}: ${update.summaryAppend}`
          : update.name;
        result.forGraphiti.push({ content: text, source: "preprocessor-fallback" });
      }
    } catch (err) {
      logger?.warn?.(`Preprocessor: entity update failed for ${update.name}: ${err.message}`);
    }
  }

  // 2. Feed remaining items to Graphiti (with custom_extraction_instructions)
  for (const item of result.forGraphiti) {
    try {
      await mgDaemon("add", {
        content: item.content,
        source: item.source,
        project: item.project || undefined,
        custom_instructions: EXTRACTION_INSTRUCTIONS,
      }, 120000);
    } catch (err) {
      logger?.warn?.(`Preprocessor: Graphiti add failed: ${err.message}`);
    }
  }
}

/**
 * Filter conversation messages for capture preprocessing.
 * Removes tool_use/tool_result, strips <relevant-memories>, keeps user+assistant text.
 * Prioritizes recent messages (takes last N that fit within maxChars).
 */
export function filterMessages(messages, maxChars = 4000) {
  // Process all messages first, then take the LAST ones that fit
  // (recent context is more relevant for auto-capture)
  const allLines = [];

  for (const msg of (messages || [])) {
    if (!msg || typeof msg !== "object") continue;
    if (msg.role !== "user" && msg.role !== "assistant") continue;

    const content = typeof msg.content === "string"
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.filter(b => b?.type === "text").map(b => b.text).join("\n")
        : "";
    if (!content || content.length < 10) continue;

    const cleaned = content
      .replace(/<relevant-memories>[\s\S]*?<\/relevant-memories>/g, "")
      .trim();
    if (cleaned.length < 10) continue;

    allLines.push(`${msg.role}: ${cleaned.slice(0, 1000)}`);
  }

  // Take last N lines that fit within maxChars (prioritize recent messages)
  const lines = [];
  let totalLen = 0;
  for (let i = allLines.length - 1; i >= 0; i--) {
    if (totalLen + allLines[i].length > maxChars) break;
    lines.unshift(allLines[i]);
    totalLen += allLines[i].length;
  }

  return lines.join("\n");
}

// ---- Main entry points ----

/**
 * Preprocess a store request.
 * @returns {PreprocessResult}
 */
export async function preprocessStore(content, source, project, driver, config, logger) {
  const knownEntities = await findKnownEntities(content, driver);
  const knownNames = new Set(knownEntities.map(e => e.name));

  const prompt = buildClassifyPrompt(content, knownEntities);
  const response = await callLLM({ prompt, config, jsonMode: true, timeoutMs: 10000 });

  return parseClassifyResponse(response, source, project, knownNames);
}

/**
 * Preprocess a capture request.
 * @returns {PreprocessResult}
 */
export async function preprocessCapture(messages, driver, config, logger) {
  const filtered = filterMessages(messages);
  if (filtered.length < 30) return { entityUpdates: [], forGraphiti: [] };

  const knownEntities = await findKnownEntities(filtered, driver);
  const knownNames = new Set(knownEntities.map(e => e.name));
  const mode = process.env.PREPROCESS_MODE || "merged";

  if (mode === "two-pass") {
    // Step 1: extract facts
    const extractPrompt = buildExtractPrompt(filtered);
    const extracted = await callLLM({ prompt: extractPrompt, config, jsonMode: true, timeoutMs: 10000 });
    const facts = Array.isArray(extracted?.facts) ? extracted.facts : [];
    if (facts.length === 0) return { entityUpdates: [], forGraphiti: [] };

    // Step 2: classify each fact
    const combined = { entityUpdates: [], forGraphiti: [] };
    for (const fact of facts) {
      if (typeof fact !== "string" || fact.length < 10) continue;
      const classifyPrompt = buildClassifyPrompt(fact, knownEntities);
      try {
        const resp = await callLLM({ prompt: classifyPrompt, config, jsonMode: true, timeoutMs: 10000 });
        const partial = parseClassifyResponse(resp, "auto-capture", undefined, knownNames);
        combined.entityUpdates.push(...partial.entityUpdates);
        combined.forGraphiti.push(...partial.forGraphiti);
      } catch (err) {
        // Single fact classification failed, degrade: send raw to Graphiti
        combined.forGraphiti.push({ content: fact, source: "auto-capture" });
        logger?.warn?.(`Preprocessor: classify failed for fact, degrading: ${err.message}`);
      }
    }
    return combined;
  }

  // Default: merged — one LLM call for extract + classify
  const mergedPrompt = buildMergedCapturePrompt(filtered, knownEntities);
  const response = await callLLM({ prompt: mergedPrompt, config, jsonMode: true, timeoutMs: 10000 });
  return parseClassifyResponse(response, "auto-capture", undefined, knownNames);
}

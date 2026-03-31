/**
 * Direct Entity API — create/update entities without LLM processing.
 *
 * POST /api/entities — batch upsert entities with optional relationships.
 * Writes directly to Neo4j. No Graphiti, no preprocessing, no daemon.
 */
import { randomUUID } from "node:crypto";
import neo4j from "neo4j-driver";
import { query } from "../neo4j.js";
import { MAX_SUMMARY_LENGTH, MAX_DETAILS_LENGTH, MAX_DIRECT_ENTITY_BATCH } from "../lib/constants.js";
import { getTenantId } from "../lib/tenant.js";

export function registerRoutes(app, ctx) {
  const { driver, logger } = ctx;

  /**
   * POST /api/entities — Create or update entities directly.
   *
   * Body: { entities: [{ name, summary?, category?, tags?, relationships? }] }
   * Relationships: [{ target, type, fact? }]
   *
   * Upsert: if entity exists (case-insensitive name match), merge tags and
   * append summary. If new, create with all provided fields.
   */
  app.post("/api/entities", async (req, res) => {
    try {
      const { entities } = req.body || {};

      if (!Array.isArray(entities) || entities.length === 0) {
        return res.status(400).json({ error: "Request body must contain a non-empty 'entities' array." });
      }
      if (entities.length > MAX_DIRECT_ENTITY_BATCH) {
        return res.status(400).json({ error: `Batch size exceeds maximum of ${MAX_DIRECT_ENTITY_BATCH}.` });
      }

      // Validate each entity
      for (let i = 0; i < entities.length; i++) {
        const e = entities[i];
        if (!e.name || typeof e.name !== "string" || !e.name.trim()) {
          return res.status(400).json({ error: `Entity at index ${i} is missing a 'name' field.` });
        }
        if (e.tags && !Array.isArray(e.tags)) {
          return res.status(400).json({ error: `Entity '${e.name}' has invalid 'tags' (must be an array).` });
        }
        if (e.relationships && !Array.isArray(e.relationships)) {
          return res.status(400).json({ error: `Entity '${e.name}' has invalid 'relationships' (must be an array).` });
        }
        if (e.relationships) {
          for (let j = 0; j < e.relationships.length; j++) {
            const r = e.relationships[j];
            if (!r.target || typeof r.target !== "string" || !r.target.trim()) {
              return res.status(400).json({ error: `Entity '${e.name}' relationship at index ${j} is missing a 'target' field.` });
            }
            if (!r.type || typeof r.type !== "string" || !r.type.trim()) {
              return res.status(400).json({ error: `Entity '${e.name}' relationship at index ${j} is missing a 'type' field.` });
            }
          }
        }
      }

      const results = [];
      let createdCount = 0;
      let updatedCount = 0;
      let relCount = 0;
      const errors = [];

      const session = driver.session();
      try {
        const __tenantId = getTenantId();
        for (const entity of entities) {
          try {
            const name = entity.name.trim();
            const tags = (entity.tags || []).map(t => String(t).toLowerCase().trim()).filter(Boolean);
            const summary = (entity.summary || "").trim();
            const details = (entity.details || "").trim().slice(0, MAX_DETAILS_LENGTH);
            const category = (entity.category || "").toLowerCase().trim() || null;
            const now = new Date().toISOString();

            // Check if entity exists
            const existing = await session.run(
              `MATCH (e:Entity) WHERE e.tenantId = $__tenantId AND toLower(e.name) = toLower($name)
               RETURN e.uuid AS uuid, e.tags AS tags, e.summary AS summary, e.details AS details`,
              { name, __tenantId }
            );

            let status;
            if (existing.records.length > 0) {
              // Upsert: merge tags, append summary
              const oldTags = existing.records[0].get("tags") || [];
              const oldSummary = existing.records[0].get("summary") || "";
              const mergedTags = [...new Set([...oldTags, ...tags])];
              let newSummary = oldSummary;
              if (summary) {
                const sep = oldSummary ? ". " : "";
                newSummary = (oldSummary + sep + summary).slice(0, MAX_SUMMARY_LENGTH);
              }
              const oldDetails = existing.records[0].get("details") || "";
              let newDetails = details || oldDetails;

              const setClause = category
                ? "SET e.tags = $tags, e.summary = $summary, e.details = $details, e.category = $category"
                : "SET e.tags = $tags, e.summary = $summary, e.details = $details";

              await session.run(
                `MATCH (e:Entity) WHERE e.tenantId = $__tenantId AND toLower(e.name) = toLower($name) ${setClause}`,
                { name, tags: mergedTags, summary: newSummary, details: newDetails, category, __tenantId }
              );
              status = "updated";
              updatedCount++;
            } else {
              // Create new entity
              await session.run(
                `CREATE (e:Entity {
                  uuid: $uuid, name: $name, summary: $summary, details: $details,
                  category: $category, tags: $tags, tenantId: $__tenantId,
                  created_at: datetime($now), node_type: "normal",
                  strength: 1.0, last_accessed_at: datetime($now), expired_at: null
                })`,
                { uuid: randomUUID(), name, summary, details, category: category || "other", tags, now, __tenantId }
              );
              status = "created";
              createdCount++;
            }

            // Create relationships if provided
            if (entity.relationships && entity.relationships.length > 0) {
              for (const rel of entity.relationships) {
                const targetName = rel.target.trim();
                const relType = rel.type.trim();
                const fact = (rel.fact || `${name} ${relType} ${targetName}`).trim();

                // Check if target already exists (case-insensitive) before MERGE
                const existingTarget = await session.run(
                  `MATCH (t:Entity) WHERE t.tenantId = $__tenantId AND toLower(t.name) = toLower($targetName) RETURN t.name AS name LIMIT 1`,
                  { targetName, __tenantId }
                );
                const actualTargetName = existingTarget.records.length > 0
                  ? existingTarget.records[0].get("name")
                  : targetName;

                // MERGE target entity using the actual name (preserves original casing)
                await session.run(
                  `MERGE (t:Entity {name: $actualTargetName, tenantId: $__tenantId})
                   ON CREATE SET t.uuid = $uuid, t.summary = "", t.details = "",
                     t.category = "other", t.tags = [],
                     t.created_at = datetime($now), t.node_type = "normal",
                     t.strength = 1.0, t.last_accessed_at = datetime($now), t.expired_at = null`,
                  { actualTargetName, uuid: randomUUID(), now, __tenantId }
                );

                // Create the relationship
                await session.run(
                  `MATCH (a:Entity) WHERE a.tenantId = $__tenantId AND toLower(a.name) = toLower($source)
                   MATCH (b:Entity) WHERE b.tenantId = $__tenantId AND toLower(b.name) = toLower($target)
                   CREATE (a)-[:RELATES_TO {
                     name: $relType, fact: $fact, tenantId: $__tenantId,
                     created_at: datetime($now),
                     strength: 1.0, last_accessed_at: datetime($now)
                   }]->(b)`,
                  { source: name, target: targetName, relType, fact, now, __tenantId }
                );
                relCount++;
              }
            }

            results.push({ name, status });
          } catch (err) {
            errors.push({ name: entity.name, error: err.message });
            logger?.warn?.(`Direct entity error for '${entity.name}': ${err.message}`);
          }
        }
      } finally {
        await session.close();
      }

      logger?.info?.(`Direct entity: created=${createdCount} updated=${updatedCount} relationships=${relCount} errors=${errors.length}`);

      res.json({
        created: createdCount,
        updated: updatedCount,
        relationships: relCount,
        errors,
        entities: results,
      });
    } catch (err) {
      logger?.warn?.(`Direct entity endpoint error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });
}

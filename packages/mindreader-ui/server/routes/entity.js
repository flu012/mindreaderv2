/**
 * Entity routes — all /api/entity/:name routes + /api/merge + /api/link
 */
import { query, nodeToPlain, relToPlain } from "../neo4j.js";
import { reinforceEntity } from "../lib/decay.js";
import { MAX_DETAILS_LENGTH } from "../lib/constants.js";
import { callLLM } from "../lib/llm.js";

export function registerRoutes(app, ctx) {
  const { driver, config, logger, mgDaemon } = ctx;

  // Helper: build match clause that supports both uuid and name lookup
  function entityMatch(paramName = "name", alias = "e") {
    return (val) => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
      return isUuid ? `${alias}.uuid = $${paramName}` : `toLower(${alias}.name) = toLower($${paramName})`;
    };
  }

  /**
   * GET /api/entity/:name — Entity detail with all relationships
   */
  app.get("/api/entity/:name", async (req, res) => {
    try {
      const { name } = req.params;
      const match = entityMatch("name")(name);
      const matchClause = `WHERE ${match}`;

      // Get entity
      const entities = await query(driver,
        `MATCH (e:Entity) ${matchClause} AND e.tenantId = $__tenantId RETURN e LIMIT 1`,
        { name }
      );

      if (!entities.length) {
        return res.status(404).json({ error: "Entity not found" });
      }

      const entity = entities[0].e ? nodeToPlain(entities[0].e) : entities[0];

      // Get relationships (always match by uuid for precision if we have it)
      const entityUuid = entity.uuid || name;
      const rels = await query(driver,
        `MATCH (e:Entity)-[r:RELATES_TO]-(other:Entity)
         WHERE e.tenantId = $__tenantId AND e.uuid = $uuid AND r.expired_at IS NULL
         RETURN r, other,
                CASE WHEN startNode(r) = e THEN 'outgoing' ELSE 'incoming' END AS direction
         LIMIT 50`,
        { uuid: entityUuid }
      );

      const relationships = rels.map((rec) => {
        const rel = rec.r ? relToPlain(rec.r) : {};
        const otherNode = rec.other?.properties || rec.other || {};
        return {
          ...rel,
          direction: rec.direction,
          other: {
            name: otherNode.name || "unknown",
            uuid: otherNode.uuid || "",
            node_type: otherNode.node_type || "normal",
          },
        };
      });

      // Reinforce accessed entity (fire-and-forget)
      reinforceEntity(driver, name, config.memoryDecayReinforceDelta).catch(() => {});

      res.json({ entity, relationships });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/entity/:name — Update entity properties (tags, category, summary, node_type)
   */
  app.put("/api/entity/:name", async (req, res) => {
    try {
      const { name } = req.params;
      const { tags, category, summary, details, node_type, group_id } = req.body || {};

      const setClauses = [];
      const params = { name };

      if (tags !== undefined) {
        if (!Array.isArray(tags)) {
          return res.status(400).json({ error: "'tags' must be an array of strings" });
        }
        const normalized = [...new Set(tags.filter(t => typeof t === "string" && t.trim()).map(t => t.toLowerCase().trim()))].sort();
        setClauses.push("e.tags = $tags");
        params.tags = normalized;
      }
      if (category !== undefined) {
        setClauses.push("e.category = $category");
        params.category = category;
      }
      if (summary !== undefined) {
        setClauses.push("e.summary = $summary");
        params.summary = summary;
      }
      if (details !== undefined) {
        setClauses.push("e.details = $details");
        params.details = String(details).slice(0, MAX_DETAILS_LENGTH);
      }
      if (node_type !== undefined) {
        setClauses.push("e.node_type = $node_type");
        params.node_type = node_type;
      }
      if (group_id !== undefined) {
        setClauses.push("e.category = $category_legacy");
        params.category_legacy = group_id;
      }

      if (setClauses.length === 0) {
        return res.status(400).json({ error: "Nothing to update" });
      }

      const match = entityMatch("name")(name);
      const result = await query(driver,
        `MATCH (e:Entity) WHERE ${match} AND e.tenantId = $__tenantId
         SET ${setClauses.join(", ")}
         RETURN e`,
        params
      );

      if (!result.length) {
        return res.status(404).json({ error: "Entity not found" });
      }

      const entity = result[0].e ? nodeToPlain(result[0].e) : result[0];
      res.json({ entity });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/entity/:name/summarize — Summarize entity and all related nodes (all levels)
   * Uses LLM to generate a 200-word summary
   */
  app.get("/api/entity/:name/summarize", async (req, res) => {
    try {
      const { name } = req.params;
      const match = entityMatch("name", "start")(name);

      // Single efficient query: get entity + direct relationships + connected entities
      const results = await query(driver,
        `MATCH (start:Entity)
         WHERE ${match} AND start.tenantId = $__tenantId
         OPTIONAL MATCH (start)-[r:RELATES_TO]-(other:Entity)
         WHERE r.expired_at IS NULL
         WITH start,
              collect(DISTINCT {name: other.name, summary: other.summary}) AS connected,
              collect(DISTINCT {relation: r.name, fact: r.fact, otherName: other.name}) AS relFacts
         RETURN start, connected[0..30] AS connected, relFacts[0..50] AS relFacts`,
        { name }
      );

      if (!results.length) {
        return res.status(404).json({ error: "Entity not found" });
      }

      const startNode = results[0].start?.properties || {};
      const connected = results[0].connected || [];
      const relFacts = results[0].relFacts || [];

      // Build context for LLM
      const entityInfo = [
        `Entity: ${startNode.name || name}`,
        startNode.summary ? `Summary: ${startNode.summary}` : null,
        `Connected to ${connected.length} other entities.`,
      ].filter(Boolean).join("\n");

      const relInfo = relFacts.map(r =>
        `- [${r.relation}] ${r.fact || `${startNode.name} → ${r.otherName}`}`
      ).join("\n");

      const connectedInfo = connected.slice(0, 30).map(n =>
        `- ${n.name}: ${(n.summary || "").slice(0, 100)}`
      ).join("\n");

      const llmPrompt = `Summarize this knowledge graph entity and all its relationships in exactly 200 words. Write in clear, concise language that helps someone quickly understand what this entity is, what it's connected to, and why it matters.

${entityInfo}

Relationships:
${relInfo || "None"}

Connected entities:
${connectedInfo || "None"}

Write a 200-word summary:`;

      // Call LLM directly via callLLM() (plain text, not JSON)
      const llmConfig = { ...config, llmModel: config.llmExtractModel || config.llmModel };
      const generatedSummary = await callLLM({
        prompt: llmPrompt,
        config: llmConfig,
        jsonMode: false,
        timeoutMs: 120000,
        temperature: 0.3,
        maxTokens: 400,
      });

      // Save explanation to the Entity node in Neo4j (separate from summary)
      try {
        const saveMatch = entityMatch("name")(name);
        await query(driver,
          `MATCH (e:Entity)
           WHERE ${saveMatch} AND e.tenantId = $__tenantId
           SET e.explanation = $explanation, e.explanation_updated_at = datetime()`,
          { name, explanation: generatedSummary }
        );
      } catch (saveErr) {
        logger?.warn?.(`Failed to save explanation for ${name}: ${saveErr.message}`);
      }

      res.json({
        entity: startNode.name || name,
        connectedCount: connected.length,
        relationshipCount: relFacts.length,
        explanation: generatedSummary,
      });
    } catch (err) {
      logger?.error?.(`MindReader summarize error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/merge — Merge two entities (transfer all relationships, delete source)
   */
  app.post("/api/merge", async (req, res) => {
    try {
      const { keepName, mergeName, keepUuid, mergeUuid, newSummary, newGroup } = req.body;
      if (!keepName || !mergeName) return res.status(400).json({ error: "Missing keepName or mergeName" });
      // Compare by uuid if available, otherwise by name
      if (keepUuid && mergeUuid) {
        if (keepUuid === mergeUuid) return res.status(400).json({ error: "Cannot merge entity with itself" });
      } else {
        if (keepName === mergeName) return res.status(400).json({ error: "Cannot merge entity with itself" });
      }

      // Use uuid-based matching when available for precision with duplicate names
      const keepMatch = keepUuid ? "e.uuid = $keepUuid" : "e.name = $keepName";
      const mergeMatch = mergeUuid ? "e.uuid = $mergeUuid" : "e.name = $mergeName";

      // Transfer all RELATES_TO relationships from merge entity to keep entity
      const transferred = await query(driver,
        `MATCH (src:Entity WHERE ${mergeMatch} AND src.tenantId = $__tenantId)-[r:RELATES_TO]-(other:Entity)
         WHERE other.uuid <> coalesce($keepUuid, '') AND other.name <> $keepName
         WITH src, r, other,
              CASE WHEN startNode(r) = src THEN 'out' ELSE 'in' END AS dir,
              r.name AS relName, r.fact AS fact, r.created_at AS created,
              r.valid_at AS valid, r.expired_at AS expired, r.uuid AS uuid
         RETURN dir, relName, fact, other.name AS otherName, created, valid, expired, uuid`,
        { keepName, mergeName, keepUuid: keepUuid || "", mergeUuid: mergeUuid || "" }
      );

      let count = 0;
      for (const t of transferred) {
        const newFact = (t.fact || "").replace(new RegExp(mergeName, "gi"), keepName);
        if (t.dir === "out") {
          await query(driver,
            `MATCH (k:Entity WHERE ${keepMatch} AND k.tenantId = $__tenantId), (o:Entity {name: $otherName})
             WHERE o.tenantId = $__tenantId
             CREATE (k)-[:RELATES_TO {name: $relName, fact: $fact, created_at: datetime(), uuid: randomUUID(), group_id: "", episodes: [], strength: 1.0, last_accessed_at: datetime()}]->(o)`,
            { keepName, keepUuid: keepUuid || "", otherName: t.otherName, relName: t.relName, fact: newFact }
          );
        } else {
          await query(driver,
            `MATCH (o:Entity {name: $otherName}), (k:Entity WHERE ${keepMatch} AND k.tenantId = $__tenantId)
             WHERE o.tenantId = $__tenantId
             CREATE (o)-[:RELATES_TO {name: $relName, fact: $fact, created_at: datetime(), uuid: randomUUID(), group_id: "", episodes: [], strength: 1.0, last_accessed_at: datetime()}]->(k)`,
            { keepName, keepUuid: keepUuid || "", otherName: t.otherName, relName: t.relName, fact: newFact }
          );
        }
        count++;
      }

      // Update summary/group if provided
      if (newSummary !== undefined || newGroup) {
        const sets = [];
        const params = { keepName, keepUuid: keepUuid || "" };
        if (newSummary !== undefined) { sets.push("e.summary = $summary"); params.summary = newSummary; }
        if (newGroup) { sets.push("e.category = $category"); params.category = newGroup; }
        if (sets.length > 0) {
          await query(driver, `MATCH (e:Entity WHERE ${keepMatch} AND e.tenantId = $__tenantId) SET ${sets.join(", ")}`, params);
        }
      }

      // Delete merged entity
      await query(driver, `MATCH (e:Entity WHERE ${mergeMatch} AND e.tenantId = $__tenantId) DETACH DELETE e`, { mergeName, mergeUuid: mergeUuid || "" });

      logger?.info?.(`MindReader: merged "${mergeName}" into "${keepName}" (${count} rels transferred)`);
      res.json({ ok: true, kept: keepName, deleted: mergeName, transferred: count });
    } catch (err) {
      logger?.error?.(`Merge error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/link — Create a new relationship between two entities
   */
  app.post("/api/link", async (req, res) => {
    try {
      const { sourceName, targetName, sourceUuid, targetUuid, relationName, fact } = req.body;
      if (!sourceName || !targetName || !relationName) {
        return res.status(400).json({ error: "Missing sourceName, targetName, or relationName" });
      }

      const sourceMatch = sourceUuid ? "s.uuid = $sourceUuid" : "s.name = $sourceName";
      const targetMatch = targetUuid ? "t.uuid = $targetUuid" : "t.name = $targetName";

      // Verify both entities exist before creating the link
      const entities = await query(driver,
        `MATCH (s:Entity WHERE ${sourceMatch} AND s.tenantId = $__tenantId), (t:Entity WHERE ${targetMatch} AND t.tenantId = $__tenantId)
         RETURN s.name AS sName, t.name AS tName`,
        { sourceName, targetName, sourceUuid: sourceUuid || "", targetUuid: targetUuid || "" }
      );
      if (!entities.length) {
        return res.status(404).json({ error: "One or both entities not found" });
      }

      await query(driver,
        `MATCH (s:Entity WHERE ${sourceMatch} AND s.tenantId = $__tenantId), (t:Entity WHERE ${targetMatch} AND t.tenantId = $__tenantId)
         CREATE (s)-[:RELATES_TO {
           name: $relationName, fact: $fact,
           created_at: datetime(), uuid: randomUUID(),
           group_id: "", episodes: [],
           strength: 1.0, last_accessed_at: datetime()
         }]->(t)`,
        { sourceName, targetName, sourceUuid: sourceUuid || "", targetUuid: targetUuid || "", relationName, fact: fact || `${sourceName} ${relationName} ${targetName}` }
      );

      logger?.info?.(`MindReader: linked "${sourceName}" -[${relationName}]-> "${targetName}"`);
      res.json({ ok: true, source: sourceName, target: targetName, relation: relationName });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/entity/:name/delete-preview — Preview what will be affected by deleting an entity
   */
  app.get("/api/entity/:name/delete-preview", async (req, res) => {
    try {
      const { name } = req.params;
      const match = entityMatch("name")(name);

      const entity = await query(driver,
        `MATCH (e:Entity) WHERE ${match} AND e.tenantId = $__tenantId RETURN e LIMIT 1`,
        { name }
      );
      if (!entity.length) return res.status(404).json({ error: "Entity not found" });

      const rels = await query(driver,
        `MATCH (e:Entity)-[r:RELATES_TO]-(other:Entity)
         WHERE ${match} AND e.tenantId = $__tenantId AND r.expired_at IS NULL
         RETURN r.name AS relation, r.fact AS fact, other.name AS otherName,
                CASE WHEN startNode(r) = e THEN 'outgoing' ELSE 'incoming' END AS direction`,
        { name }
      );

      const episodes = await query(driver,
        `MATCH (e:Entity)-[r:MENTIONS]-(ep:Episodic)
         WHERE ${match} AND e.tenantId = $__tenantId
         RETURN count(ep) AS count`,
        { name }
      );

      res.json({
        entity: nodeToPlain(entity[0].e),
        relationships: rels.map(r => ({
          relation: r.relation,
          fact: r.fact,
          otherName: r.otherName,
          direction: r.direction,
        })),
        episodicLinks: episodes[0]?.count?.toNumber?.() || episodes[0]?.count || 0,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * DELETE /api/entity/:name — Delete an entity and all its relationships
   */
  app.delete("/api/entity/:name", async (req, res) => {
    try {
      const { name } = req.params;
      const match = entityMatch("name")(name);

      const entity = await query(driver,
        `MATCH (e:Entity) WHERE ${match} AND e.tenantId = $__tenantId RETURN e.name AS name, e.uuid AS uuid`,
        { name }
      );
      if (!entity.length) return res.status(404).json({ error: "Entity not found" });

      const actualName = entity[0].name;

      // Count what will be deleted
      const counts = await query(driver,
        `MATCH (e:Entity {name: $name})
         WHERE e.tenantId = $__tenantId
         OPTIONAL MATCH (e)-[r]-()
         RETURN count(r) AS relCount`,
        { name: actualName }
      );

      const relCount = counts[0]?.relCount?.toNumber?.() || counts[0]?.relCount || 0;

      // DETACH DELETE removes node + all relationships
      await query(driver, `MATCH (e:Entity {name: $name}) WHERE e.tenantId = $__tenantId DETACH DELETE e`, { name: actualName });

      logger?.info?.(`MindReader: deleted entity "${actualName}" (${relCount} relationships removed)`);
      res.json({ ok: true, deleted: actualName, relationshipsRemoved: relCount });
    } catch (err) {
      logger?.error?.(`Delete error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/entity/:name/summary — Update entity summary (user-editable, legacy)
   */
  app.put("/api/entity/:name/summary", async (req, res) => {
    try {
      const { name } = req.params;
      const { summary } = req.body;
      if (summary == null) return res.status(400).json({ error: "Missing summary" });

      const match = entityMatch("name")(name);
      await query(driver,
        `MATCH (e:Entity)
         WHERE ${match} AND e.tenantId = $__tenantId
         SET e.summary = $summary`,
        { name, summary }
      );

      res.json({ ok: true, entity: name, summary });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * PUT /api/entity/:name/details — Update entity details (manual edit)
   */
  app.put("/api/entity/:name/details", async (req, res) => {
    try {
      const { name } = req.params;
      const { details } = req.body || {};
      if (typeof details !== "string") {
        return res.status(400).json({ error: "Missing 'details' string in body" });
      }
      const trimmed = details.slice(0, MAX_DETAILS_LENGTH);
      const match = entityMatch("name")(name);
      await query(driver,
        `MATCH (e:Entity) WHERE ${match} AND e.tenantId = $__tenantId
         SET e.details = $details, e.last_accessed_at = datetime()`,
        { name, details: trimmed }
      );
      res.json({ ok: true, details: trimmed });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

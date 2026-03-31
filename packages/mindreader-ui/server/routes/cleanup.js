/**
 * Cleanup routes — /api/cleanup/*, /api/relationships/*
 */
import neo4j from "neo4j-driver";
import { query } from "../neo4j.js";
import { callLLM } from "../lib/llm.js";
import { getTenantId } from "../lib/tenant.js";

export function registerRoutes(app, ctx) {
  const { driver, config, logger } = ctx;

  /**
   * GET /api/cleanup/scan — Scan database for issues
   */
  app.get("/api/cleanup/scan", async (req, res) => {
    try {
      const [
        duplicateEntities,
        garbageEpisodic,
        testEpisodic,
        expiredRelationships,
        duplicateRelationships,
        orphanEntities,
      ] = await Promise.all([
        // Duplicate entities: same name, multiple nodes
        query(driver,
          `MATCH (e:Entity)
           WHERE e.tenantId = $__tenantId
           WITH toLower(e.name) AS lname, collect(e.uuid) AS uuids, collect(e.summary) AS summaries, collect(e.name) AS names
           WHERE size(uuids) > 1
           RETURN names[0] AS name, size(uuids) AS count, uuids, summaries`
        ),
        // Garbage episodic nodes
        query(driver,
          `MATCH (e:Episodic)
           WHERE e.tenantId = $__tenantId
             AND (e.content STARTS WITH 'Conversation info'
              OR e.content STARTS WITH 'Note: The previous agent'
              OR e.content STARTS WITH "System: [")
           RETURN id(e) AS id, substring(e.content, 0, 100) AS content_preview,
                  e.source_description AS source, e.created_at AS created_at`
        ),
        // Test episodic nodes
        query(driver,
          `MATCH (e:Episodic)
           WHERE e.tenantId = $__tenantId
             AND e.source_description IN ['test-setup', 'test', 'performance-test', 'verification-test']
           RETURN id(e) AS id, substring(e.content, 0, 100) AS content_preview,
                  e.source_description AS source, e.created_at AS created_at`
        ),
        // Expired relationships (Graphiti-invalidated only, not decay-expired)
        query(driver,
          `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
           WHERE a.tenantId = $__tenantId AND r.expired_at IS NOT NULL AND r.strength IS NULL
           RETURN a.name AS source, r.name AS relation, b.name AS target, r.expired_at AS expired_at`
        ),
        // Duplicate relationships: same source->target with same relation name
        query(driver,
          `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
           WHERE a.tenantId = $__tenantId
           WITH a.name AS source, b.name AS target, r.name AS relation, count(r) AS cnt
           WHERE cnt > 1
           RETURN source, relation, target, cnt AS count`
        ),
        // Orphan entities: no RELATES_TO or MENTIONS relationships
        query(driver,
          `MATCH (e:Entity)
           WHERE e.tenantId = $__tenantId
             AND NOT (e)-[:RELATES_TO]-() AND NOT (e)-[:MENTIONS]-() AND NOT (e)<-[:MENTIONS]-()
           RETURN e.name AS name, e.summary AS summary, e.uuid AS uuid`
        ),
      ]);

      const summary = {
        total_issues:
          duplicateEntities.length +
          garbageEpisodic.length +
          testEpisodic.length +
          expiredRelationships.length +
          duplicateRelationships.length +
          orphanEntities.length,
        duplicate_entities: duplicateEntities.length,
        garbage_episodic: garbageEpisodic.length,
        test_episodic: testEpisodic.length,
        expired_relationships: expiredRelationships.length,
        duplicate_relationships: duplicateRelationships.length,
        orphan_entities: orphanEntities.length,
      };

      res.json({
        summary,
        details: {
          duplicate_entities: duplicateEntities,
          garbage_episodic: garbageEpisodic,
          test_episodic: testEpisodic,
          expired_relationships: expiredRelationships,
          duplicate_relationships: duplicateRelationships,
          orphan_entities: orphanEntities,
        },
      });
    } catch (err) {
      logger?.error?.(`MindReader cleanup scan error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/cleanup/execute — Execute cleanup actions
   * Body: { actions: [...], orphan_uuids: [...] }
   */
  app.post("/api/cleanup/execute", async (req, res) => {
    try {
      const { actions = [], orphan_uuids = [] } = req.body;
      if (!Array.isArray(actions) || actions.length === 0) {
        return res.status(400).json({ error: "Missing or empty 'actions' array" });
      }

      const validActions = [
        "duplicate_entities", "garbage_episodic", "test_episodic",
        "expired_relationships", "duplicate_relationships", "orphan_entities",
      ];
      const safeActions = actions.filter((a) => validActions.includes(a));
      const results = {};

      if (safeActions.includes("duplicate_entities")) {
        // For each group of duplicates, keep the earliest created, delete the rest
        const dupes = await query(driver,
          `MATCH (e:Entity)
           WHERE e.tenantId = $__tenantId
           WITH toLower(e.name) AS lname, e ORDER BY e.created_at ASC
           WITH lname, collect(e) AS nodes
           WHERE size(nodes) > 1
           UNWIND nodes[1..] AS toDelete
           DETACH DELETE toDelete
           RETURN count(toDelete) AS deleted`
        );
        results.duplicate_entities = { deleted: dupes[0]?.deleted || 0 };
      }

      if (safeActions.includes("garbage_episodic")) {
        const res2 = await query(driver,
          `MATCH (e:Episodic)
           WHERE e.tenantId = $__tenantId
             AND (e.content STARTS WITH 'Conversation info'
              OR e.content STARTS WITH 'Note: The previous agent'
              OR e.content STARTS WITH "System: [")
           DETACH DELETE e
           RETURN count(e) AS deleted`
        );
        results.garbage_episodic = { deleted: res2[0]?.deleted || 0 };
      }

      if (safeActions.includes("test_episodic")) {
        const res2 = await query(driver,
          `MATCH (e:Episodic)
           WHERE e.tenantId = $__tenantId AND e.source_description IN $sources
           DETACH DELETE e
           RETURN count(e) AS deleted`,
          { sources: ["test-setup", "test", "performance-test", "verification-test"] }
        );
        results.test_episodic = { deleted: res2[0]?.deleted || 0 };
      }

      if (safeActions.includes("expired_relationships")) {
        const res2 = await query(driver,
          `MATCH (a:Entity)-[r:RELATES_TO]->()
           WHERE a.tenantId = $__tenantId AND r.expired_at IS NOT NULL AND r.strength IS NULL
           DELETE r
           RETURN count(r) AS deleted`
        );
        results.expired_relationships = { deleted: res2[0]?.deleted || 0 };
      }

      if (safeActions.includes("duplicate_relationships")) {
        const res2 = await query(driver,
          `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
           WHERE a.tenantId = $__tenantId
           WITH a, b, r.name AS relName, collect(r) AS rels
           WHERE size(rels) > 1
           UNWIND rels[1..] AS toDelete
           DELETE toDelete
           RETURN count(toDelete) AS deleted`
        );
        results.duplicate_relationships = { deleted: res2[0]?.deleted || 0 };
      }

      if (safeActions.includes("orphan_entities")) {
        if (Array.isArray(orphan_uuids) && orphan_uuids.length > 0) {
          const res2 = await query(driver,
            `MATCH (e:Entity)
             WHERE e.tenantId = $__tenantId AND e.uuid IN $uuids
               AND NOT (e)-[:RELATES_TO]-() AND NOT (e)-[:MENTIONS]-() AND NOT (e)<-[:MENTIONS]-()
             DETACH DELETE e
             RETURN count(e) AS deleted`,
            { uuids: orphan_uuids }
          );
          results.orphan_entities = { deleted: res2[0]?.deleted || 0 };
        } else {
          results.orphan_entities = { deleted: 0, note: "No orphan_uuids provided" };
        }
      }

      // Get totals after cleanup
      const [totals] = await query(driver,
        `MATCH (n:Entity) WHERE n.tenantId = $__tenantId WITH count(n) AS entities
         OPTIONAL MATCH (ep:Episodic) WHERE ep.tenantId = $__tenantId WITH entities, count(ep) AS episodic
         OPTIONAL MATCH (a:Entity)-[r]->(b:Entity) WHERE a.tenantId = $__tenantId RETURN entities, episodic, count(r) AS relationships`
      );

      res.json({
        results,
        totals_after: {
          entities: totals?.entities || 0,
          episodic: totals?.episodic || 0,
          relationships: totals?.relationships || 0,
        },
      });
    } catch (err) {
      logger?.error?.(`MindReader cleanup execute error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/cleanup/delete-other — Delete all entities categorized as "other" + orphaned Episodic nodes
   */
  app.post("/api/cleanup/delete-other", async (req, res) => {
    try {
      const { confirm, dryRun } = req.body || {};
      const session = driver.session();
      try {
        const __tenantId = getTenantId();
        // Count "other" entities
        const countResult = await session.run(
          `MATCH (e:Entity) WHERE e.tenantId = $__tenantId AND e.category = 'other' RETURN count(e) AS cnt`,
          { __tenantId }
        );
        const otherCount = countResult.records[0]?.get("cnt")?.toNumber?.() || countResult.records[0]?.get("cnt") || 0;

        // Count orphaned Episodic nodes (direction-agnostic)
        const orphanResult = await session.run(
          `MATCH (ep:Episodic) WHERE ep.tenantId = $__tenantId AND NOT (ep)-[:MENTIONS]-(:Entity) RETURN count(ep) AS cnt`,
          { __tenantId }
        );
        const orphanCount = orphanResult.records[0]?.get("cnt")?.toNumber?.() || orphanResult.records[0]?.get("cnt") || 0;

        // Dry-run or missing confirmation: return counts only
        if (dryRun || !confirm) {
          return res.json({ dryRun: true, wouldDelete: otherCount, wouldDeleteOrphans: orphanCount });
        }

        // Confirmed: actually delete
        if (otherCount > 0) {
          await session.run(
            `MATCH (e:Entity) WHERE e.tenantId = $__tenantId AND e.category = 'other' DETACH DELETE e`,
            { __tenantId }
          );
        }

        if (orphanCount > 0) {
          await session.run(
            `MATCH (ep:Episodic) WHERE ep.tenantId = $__tenantId AND NOT (ep)-[:MENTIONS]-(:Entity) DETACH DELETE ep`,
            { __tenantId }
          );
        }

        logger?.info?.(`MindReader: deleted ${otherCount} 'other' entities, ${orphanCount} orphaned episodes`);
        res.json({ deleted: otherCount, orphansDeleted: orphanCount });
      } finally {
        await session.close();
      }
    } catch (err) {
      logger?.error?.(`MindReader delete-other error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/relationships/scan — Scan relationships for issues
   * Detects: self-loops, duplicates, long/garbage names, multiple edges between same pair
   */
  app.get("/api/relationships/scan", async (req, res) => {
    try {
      const session = driver.session();
      try {
        const __tenantId = getTenantId();
        // Run sequentially — Neo4j doesn't allow parallel queries on a single session
        const selfLoops = await session.run(
          `MATCH (a:Entity)-[r:RELATES_TO]->(a)
           WHERE a.tenantId = $__tenantId
           RETURN elementId(r) AS eid, a.name AS entity, r.name AS relation, r.fact AS fact`,
          { __tenantId }
        );
        const longNames = await session.run(
          `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
           WHERE a.tenantId = $__tenantId AND size(r.name) > 50
           RETURN elementId(r) AS eid, a.name AS from, r.name AS relation, b.name AS to, r.fact AS fact`,
          { __tenantId }
        );
        const duplicateEdges = await session.run(
          `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
           WHERE a.tenantId = $__tenantId
           WITH a.name AS source, b.name AS target, r.name AS relation, collect(elementId(r)) AS eids, collect(r.fact) AS facts
           WHERE size(eids) > 1
           RETURN source, target, relation, eids, facts`,
          { __tenantId }
        );
        const multiEdges = await session.run(
          `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
           WHERE a.tenantId = $__tenantId
           WITH a.name AS source, b.name AS target, collect({eid: elementId(r), relation: r.name, fact: r.fact}) AS edges
           WHERE size(edges) > 1
           RETURN source, target, edges`,
          { __tenantId }
        );

        const issues = [];

        for (const rec of selfLoops.records) {
          issues.push({
            type: "self_loop",
            severity: "high",
            action: "delete",
            eid: rec.get("eid"),
            from: rec.get("entity"),
            relation: rec.get("relation"),
            to: rec.get("entity"),
            fact: rec.get("fact"),
            description: `Self-referencing: "${rec.get("entity")}" points to itself`,
          });
        }

        for (const rec of longNames.records) {
          issues.push({
            type: "garbage_name",
            severity: "high",
            action: "delete",
            eid: rec.get("eid"),
            from: rec.get("from"),
            relation: rec.get("relation"),
            to: rec.get("to"),
            fact: rec.get("fact"),
            description: `Relation name too long (${rec.get("relation").length} chars) — likely debug data`,
          });
        }

        for (const rec of duplicateEdges.records) {
          const eids = rec.get("eids");
          // Keep first, flag the rest as duplicates
          for (let i = 1; i < eids.length; i++) {
            issues.push({
              type: "duplicate",
              severity: "medium",
              action: "delete",
              eid: eids[i],
              from: rec.get("source"),
              relation: rec.get("relation"),
              to: rec.get("target"),
              fact: rec.get("facts")[i],
              description: `Duplicate edge: "${rec.get("source")}" → "${rec.get("target")}" (${rec.get("relation")})`,
            });
          }
        }

        for (const rec of multiEdges.records) {
          const edges = rec.get("edges");
          // Only flag if there are multiple distinct relation names (same-name dupes already handled above)
          const distinctNames = new Set(edges.map(e => e.relation));
          if (edges.length > 2 && distinctNames.size > 1) {
            // Flag for review — don't auto-select, let user choose which to keep
            for (const edge of edges) {
              issues.push({
                type: "multi_edge",
                severity: "low",
                action: "delete",
                eid: edge.eid,
                from: rec.get("source"),
                relation: edge.relation,
                to: rec.get("target"),
                fact: edge.fact,
                description: `${edges.length} edges between "${rec.get("source")}" and "${rec.get("target")}" — review for redundancy`,
              });
            }
          }
        }

        res.json({ issues, total: issues.length });
      } finally {
        await session.close();
      }
    } catch (err) {
      logger?.error?.(`MindReader relationship scan error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/relationships/review — LLM-based relationship quality review
   * Sends batches to LLM to identify nonsensical, redundant, or incorrect relationships
   */
  app.post("/api/relationships/review", async (req, res) => {
    try {
      const { batchSize = 30 } = req.body || {};
      const maxBatch = Math.min(parseInt(batchSize) || 30, 50);

      const session = driver.session();
      try {
        const __tenantId = getTenantId();
        const result = await session.run(
          `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
           WHERE a.tenantId = $__tenantId
           RETURN elementId(r) AS eid, a.name AS from, a.category AS fromCat,
                  r.name AS relation, r.fact AS fact,
                  b.name AS to, b.category AS toCat
           LIMIT $limit`,
          { limit: neo4j.int(maxBatch), __tenantId }
        );

        if (result.records.length === 0) {
          return res.json({ issues: [], total: 0, reviewed: 0 });
        }

        const rels = result.records.map((rec, i) => ({
          idx: i,
          eid: rec.get("eid"),
          from: rec.get("from"),
          fromCat: rec.get("fromCat") || "unknown",
          relation: rec.get("relation"),
          fact: (rec.get("fact") || "").slice(0, 200),
          to: rec.get("to"),
          toCat: rec.get("toCat") || "unknown",
        }));

        const relList = rels.map(r =>
          `${r.idx}. "${r.from}" (${r.fromCat}) --[${r.relation}]--> "${r.to}" (${r.toCat}): ${r.fact || "no fact"}`
        ).join("\n");

        const prompt = `Review these knowledge graph relationships for quality issues.

Relationships:
${relList}

Flag relationships that have ANY of these problems:
- NONSENSICAL: The relationship doesn't make logical sense (e.g., a person "IS_TYPE_OF" a city)
- REVERSED: The direction is wrong (e.g., "Office WORKS_AT Person" should be "Person WORKS_AT Office")
- VAGUE: The relation name is too generic to be useful (e.g., "RELATED_TO", "HAS_RELATIONSHIP_WITH"). Suggest a better name.
- REDUNDANT: The fact just repeats the entity names with no new information
- GARBAGE: Contains debug output, code snippets, or system messages
- TYPO: The relation name has a clear spelling error. Suggest the corrected name.

Return ONLY a JSON array: [{"idx": 0, "problem": "TYPO", "reason": "OFFCE should be OFFICE", "suggested_name": "OFFICE_FOR"}]
- For TYPO and VAGUE: include "suggested_name" with the corrected/improved relation name
- For REVERSED: no suggested_name needed (direction will be swapped)
- For others: no suggested_name needed (will be deleted)
If no issues are found, return an empty array: []`;

        // Call LLM directly via callLLM()
        const llmConfig = { ...config, llmModel: config.llmExtractModel || config.llmModel };
        let llmIssues;
        try {
          const response = await callLLM({
            prompt,
            config: llmConfig,
            jsonMode: true,
            timeoutMs: 60000,
          });
          llmIssues = Array.isArray(response)
            ? response
            : (response.issues || response.results || response.items || []);
        } catch {
          llmIssues = [];
        }

        const issues = [];
        const fixableTypes = ["reversed", "typo", "vague"];
        if (Array.isArray(llmIssues)) {
          for (const issue of llmIssues) {
            const rel = rels[issue.idx];
            if (!rel) continue;
            const type = (issue.problem || "unknown").toLowerCase();
            issues.push({
              type,
              severity: ["garbage", "nonsensical", "reversed"].includes(type) ? "high" : "medium",
              action: fixableTypes.includes(type) ? "fix" : "delete",
              eid: rel.eid,
              from: rel.from,
              relation: rel.relation,
              to: rel.to,
              fact: rel.fact,
              description: issue.reason || issue.problem,
              suggestedName: issue.suggested_name || null,
            });
          }
        }

        // Count total relationships for progress
        const countResult = await session.run(
          `MATCH (a:Entity)-[r:RELATES_TO]->() WHERE a.tenantId = $__tenantId RETURN count(r) AS cnt`,
          { __tenantId }
        );
        const totalRels = countResult.records[0]?.get("cnt")?.toNumber?.() || countResult.records[0]?.get("cnt") || 0;

        res.json({ issues, reviewed: rels.length, total: totalRels });
      } finally {
        await session.close();
      }
    } catch (err) {
      logger?.warn?.(`MindReader relationship review error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/relationships/fix — Fix and cleanup relationships
   * Accepts an array of operations: { eid, action, suggestedName? }
   * Actions: "delete" removes the edge, "reverse" swaps source/target, "rename" changes relation name
   */
  app.post("/api/relationships/fix", async (req, res) => {
    try {
      const { operations } = req.body || {};
      if (!Array.isArray(operations) || operations.length === 0) {
        return res.status(400).json({ error: "operations array required" });
      }
      if (operations.length > 100) {
        return res.status(400).json({ error: "Max 100 operations per request" });
      }

      const session = driver.session();
      try {
        const __tenantId = getTenantId();
        let fixed = 0;
        let deleted = 0;
        let reversed = 0;
        let renamed = 0;

        for (const op of operations) {
          const { eid, action, suggestedName } = op;
          if (!eid) continue;

          if (action === "reverse") {
            // Reverse: read old edge, delete it, create new one with swapped source/target
            // Use explicit transaction for atomicity
            const readResult = await session.run(
              `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity) WHERE a.tenantId = $__tenantId AND elementId(r) = $eid
               RETURN elementId(a) AS aId, elementId(b) AS bId, r.name AS name, r.fact AS fact,
                      properties(r) AS props`,
              { eid, __tenantId }
            );
            if (readResult.records.length > 0) {
              const rec = readResult.records[0];
              const aId = rec.get("aId");
              const bId = rec.get("bId");
              const props = rec.get("props");
              const tx = session.beginTransaction();
              try {
                await tx.run(
                  `MATCH ()-[r:RELATES_TO]->() WHERE elementId(r) = $eid DELETE r`,
                  { eid }
                );
                await tx.run(
                  `MATCH (a:Entity), (b:Entity)
                   WHERE elementId(a) = $aId AND elementId(b) = $bId
                   CREATE (b)-[r:RELATES_TO]->(a)
                   SET r = $props`,
                  { aId, bId, props }
                );
                await tx.commit();
              } catch (txErr) {
                await tx.rollback();
                throw txErr;
              }
              reversed++;
              fixed++;
            }
          } else if (action === "rename" && suggestedName) {
            // Rename: update the relation name
            const result = await session.run(
              `MATCH (a:Entity)-[r:RELATES_TO]->() WHERE a.tenantId = $__tenantId AND elementId(r) = $eid
               SET r.name = $newName
               RETURN count(r) AS cnt`,
              { eid, newName: suggestedName, __tenantId }
            );
            if ((result.records[0]?.get("cnt")?.toNumber?.() || result.records[0]?.get("cnt") || 0) > 0) {
              renamed++;
              fixed++;
            }
          } else {
            // Default: delete
            const result = await session.run(
              `MATCH (a:Entity)-[r:RELATES_TO]->() WHERE a.tenantId = $__tenantId AND elementId(r) = $eid DELETE r RETURN count(r) AS cnt`,
              { eid, __tenantId }
            );
            deleted += result.records[0]?.get("cnt")?.toNumber?.() || result.records[0]?.get("cnt") || 0;
            fixed++;
          }
        }

        logger?.info?.(`MindReader: relationship fix — ${deleted} deleted, ${reversed} reversed, ${renamed} renamed`);
        res.json({ fixed, deleted, reversed, renamed });
      } finally {
        await session.close();
      }
    } catch (err) {
      logger?.error?.(`MindReader relationship fix error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });
}

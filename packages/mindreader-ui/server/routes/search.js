/**
 * Search routes — /api/search, /api/entities, /api/timeline, /api/projects, /api/stats, /api/query
 */
import neo4j from "neo4j-driver";
import { query, readQuery, nodeToPlain } from "../neo4j.js";
import { categorizeEntity } from "../lib/categorizer.js";
import { reinforceEntities } from "../lib/decay.js";

export function registerRoutes(app, ctx) {
  const { driver, config, logger } = ctx;

  /**
   * GET /api/search?q=text&limit=10 — Search memories
   */
  app.get("/api/search", async (req, res) => {
    try {
      const { q, limit = 10 } = req.query;
      if (!q) return res.status(400).json({ error: "Missing query parameter 'q'" });

      const maxLimit = Math.min(parseInt(limit) || 10, 50);

      // Search entities by name and summary
      const results = await query(driver,
        `MATCH (e:Entity)
         WHERE e.tenantId = $__tenantId
           AND (toLower(e.name) CONTAINS toLower($q)
            OR toLower(e.summary) CONTAINS toLower($q))
           AND e.expired_at IS NULL
         RETURN e
         ORDER BY e.created_at DESC
         LIMIT $limit`,
        { q, limit: neo4j.int(maxLimit) }
      );

      // Also search facts
      const factResults = await query(driver,
        `MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
         WHERE a.tenantId = $__tenantId
           AND (toLower(r.fact) CONTAINS toLower($q)
            OR toLower(r.name) CONTAINS toLower($q))
           AND r.expired_at IS NULL
           AND a.expired_at IS NULL AND b.expired_at IS NULL
         RETURN a.name AS source, r.name AS relation, r.fact AS fact, b.name AS target
         LIMIT $limit`,
        { q, limit: neo4j.int(maxLimit) }
      );

      // Reinforce accessed entities (fire-and-forget)
      const names = (results.map(r => r.e ? nodeToPlain(r.e).name : null)).filter(Boolean);
      if (names.length > 0) reinforceEntities(driver, names, config.memoryDecayReinforceDelta).catch(() => {});

      res.json({
        entities: results.map((r) => nodeToPlain(r.e)),
        facts: factResults,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/stats — Graph statistics
   */
  app.get("/api/stats", async (req, res) => {
    try {
      const nodeCounts = await query(driver,
        `MATCH (n) WHERE n.tenantId = $__tenantId RETURN labels(n)[0] AS label, count(n) AS count ORDER BY count DESC`
      );

      const relCounts = await query(driver,
        `MATCH (n)-[r]->() WHERE n.tenantId = $__tenantId RETURN type(r) AS type, count(r) AS count ORDER BY count DESC`
      );

      const [totals] = await query(driver,
        `MATCH (n) WHERE n.tenantId = $__tenantId WITH count(n) AS nodes
         OPTIONAL MATCH (m)-[r]->() WHERE m.tenantId = $__tenantId
         RETURN nodes, count(r) AS relationships`
      );

      // Group entities by category
      const entityGroups = await query(driver,
        `MATCH (e:Entity) WHERE e.tenantId = $__tenantId AND e.expired_at IS NULL
         RETURN e.name AS name, e.summary AS summary, COALESCE(e.category, e.group_id, '') AS category
         ORDER BY e.name`
      );

      const groups = {};
      for (const e of entityGroups) {
        const cat = categorizeEntity(e.name, e.summary, e.category);
        groups[cat] = (groups[cat] || 0) + 1;
      }

      res.json({
        totals,
        nodeCounts,
        relCounts,
        entityGroups: groups,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/projects — List all projects
   */
  app.get("/api/projects", async (req, res) => {
    try {
      const results = await query(driver,
        `MATCH (e:Entity)
         WHERE e.tenantId = $__tenantId
           AND e.expired_at IS NULL AND (toLower(e.summary) CONTAINS 'project'
            OR toLower(e.summary) CONTAINS 'is a project')
         RETURN DISTINCT e.name AS name, e.summary AS summary, e.uuid AS uuid, e.created_at AS created_at
         ORDER BY e.name`
      );

      res.json({ projects: results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/query — Custom Cypher query (advanced)
   * Uses read-only session to enforce no writes at the driver level (#2).
   */
  app.post("/api/query", async (req, res) => {
    try {
      const { cypher, params = {} } = req.body;
      if (!cypher) return res.status(400).json({ error: "Missing 'cypher' in request body" });

      // Secondary guard: only allow queries starting with known read-only prefixes
      // CALL is excluded because it can invoke write procedures (e.g. CALL db.createNode)
      const normalized = cypher.trim().toUpperCase();
      if (!normalized.startsWith("MATCH") && !normalized.startsWith("RETURN")) {
        return res.status(403).json({ error: "Query must start with MATCH or RETURN." });
      }
      // Block write keywords anywhere in the query (word-boundary matching)
      const writePatterns = [/\bCREATE\b/, /\bMERGE\b/, /\bDELETE\b/, /\bDETACH\b/, /\bSET\b/, /\bREMOVE\b/];
      if (writePatterns.some(p => p.test(normalized))) {
        return res.status(403).json({ error: "Write operations are not allowed via the query endpoint." });
      }

      // Use read-only session — the driver will reject any write operations
      const results = await readQuery(driver, cypher, params);
      res.json({ results });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/entities — Paginated entity list with relationship counts
   */
  app.get("/api/entities", async (req, res) => {
    try {
      const { sort = "created_at", order = "desc", group, q, limit = 50, offset = 0 } = req.query;
      const maxLimit = Math.min(parseInt(limit) || 50, 200);
      const safeOffset = Math.max(parseInt(offset) || 0, 0);
      const safeOrder = order.toUpperCase() === "ASC" ? "ASC" : "DESC";
      const allowedSorts = ["created_at", "name"];
      const safeSort = allowedSorts.includes(sort) ? sort : "created_at";

      let whereClauses = ["e.tenantId = $__tenantId", "e.expired_at IS NULL"];
      let params = {};

      if (q) {
        whereClauses.push("(toLower(e.name) CONTAINS toLower($q) OR toLower(e.summary) CONTAINS toLower($q) OR ANY(t IN COALESCE(e.tags, []) WHERE t CONTAINS toLower($q)))");
        params.q = q;
      }

      const whereStr = whereClauses.length > 0 ? `WHERE ${whereClauses.join(" AND ")}` : "";

      // Fetch all matching entities with relevance-based sorting when searching
      const orderClause = q
        ? `ORDER BY
            CASE WHEN toLower(e.name) = toLower($q) THEN 0
                 WHEN toLower(e.name) STARTS WITH toLower($q) THEN 1
                 WHEN toLower(e.name) CONTAINS toLower($q) THEN 2
                 WHEN ANY(t IN COALESCE(e.tags, []) WHERE t = toLower($q)) THEN 3
                 ELSE 4 END ASC,
            relCount DESC, e.${safeSort} ${safeOrder}`
        : `ORDER BY e.${safeSort} ${safeOrder}`;

      const cypher = `
        MATCH (e:Entity)
        ${whereStr}
        OPTIONAL MATCH (e)-[r:RELATES_TO]-() WHERE r.expired_at IS NULL
        WITH e, count(r) AS relCount
        RETURN e.uuid AS uuid, e.name AS name, e.summary AS summary,
               e.created_at AS created_at, COALESCE(e.category, e.group_id, '') AS category, e.node_type AS node_type, e.tags AS tags, relCount
        ${orderClause}
      `;

      const records = await query(driver, cypher, params);

      // Categorize all entities
      const allEntities = records.map((rec) => ({
        uuid: rec.uuid,
        name: rec.name,
        summary: rec.summary,
        created_at: rec.created_at,
        category: categorizeEntity(rec.name, rec.summary, rec.category),
        node_type: rec.node_type || "normal",
        tags: Array.isArray(rec.tags) ? rec.tags : [],
        relCount: typeof rec.relCount === "object" ? rec.relCount.toNumber?.() || 0 : rec.relCount || 0,
      }));

      // Apply category filter before pagination so total count matches
      const filtered = group ? allEntities.filter((e) => e.category === group) : allEntities;
      const totalNum = filtered.length;
      const paged = filtered.slice(safeOffset, safeOffset + maxLimit);

      res.json({ entities: paged, total: totalNum, limit: maxLimit, offset: safeOffset });
    } catch (err) {
      logger?.error?.(`MindReader entities API error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/timeline?days=30 — Entities grouped by date
   */
  app.get("/api/timeline", async (req, res) => {
    try {
      const { days = 30 } = req.query;
      const maxDays = Math.min(parseInt(days) || 30, 365);

      const cypher = `
        MATCH (e:Entity)
        WHERE e.tenantId = $__tenantId AND e.created_at IS NOT NULL AND e.expired_at IS NULL
        WITH e ORDER BY e.created_at DESC
        RETURN e.uuid AS uuid, e.name AS name, e.summary AS summary,
               e.created_at AS created_at, COALESCE(e.category, e.group_id, '') AS category, e.node_type AS node_type
        LIMIT 500
      `;

      const records = await query(driver, cypher, {});

      const now = new Date();
      const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      const yesterdayStart = new Date(todayStart); yesterdayStart.setDate(yesterdayStart.getDate() - 1);
      const weekStart = new Date(todayStart); weekStart.setDate(weekStart.getDate() - 7);
      const cutoff = new Date(todayStart); cutoff.setDate(cutoff.getDate() - maxDays);

      const groups = { today: [], yesterday: [], this_week: [], earlier: [] };

      for (const rec of records) {
        const entity = {
          uuid: rec.uuid,
          name: rec.name,
          summary: rec.summary,
          created_at: rec.created_at,
          category: categorizeEntity(rec.name, rec.summary, rec.category),
          node_type: rec.node_type || "normal",
        };

        if (!rec.created_at) { groups.earlier.push(entity); continue; }
        const d = new Date(rec.created_at);
        if (d < cutoff) continue;
        if (d >= todayStart) groups.today.push(entity);
        else if (d >= yesterdayStart) groups.yesterday.push(entity);
        else if (d >= weekStart) groups.this_week.push(entity);
        else groups.earlier.push(entity);
      }

      res.json({ timeline: groups });
    } catch (err) {
      logger?.error?.(`MindReader timeline API error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });
}

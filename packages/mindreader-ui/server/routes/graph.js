/**
 * Graph routes — GET /api/graph
 */
import neo4j from "neo4j-driver";
import { query, nodeToPlain } from "../neo4j.js";
import { categorizeNode } from "../lib/categorizer.js";

export function registerRoutes(app, ctx) {
  const { driver, logger } = ctx;

  /**
   * GET /api/graph — Full graph data for visualization
   * Query params: ?project=X&type=Entity&limit=500
   */
  app.get("/api/graph", async (req, res) => {
    try {
      const { project, type, limit = 500 } = req.query;
      const showExpired = req.query.showExpired === "true";
      const maxLimit = Math.min(parseInt(limit) || 500, 2000);
      const entityFilter = showExpired ? "" : "AND n.expired_at IS NULL";

      let nodeCypher, linkCypher;

      if (project) {
        // Filter by project: find entities related to the project
        nodeCypher = `
          MATCH (e:Entity)
          WHERE (toLower(e.name) CONTAINS toLower($project)
             OR toLower(e.summary) CONTAINS toLower($project))
             ${showExpired ? "" : "AND e.expired_at IS NULL"}
          WITH collect(e) AS projectNodes
          UNWIND projectNodes AS pn
          OPTIONAL MATCH (pn)-[r:RELATES_TO]-(connected:Entity)
          WHERE connected.expired_at IS NULL OR $showExpired
          WITH projectNodes, collect(connected) AS connectedNodes
          UNWIND projectNodes + connectedNodes AS n
          RETURN DISTINCT n LIMIT $limit
        `;
        linkCypher = `
          MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
          WHERE (toLower(a.name) CONTAINS toLower($project)
             OR toLower(a.summary) CONTAINS toLower($project)
             OR toLower(b.name) CONTAINS toLower($project)
             OR toLower(b.summary) CONTAINS toLower($project))
            AND r.expired_at IS NULL
          RETURN a.uuid AS source, b.uuid AS target,
                 r.name AS label, r.fact AS fact,
                 r.created_at AS created_at, r.valid_at AS valid_at,
                 r.strength AS strength
          LIMIT $limit
        `;
      } else {
        // All entities — prioritize non-"other" categories for better visualization
        // First get non-other entities, then fill with other if needed
        const allowedTypes = ["Entity", "Episodic", "Community", "Saga"];
        const safeType = allowedTypes.includes(type) ? type : "Entity";

        if (!type || safeType === "Entity") {
          // Fetch entities up to a safe limit, sort in JS after categorization
          nodeCypher = `MATCH (n:Entity) WHERE 1=1 ${entityFilter} RETURN n LIMIT 5000`;
        } else {
          nodeCypher = `MATCH (n:${safeType}) WHERE 1=1 ${entityFilter} RETURN n LIMIT $limit`;
        }

        linkCypher = `
          MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
          WHERE r.expired_at IS NULL
          RETURN a.uuid AS source, b.uuid AS target,
                 r.name AS label, r.fact AS fact,
                 r.created_at AS created_at, r.valid_at AS valid_at,
                 r.strength AS strength
          LIMIT $limit
        `;
      }

      const params = { project: project || "", limit: neo4j.int(maxLimit), showExpired };

      const nodeRecords = await query(driver, nodeCypher, params);
      const linkRecords = await query(driver, linkCypher, params);

      // Build nodes array with JS-side categorization
      let allNodes = nodeRecords.map((rec) => {
        const n = rec.n ? nodeToPlain(rec.n) : rec;
        return {
          id: n.uuid || n._id,
          name: n.name || "unknown",
          summary: n.summary || "",
          labels: n._labels || ["Entity"],
          category: categorizeNode(n),
          tags: Array.isArray(n.tags) ? n.tags : [],
          node_type: n.node_type || "normal",
          created_at: n.created_at,
          strength: n.strength ?? null,
        };
      });

      // Smart sampling: prioritize non-"other" categories, then fill with "other"
      const nonOther = allNodes.filter((n) => n.category !== "other");
      const other = allNodes.filter((n) => n.category === "other");
      // Sort non-other by created_at desc, take all of them first
      nonOther.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
      other.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
      // Take all non-other + fill remaining slots with other
      const remaining = Math.max(0, maxLimit - nonOther.length);
      const nodes = [...nonOther, ...other.slice(0, remaining)].slice(0, maxLimit);

      // Build node ID set for filtering valid links
      const nodeIds = new Set(nodes.map((n) => n.id));

      // Build links array
      const links = linkRecords
        .filter((rec) => nodeIds.has(rec.source) && nodeIds.has(rec.target))
        .map((rec) => ({
          source: rec.source,
          target: rec.target,
          label: rec.label || "",
          fact: rec.fact || "",
          created_at: rec.created_at,
        }));

      res.json({ nodes, links });
    } catch (err) {
      logger?.error?.(`MindReader API error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/graph/ego/:name — Ego graph: node + multi-level neighbors
   * Query params: ?depth=2 (default 2, max 4)
   */
  app.get("/api/graph/ego/:name", async (req, res) => {
    try {
      const name = req.params.name;
      const depth = Math.min(Math.max(parseInt(req.query.depth) || 2, 1), 4);
      const showExpired = req.query.showExpired === "true";
      const egoEntityFilter = showExpired ? "" : "WHERE neighbor.expired_at IS NULL";

      // Variable-length relationship pattern for multi-hop BFS
      const nodeRecords = await query(driver, `
        MATCH (start:Entity {name: $name})
        CALL {
          WITH start
          MATCH (start)-[:RELATES_TO*1..${depth}]-(neighbor:Entity)
          ${egoEntityFilter}
          RETURN neighbor AS n
          UNION
          WITH start
          RETURN start AS n
        }
        RETURN DISTINCT n
      `, { name });

      const nodes = nodeRecords.map((rec) => {
        const n = rec.n ? nodeToPlain(rec.n) : rec;
        return {
          id: n.uuid || n._id,
          name: n.name || "unknown",
          summary: n.summary || "",
          labels: n._labels || ["Entity"],
          category: categorizeNode(n),
          tags: Array.isArray(n.tags) ? n.tags : [],
          node_type: n.node_type || "normal",
          created_at: n.created_at,
          strength: n.strength ?? null,
        };
      });

      const nodeIds = new Set(nodes.map((n) => n.id));

      const linkRecords = await query(driver, `
        MATCH (a:Entity)-[r:RELATES_TO]->(b:Entity)
        WHERE a.uuid IN $ids AND b.uuid IN $ids AND r.expired_at IS NULL
        RETURN a.uuid AS source, b.uuid AS target,
               r.name AS label, r.fact AS fact,
               r.created_at AS created_at,
               r.strength AS strength
      `, { ids: [...nodeIds] });

      const links = linkRecords.map((rec) => ({
        source: rec.source,
        target: rec.target,
        label: rec.label || "",
        fact: rec.fact || "",
        created_at: rec.created_at,
        strength: rec.strength ?? null,
      }));

      res.json({ nodes, links, center: name });
    } catch (err) {
      logger?.error?.(`Ego graph error: ${err.message}`);
      res.status(500).json({ error: err.message });
    }
  });
}

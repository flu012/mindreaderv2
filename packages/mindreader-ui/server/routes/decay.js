/**
 * Decay management routes — /api/decay/*
 */
import { query } from "../neo4j.js";

export function registerRoutes(app, ctx) {
  const { driver, config, logger } = ctx;

  // Helper: build match clause that supports both uuid and name lookup
  function entityMatch(paramName = "name", alias = "e") {
    return (val) => {
      const isUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(val);
      return isUuid ? `${alias}.uuid = $${paramName}` : `toLower(${alias}.name) = toLower($${paramName})`;
    };
  }

  /**
   * GET /api/decay/status — Decay statistics and configuration
   */
  app.get("/api/decay/status", async (req, res) => {
    try {
      const stats = await query(driver,
        `MATCH (e:Entity)
         RETURN
           count(e) AS total,
           count(CASE WHEN e.expired_at IS NOT NULL THEN 1 END) AS expired,
           avg(CASE WHEN e.expired_at IS NULL THEN e.strength END) AS avgStrength,
           min(CASE WHEN e.expired_at IS NULL THEN e.strength END) AS minStrength`
      );
      const edgeStats = await query(driver,
        `MATCH ()-[r:RELATES_TO]->()
         RETURN
           count(r) AS total,
           count(CASE WHEN r.expired_at IS NOT NULL THEN 1 END) AS expired,
           avg(CASE WHEN r.expired_at IS NULL THEN r.strength END) AS avgStrength`
      );
      const e = stats[0] || {};
      const r = edgeStats[0] || {};
      res.json({
        entities: { total: e.total, expired: e.expired, avgStrength: e.avgStrength, minStrength: e.minStrength },
        edges: { total: r.total, expired: r.expired, avgStrength: r.avgStrength },
        config: {
          enabled: config.memoryDecayEnabled,
          lambda: config.memoryDecayLambda,
          threshold: config.memoryDecayThreshold,
          intervalMs: config.memoryDecayIntervalMs,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/decay/run — Manually trigger a decay cycle
   */
  app.post("/api/decay/run", async (req, res) => {
    try {
      const decayJob = req.app._decayJob;
      if (decayJob?.runNow) {
        const ran = await decayJob.runNow();
        if (ran) {
          res.json({ ok: true, message: "Decay cycle completed." });
        } else {
          res.json({ ok: true, message: "Decay cycle already running, skipped." });
        }
      } else {
        res.json({ ok: false, message: "Decay job not available." });
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/decay/restore/:name — Restore an expired entity and its relationships
   */
  app.post("/api/decay/restore/:name", async (req, res) => {
    try {
      const { name } = req.params;
      const match = entityMatch("name")(name);
      const session = driver.session();
      try {
        await session.run(
          `MATCH (e:Entity) WHERE ${match}
           SET e.expired_at = null, e.strength = 1.0, e.last_accessed_at = datetime()`,
          { name }
        );
        await session.run(
          `MATCH (e:Entity)-[r:RELATES_TO]-() WHERE ${match}
           SET r.expired_at = null, r.strength = 1.0, r.last_accessed_at = datetime()`,
          { name }
        );
        res.json({ ok: true });
      } finally {
        await session.close();
      }
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

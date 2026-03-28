/**
 * MindReader API Server
 *
 * Provides REST API for the knowledge graph visualization UI.
 * Connects directly to Neo4j via bolt protocol.
 */
import express from "express";
import cors from "cors";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getDriver, closeDriver } from "./neo4j.js";
import { loadConfig } from "./config.js";
import { createDaemon } from "./lib/daemon.js";
import { getCategories, seedDefaultCategories, createAutoCategorizer } from "./lib/categorizer.js";
import { createDecayJob } from "./lib/decay.js";

// Route modules
import { registerRoutes as registerGraphRoutes } from "./routes/graph.js";
import { registerRoutes as registerEntityRoutes } from "./routes/entity.js";
import { registerRoutes as registerEvolveRoutes } from "./routes/evolve.js";
import { registerRoutes as registerCategoryRoutes } from "./routes/categories.js";
import { registerRoutes as registerSearchRoutes } from "./routes/search.js";
import { registerRoutes as registerCleanupRoutes } from "./routes/cleanup.js";
import { registerRoutes as registerDecayRoutes } from "./routes/decay.js";
import { registerRoutes as registerAuditRoutes } from "./routes/audit.js";
import { registerRoutes as registerTokenRoutes } from "./routes/tokens.js";
import { registerRoutes as registerCliRoutes } from "./routes/cli.js";
import { registerRoutes as registerDirectEntityRoutes } from "./routes/directEntity.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function createServer(config, logger) {
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "512kb" }));

  // Log request/response payload sizes for /api/ routes
  app.use("/api", (req, res, next) => {
    const reqSize = req.headers["content-length"] || (req.body ? Buffer.byteLength(JSON.stringify(req.body)) : 0);
    const start = Date.now();
    const origJson = res.json.bind(res);
    res.json = (body) => {
      const resPayload = JSON.stringify(body);
      const resSize = Buffer.byteLength(resPayload);
      const ms = Date.now() - start;
      logger?.info?.(`${req.method} ${req.path} ${res.statusCode} ${ms}ms req=${reqSize}b res=${resSize}b`);
      return origJson(body);
    };
    next();
  });

  // Serve static UI files
  const uiDist = path.resolve(__dirname, "../ui/dist");
  app.use(express.static(uiDist));

  const driver = getDriver(config);

  // ========================================================================
  // Auth middleware: bearer token auth for /api/ routes
  // ========================================================================
  if (config.apiToken) {
    app.use("/api", (req, res, next) => {
      const authHeader = req.headers.authorization;
      if (!authHeader || authHeader !== `Bearer ${config.apiToken}`) {
        return res.status(401).json({ error: "Unauthorized. Provide a valid Bearer token." });
      }
      next();
    });
  } else {
    logger?.warn?.("MindReader: No apiToken configured — all API endpoints are unauthenticated. Set apiToken in config for production use.");
  }

  // ========================================================================
  // Python daemon (long-running process, eliminates cold-start)
  // ========================================================================
  const daemon = createDaemon(config, logger);

  // Build shared context for route modules
  const ctx = {
    driver,
    config,
    logger,
    mgDaemon: daemon.mgDaemon,
    mgExec: daemon.mgExec,
  };

  // ========================================================================
  // Register all route modules
  // ========================================================================
  registerGraphRoutes(app, ctx);
  registerEntityRoutes(app, ctx);
  registerEvolveRoutes(app, ctx);
  registerCategoryRoutes(app, ctx);
  registerSearchRoutes(app, ctx);
  registerCleanupRoutes(app, ctx);
  registerDecayRoutes(app, ctx);
  registerAuditRoutes(app, ctx);
  registerTokenRoutes(app, ctx);
  registerCliRoutes(app, ctx);
  registerDirectEntityRoutes(app, ctx);

  // ========================================================================
  // SPA fallback — MUST be after all route registrations
  // ========================================================================
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) {
      res.status(404).json({ error: `Unknown API route: ${req.method} ${req.path}` });
    } else {
      res.sendFile(path.join(uiDist, "index.html"));
    }
  });

  // Expose stop and warmup functions for cleanup / standalone start
  app._stopDaemon = daemon.stop;
  app._warmupDaemon = daemon.warmup;

  return app;
}

/**
 * Start the MindReader UI server.
 */
export function startServer(configOverrides, logger, { eagerDaemon = false } = {}) {
  const config = loadConfig(configOverrides || {});
  const port = config.uiPort || 18900;
  const app = createServer(config, logger);

  // Eagerly start Python daemon when running standalone (not as plugin)
  if (eagerDaemon && app._warmupDaemon) app._warmupDaemon();

  // Initialize Neo4j indexes at startup for search performance
  const driver = getDriver(config);
  import("./init-indexes.js").then(({ initIndexes }) => {
    initIndexes(driver, logger);
  }).catch((err) => {
    logger?.warn?.(`MindReader: Failed to init indexes: ${err.message}`);
  });

  // Seed default categories if they don't exist, then pre-warm cache
  seedDefaultCategories(driver, logger).then(() => {
    return getCategories(driver);
  }).then((cats) => {
    logger?.info?.(`MindReader: Loaded ${cats.length} categories from Neo4j`);
  }).catch((err) => {
    logger?.warn?.(`MindReader: Failed to seed/load categories: ${err.message}`);
  });

  // Auto-categorize new entities every 60 seconds using LLM
  const autoCategorizer = createAutoCategorizer(driver, config, logger);
  autoCategorizer.start();

  const decayJob = createDecayJob(driver, config, logger);
  app._decayJob = decayJob;
  decayJob.start();

  const server = app.listen(port, () => {
    logger?.info?.(`MindReader UI: http://localhost:${port}`);
  });

  // Clean up interval and daemon when server closes
  server.on("close", () => {
    autoCategorizer.stop();
    decayJob.stop();
    if (app._stopDaemon) app._stopDaemon();
    closeDriver();
  });

  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      logger?.warn?.(`MindReader: Port ${port} already in use. UI server not started.`);
    } else {
      logger?.error?.(`MindReader: Server error: ${err.message}`);
    }
  });

  return server;
}

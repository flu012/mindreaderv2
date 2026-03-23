/**
 * MindReader server entry point.
 * Loads config and starts the HTTP server.
 */
import { startServer } from "./server.js";

const logger = {
  info: (...args) => console.log("[info]", ...args),
  warn: (...args) => console.warn("[warn]", ...args),
  error: (...args) => console.error("[error]", ...args),
};

startServer({}, logger);

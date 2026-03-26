/**
 * Standalone server start script.
 * Use: node server/start.js
 */
import { startServer } from "./server.js";

const logger = {
  info: (...args) => console.log("[info]", ...args),
  warn: (...args) => console.warn("[warn]", ...args),
  error: (...args) => console.error("[error]", ...args),
};

startServer({}, logger, { eagerDaemon: true });

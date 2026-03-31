/**
 * MindReader OpenClaw Plugin
 *
 * Thin integration layer that registers tools and hooks with OpenClaw.
 * All actual logic lives in @mindreader/ui's Express server.
 */
import { startServer } from "@mindreader/ui";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __pluginDir = dirname(fileURLToPath(import.meta.url));

/** Auto-sync plugin files from monorepo source on startup. */
function syncPluginFiles(logger) {
  try {
    // The extension's node_modules is a junction/symlink to the monorepo root's node_modules.
    // From there we can find packages/openclaw-plugin (the canonical source).
    const nmLink = join(__pluginDir, "node_modules");
    if (!existsSync(nmLink)) return;
    const monorepoRoot = resolve(nmLink, "..");
    const monorepoSrc = join(monorepoRoot, "packages", "openclaw-plugin");
    if (!existsSync(monorepoSrc) || resolve(monorepoSrc) === resolve(__pluginDir)) return;

    const files = ["index.js", "openclaw.plugin.json", "package.json"];
    let synced = 0;
    for (const file of files) {
      const src = join(monorepoSrc, file);
      const dest = join(__pluginDir, file);
      if (!existsSync(src)) continue;
      const srcContent = readFileSync(src);
      const destContent = existsSync(dest) ? readFileSync(dest) : null;
      if (!destContent || !srcContent.equals(destContent)) {
        writeFileSync(dest, srcContent);
        synced++;
        logger?.info?.(`MindReader: synced ${file} from monorepo`);
      }
    }
    if (synced > 0) {
      logger?.info?.(`MindReader: ${synced} plugin file(s) updated. Changes take effect on next restart.`);
    }
  } catch (err) {
    logger?.warn?.(`MindReader: plugin sync failed: ${err.message}`);
  }
}

const DEFAULTS = {
  neo4jUri: "bolt://localhost:7687",
  neo4jUser: "neo4j",
  neo4jPassword: "",
  llmApiKey: "",
  llmBaseUrl: "",
  llmModel: "gpt-4o-mini",
  autoCapture: true,
  autoRecall: true,
  recallLimit: 5,
  captureMaxChars: 2000,
  uiPort: 18900,
  uiEnabled: true,
  tenantId: "master",
};

function bridgeConfig(openClawConfig) {
  const raw = { ...DEFAULTS, ...(openClawConfig.config || openClawConfig) };
  return {
    neo4jUri: raw.neo4jUri,
    neo4jUser: raw.neo4jUser,
    neo4jPassword: raw.neo4jPassword,
    llmProvider: raw.llmProvider,
    llmApiKey: raw.llmApiKey,
    llmBaseUrl: raw.llmBaseUrl,
    llmModel: raw.llmModel,
    llmExtractModel: raw.llmExtractModel,
    llmEvolveModel: raw.llmEvolveModel,
    embedderApiKey: raw.embedderApiKey,
    embedderBaseUrl: raw.embedderBaseUrl,
    embedderModel: raw.embedderModel,
    uiPort: raw.uiPort,
    autoCapture: raw.autoCapture,
    autoRecall: raw.autoRecall,
    recallLimit: raw.recallLimit,
    captureMaxChars: raw.captureMaxChars,
    uiEnabled: raw.uiEnabled,
    apiToken: raw.apiToken,
    seqUrl: raw.seqUrl,
    seqApiKey: raw.seqApiKey,
    tenantId: raw.tenantId || "master",
  };
}

const mindreaderPlugin = {
  id: "mindreader",
  name: "MindReader — Knowledge Graph Memory",
  description: "Knowledge graph memory with 2D visualization via Graphiti + Neo4j",
  kind: "memory",

  register(api) {
    const cfg = bridgeConfig(api.pluginConfig || {});
    const port = cfg.uiPort || 18900;

    async function serverFetch(port, path, options = {}) {
      const url = `http://localhost:${port}${path}`;
      const headers = {
        ...(options.headers || {}),
        "X-Tenant-Id": cfg.tenantId || "master",
      };
      const res = await fetch(url, { ...options, headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.json();
    }

    api.registerTool({
      name: "memory_search",
      label: "Memory Search",
      description: "Search the knowledge graph for facts, relationships, and memories.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          limit: { type: "number", description: "Max results (default: 10)" },
        },
        required: ["query"],
      },
      async execute(_id, params) {
        try {
          const data = await serverFetch(port, `/api/cli/search?q=${encodeURIComponent(params.query)}&limit=${params.limit || 10}`);
          return { content: [{ type: "text", text: data.output || "No results found." }], details: data };
        } catch (err) {
          return { content: [{ type: "text", text: `Memory search failed: ${err.message}` }] };
        }
      },
    }, { name: "memory_search" });

    api.registerTool({
      name: "memory_store",
      label: "Memory Store",
      description: "Store a fact or relationship in the knowledge graph.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Fact or information to remember" },
          source: { type: "string", description: "Source", default: "agent" },
          project: { type: "string", description: "Associate with a project name" },
        },
        required: ["content"],
      },
      async execute(_id, params) {
        try {
          const data = await serverFetch(port, "/api/cli/store", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params),
          });
          return { content: [{ type: "text", text: data.output || "Memory stored." }], details: data };
        } catch (err) {
          return { content: [{ type: "text", text: `Memory store failed: ${err.message}` }] };
        }
      },
    }, { name: "memory_store" });

    api.registerTool({
      name: "memory_entities",
      label: "Memory Entities",
      description: "List all known entities in the knowledge graph.",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "number", description: "Max entities (default: 30)" },
        },
      },
      async execute(_id, params) {
        try {
          const data = await serverFetch(port, `/api/cli/entities?limit=${params?.limit || 30}`);
          return { content: [{ type: "text", text: data.output || "No entities found." }] };
        } catch (err) {
          return { content: [{ type: "text", text: `Entity list failed: ${err.message}` }] };
        }
      },
    }, { name: "memory_entities" });

    if (cfg.autoRecall) {
      api.on("before_agent_start", async (event) => {
        if (!event.prompt || event.prompt.length < 10) return;
        try {
          const data = await serverFetch(port, "/api/cli/recall", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ prompt: event.prompt, limit: cfg.recallLimit }),
          });
          if (data.context) return { prependContext: data.context };
        } catch (err) {
          api.logger.warn?.(`MindReader: recall failed: ${err.message}`);
        }
      });
    }

    if (cfg.autoCapture) {
      api.on("agent_end", async (event) => {
        if (!event.success || !event.messages?.length) return;
        try {
          // Only send the last N messages to avoid huge payloads.
          // Take recent messages and truncate content to captureMaxChars total.
          const maxChars = cfg.captureMaxChars || 2000;
          const recent = [];
          let charCount = 0;
          for (let i = event.messages.length - 1; i >= 0 && charCount < maxChars; i--) {
            const msg = event.messages[i];
            const text = typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content || "");
            charCount += text.length;
            recent.unshift({ role: msg.role, content: text.slice(0, maxChars) });
          }
          await serverFetch(port, "/api/cli/capture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: recent,
              captureMaxChars: maxChars,
            }),
          });
        } catch (err) {
          api.logger.warn?.(`MindReader: capture failed: ${err.message}`);
        }
      });
    }

    let uiServer = null;

    api.registerService({
      id: "mindreader",
      async start() {
        syncPluginFiles(api.logger);
        api.logger.info(`MindReader: started (autoRecall: ${cfg.autoRecall}, autoCapture: ${cfg.autoCapture})`);
        if (cfg.uiEnabled) {
          try {
            uiServer = startServer(cfg, api.logger);
          } catch (err) {
            api.logger.warn?.(`MindReader: UI server failed: ${err.message}`);
          }
        }
      },
      async stop() {
        if (uiServer) {
          uiServer.close();
          uiServer = null;
        }
        api.logger.info("MindReader: stopped");
      },
    });
  },
};

export default mindreaderPlugin;

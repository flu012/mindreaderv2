/**
 * MindReader OpenClaw Plugin
 *
 * Thin integration layer that registers tools and hooks with OpenClaw.
 * All actual logic lives in @mindreader/ui's Express server.
 */
import { startServer } from "@mindreader/ui";

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
};

function bridgeConfig(openClawConfig) {
  const raw = { ...DEFAULTS, ...(openClawConfig.config || openClawConfig) };
  return {
    neo4jUri: raw.neo4jUri,
    neo4jUser: raw.neo4jUser,
    neo4jPassword: raw.neo4jPassword,
    llmApiKey: raw.llmApiKey,
    llmBaseUrl: raw.llmBaseUrl,
    llmModel: raw.llmModel,
    llmExtractModel: raw.llmExtractModel,
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
  };
}

async function serverFetch(port, path, options = {}) {
  const url = `http://localhost:${port}${path}`;
  const res = await fetch(url, options);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

const mindreaderPlugin = {
  id: "mindreader",
  name: "MindReader — Knowledge Graph Memory",
  description: "Knowledge graph memory with 2D visualization via Graphiti + Neo4j",
  kind: "memory",

  register(api) {
    const cfg = bridgeConfig(api.pluginConfig || {});
    const port = cfg.uiPort || 18900;

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
          await serverFetch(port, "/api/cli/capture", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              messages: event.messages,
              captureMaxChars: cfg.captureMaxChars,
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

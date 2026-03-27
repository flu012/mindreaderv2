/**
 * MindReader configuration loader.
 * Reads .env from monorepo root + config/providers.json to resolve provider settings.
 */
import { config as dotenvConfig } from "dotenv";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Monorepo root is 3 levels up from packages/mindreader-ui/server/
const MONOREPO_ROOT = path.resolve(__dirname, "../../..");

/** Resolve the venv python executable path (cross-platform). */
export function venvPython(pythonDir) {
  const winPath = path.join(pythonDir, ".venv", "Scripts", "python.exe");
  if (process.platform === "win32" && existsSync(winPath)) return winPath;
  return path.join(pythonDir, ".venv", "bin", "python");
}

export function loadConfig(overrides = {}) {
  // Load .env from monorepo root
  dotenvConfig({ path: path.join(MONOREPO_ROOT, ".env") });

  // Load provider presets
  const providersPath = path.join(MONOREPO_ROOT, "config", "providers.json");
  let providers = { llm: {}, embedder: {} };
  try {
    providers = JSON.parse(readFileSync(providersPath, "utf-8"));
  } catch {
    console.warn("MindReader: config/providers.json not found, using defaults");
  }

  const llmProvider = overrides.llmProvider || process.env.LLM_PROVIDER || "openai";
  const embedderProvider = overrides.embedderProvider || process.env.EMBEDDER_PROVIDER || "openai";

  const llmPreset = providers.llm[llmProvider] || {};
  const embedderPreset = providers.embedder[embedderProvider] || {};

  // Allow LLM_BASE_URL env var to override provider preset
  const llmBaseUrl = overrides.llmBaseUrl || process.env.LLM_BASE_URL || llmPreset.baseUrl || "https://api.openai.com/v1";

  const defaultPythonPath = path.resolve(__dirname, "../../mindgraph/python");

  return {
    isWin: process.platform === "win32",
    neo4jUri: overrides.neo4jUri || process.env.NEO4J_URI || "bolt://localhost:7687",
    neo4jUser: overrides.neo4jUser || process.env.NEO4J_USER || "neo4j",
    neo4jPassword: overrides.neo4jPassword || process.env.NEO4J_PASSWORD || "",
    llmProvider,
    llmBaseUrl,
    llmApiKey: overrides.llmApiKey || process.env.LLM_API_KEY || "",
    llmModel: overrides.llmModel || process.env.LLM_MODEL || llmPreset.defaultModel || "gpt-4o-mini",
    llmExtractModel: overrides.llmExtractModel || process.env.LLM_EXTRACT_MODEL || overrides.llmModel || process.env.LLM_MODEL || llmPreset.defaultModel || "gpt-4o-mini",
    llmEvolveModel: overrides.llmEvolveModel || process.env.LLM_EVOLVE_MODEL || overrides.llmModel || process.env.LLM_MODEL || llmPreset.defaultModel || "gpt-4o-mini",
    embedderBaseUrl: overrides.embedderBaseUrl || process.env.EMBEDDER_BASE_URL || embedderPreset.baseUrl || "https://api.openai.com/v1",
    embedderApiKey: overrides.embedderApiKey || process.env.EMBEDDER_API_KEY || process.env.LLM_API_KEY || "",
    embedderModel: overrides.embedderModel || process.env.EMBEDDER_MODEL || embedderPreset.defaultModel || "text-embedding-3-small",
    uiPort: overrides.uiPort || parseInt(process.env.UI_PORT) || 18900,
    cachePath: overrides.cachePath || process.env.MINDREADER_CACHE || path.join(process.env.HOME || "~", ".mindreader", "cache"),
    pythonPath: overrides.pythonPath || process.env.MINDGRAPH_PYTHON_PATH || defaultPythonPath,
    apiToken: overrides.apiToken || process.env.API_TOKEN || "",
    seqUrl: overrides.seqUrl || process.env.SEQ_URL || "",
    seqApiKey: overrides.seqApiKey || process.env.SEQ_API_KEY || "",
    autoCapture: overrides.autoCapture ?? (process.env.AUTO_CAPTURE !== "false"),
    autoRecall: overrides.autoRecall ?? (process.env.AUTO_RECALL !== "false"),
    recallLimit: overrides.recallLimit || parseInt(process.env.RECALL_LIMIT) || 5,
    captureMaxChars: overrides.captureMaxChars || parseInt(process.env.CAPTURE_MAX_CHARS) || 2000,
    uiEnabled: overrides.uiEnabled ?? true,
  };
}

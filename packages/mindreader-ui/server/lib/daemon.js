/**
 * Python daemon management — long-running process that eliminates cold-start.
 * Communicates via stdin/stdout JSON protocol.
 *
 * Usage:
 *   import { createDaemon } from "./lib/daemon.js";
 *   const daemon = createDaemon(config, logger);
 *   const result = await daemon.mgDaemon("search", { q: "hello" });
 *   daemon.stop();
 */

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { venvPython } from "../config.js";
import { getTenantId } from "./tenant.js";

const execFileAsync = promisify(execFile);
const isWin = process.platform === "win32";

/**
 * Build the Python env object from config, merging with process.env.
 * @param {object} config
 * @returns {object}
 */
function _buildPyEnv(config) {
  const pyEnv = { ...process.env, PYTHONUNBUFFERED: "1" };
  if (config.llmProvider) pyEnv.LLM_PROVIDER = config.llmProvider;
  if (config.llmApiKey) pyEnv.LLM_API_KEY = config.llmApiKey;
  if (config.llmBaseUrl) pyEnv.LLM_BASE_URL = config.llmBaseUrl;
  if (config.llmModel) pyEnv.LLM_MODEL = config.llmModel;
  if (config.embedderApiKey) pyEnv.EMBEDDER_API_KEY = config.embedderApiKey;
  if (config.embedderBaseUrl) pyEnv.EMBEDDER_BASE_URL = config.embedderBaseUrl;
  if (config.embedderModel) pyEnv.EMBEDDER_MODEL = config.embedderModel;
  if (config.neo4jUri) pyEnv.NEO4J_URI = config.neo4jUri;
  if (config.neo4jUser) pyEnv.NEO4J_USER = config.neo4jUser;
  if (config.neo4jPassword) pyEnv.NEO4J_PASSWORD = config.neo4jPassword;
  return pyEnv;
}

/**
 * Create a daemon manager instance.
 *
 * @param {object} config - Server config with pythonPath, llmApiKey, etc.
 * @param {object} [logger] - Optional logger with info/warn methods.
 * @returns {{ mgDaemon: Function, mgExec: Function, stop: Function }}
 */
export function createDaemon(config, logger) {
  let _daemonProc = null;
  let _daemonReady = false;
  let _daemonPending = new Map(); // id -> { resolve, reject, timer }
  let _daemonBuffer = "";
  let _reqCounter = 0;

  function _startDaemon() {
    if (_daemonProc) return;
    const pythonDir = config.pythonPath;
    const pyEnv = _buildPyEnv(config);
    const pyExe = venvPython(pythonDir);
    const daemonScript = join(pythonDir, "mg_daemon.py");

    let bootScript = null; // only used on Unix

    if (isWin) {
      _daemonProc = spawn(pyExe, ["-u", daemonScript], { env: pyEnv, cwd: pythonDir, stdio: ["pipe", "pipe", "pipe"] });
    } else {
      bootScript = join(tmpdir(), `mg_daemon_boot_${Date.now()}.sh`);
      writeFileSync(bootScript, [
        "#!/bin/bash",
        `cd "${pythonDir}"`,
        "source .venv/bin/activate",
        `exec python -u mg_daemon.py`,
      ].join("\n"), { mode: 0o755 });
      _daemonProc = spawn("/bin/bash", [bootScript], { env: pyEnv, stdio: ["pipe", "pipe", "pipe"] });
    }
    _daemonReady = false;

    _daemonProc.stdout.on("data", (chunk) => {
      _daemonBuffer += chunk.toString();
      let lines = _daemonBuffer.split("\n");
      _daemonBuffer = lines.pop(); // keep incomplete line in buffer
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        if (trimmed === "READY") {
          _daemonReady = true;
          logger?.info?.("MindReader: Python daemon ready");
          continue;
        }
        if (trimmed === "PONG") continue;
        try {
          const resp = JSON.parse(trimmed);
          const pending = _daemonPending.get(resp.id);
          if (pending) {
            clearTimeout(pending.timer);
            _daemonPending.delete(resp.id);
            if (resp.ok) {
              pending.resolve(resp);
            } else {
              logger?.warn?.(`daemon error response [${resp.id}]: ${resp.error}`);
              pending.reject(new Error(resp.error || "Daemon command failed"));
            }
          }
        } catch {
          // Non-JSON output — ignore
        }
      }
    });

    _daemonProc.stderr.on("data", (chunk) => {
      const msg = chunk.toString().trim();
      if (msg) logger?.warn?.("mg-daemon stderr:", msg);
    });

    _daemonProc.on("exit", (code) => {
      logger?.warn?.(`MindReader: Python daemon exited (code ${code})`);
      _daemonProc = null;
      _daemonReady = false;
      // Reject all pending requests
      for (const [id, pending] of _daemonPending) {
        clearTimeout(pending.timer);
        pending.reject(new Error("Daemon exited"));
      }
      _daemonPending.clear();
      if (bootScript) try { unlinkSync(bootScript); } catch {}
    });
  }

  function _stopDaemon() {
    if (_daemonProc) {
      _daemonProc.stdin.end();
      _daemonProc.kill();
      _daemonProc = null;
      _daemonReady = false;
    }
  }

  async function mgDaemon(cmd, args = {}, timeoutMs = 30000) {
    if (!_daemonProc || !_daemonReady) {
      _startDaemon();
      // Wait for READY (max 30s)
      const deadline = Date.now() + 30000;
      while (!_daemonReady && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (!_daemonReady) throw new Error("Daemon failed to start within 30s");
    }

    const id = `req_${++_reqCounter}`;
    const req = JSON.stringify({ id, cmd, args: { ...args, tenantId: getTenantId() } }) + "\n";
    const contentLen = args.content ? args.content.length : 0;
    logger?.info?.(`daemon >> ${cmd} [${id}] content=${contentLen}c payload=${req.length}b timeout=${timeoutMs}ms`);
    const sentAt = Date.now();

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        _daemonPending.delete(id);
        const err = new Error(`Daemon command "${cmd}" timed out after ${timeoutMs}ms`);
        logger?.warn?.(`daemon << ${cmd} [${id}] TIMEOUT after ${timeoutMs}ms`);
        reject(err);
      }, timeoutMs);
      _daemonPending.set(id, {
        resolve: (resp) => {
          logger?.info?.(`daemon << ${cmd} [${id}] OK ${Date.now() - sentAt}ms`);
          resolve(resp);
        },
        reject: (err) => {
          logger?.warn?.(`daemon << ${cmd} [${id}] ERROR ${Date.now() - sentAt}ms: ${err.message}`);
          reject(err);
        },
        timer,
      });
      _daemonProc.stdin.write(req);
    });
  }

  // Fallback for commands not yet supported by daemon
  async function mgExec(args, timeoutMs = 30000) {
    const pythonDir = config.pythonPath;
    const pyEnv = _buildPyEnv(config);
    const pyExe = venvPython(pythonDir);
    const cliScript = join(pythonDir, "mg_cli.py");

    if (isWin) {
      try {
        const { stdout } = await execFileAsync(pyExe, ["-u", cliScript, ...args], {
          timeout: timeoutMs,
          env: pyEnv,
          cwd: pythonDir,
        });
        return stdout.trim();
      } catch (err) {
        if (err.stdout?.trim()) return err.stdout.trim();
        throw new Error(`mg CLI error: ${err.stderr || err.message}`);
      }
    }

    // Unix: use bash script to activate venv
    const uid = Math.random().toString(36).slice(2, 8);
    const tmpScript = join(tmpdir(), `mg_exec_${Date.now()}_${uid}.sh`);
    try {
      writeFileSync(tmpScript, [
        "#!/bin/bash",
        `cd "${pythonDir}"`,
        "source .venv/bin/activate",
        `exec python -u mg_cli.py "$@"`,
      ].join("\n"), { mode: 0o755 });

      const { stdout } = await execFileAsync("/bin/bash", [tmpScript, ...args], {
        timeout: timeoutMs,
        env: pyEnv,
      });
      return stdout.trim();
    } catch (err) {
      if (err.stdout?.trim()) return err.stdout.trim();
      throw new Error(`mg CLI error: ${err.stderr || err.message}`);
    } finally {
      try { unlinkSync(tmpScript); } catch {}
    }
  }

  // Start daemon lazily on first use (eager start blocks OpenClaw plugin loading)
  function warmup() {
    try { _startDaemon(); } catch (err) { logger?.warn?.("Could not start Python daemon:", err.message); }
  }

  return { mgDaemon, mgExec, stop: _stopDaemon, warmup };
}

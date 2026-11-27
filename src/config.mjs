import { win32 } from "node:path";

import { resolveUpstreamCredential } from "./upstream-credential.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 18787;
const DEFAULT_API_KEY = "toolbox-spike-key";
const DEFAULT_DATA_DIR = "D:/Projects/toolbox/toolbox-router";
const DEFAULT_MODEL_ROOT = "D:/LMStudio_Downloads";
const DEFAULT_MIN_FREE_BYTES = 5 * 1024 ** 3;
const DEFAULT_UPSTREAM_BASE_URL = "http://127.0.0.1:7770/v1";
const DEFAULT_UPSTREAM_MODEL = "gemini-3.8-flash-low";
const FALLBACK_UPSTREAM_MODEL = "gpt-oss-120b-medium";

/** The public spike key is accepted only by mock mode, never by a live bridge. */
export function assertSecureRouterKey(config) {
  if (config.mode === "bridge" && (config.apiKey === DEFAULT_API_KEY || config.apiKey.length < 16)) {
    throw new Error("Bridge mode requires a unique Router API key of at least 16 characters. Run the Qoder setup or set TOOLBOX_ROUTER_API_KEY.");
  }
}

/** A wildcard host listens on every interface and is advertised to clients as loopback. */
export function isWildcardHost(host) {
  return ["0.0.0.0", "::", "*"].includes(host.trim().toLowerCase());
}

/** The address clients should use to reach a Router bound to the given host. */
export function advertisedHost(host) {
  return isWildcardHost(host) ? "127.0.0.1" : host;
}

function readInteger(env, name, fallback, min, max) {
  const raw = env[name]?.trim() || String(fallback);
  if (!/^\d+$/.test(raw)) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function normalizeDPath(value, name) {
  const trimmed = value.trim();
  if (!win32.isAbsolute(trimmed) || !/^d:[\\/]/i.test(trimmed)) {
    throw new Error(`${name} must be an absolute path on D: drive`);
  }
  return trimmed.replaceAll("\\", "/").replace(/\/+$/, "");
}

function normalizeLocalPath(value, name) {
  const trimmed = value.trim();
  if (!win32.isAbsolute(trimmed) || !/^[a-z]:[\\/]/i.test(trimmed)) {
    throw new Error(`${name} must be an absolute local drive path`);
  }
  const normalized = trimmed.replaceAll("\\", "/").replace(/\/+$/, "");
  return /^[a-z]:$/i.test(normalized) ? `${normalized}/` : normalized;
}

function normalizeLogPath(value) {
  const trimmed = value.trim();
  if (win32.isAbsolute(trimmed) && !/^[a-z]:[\\/]/i.test(trimmed)) {
    throw new Error("TOOLBOX_ROUTER_LOG_FILE must be an absolute local drive path or relative to TOOLBOX_ROUTER_DATA_DIR");
  }
  return trimmed.replaceAll("\\", "/");
}

function parseMcpArgs(raw) {
  if (!raw?.trim()) return [];

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("TOOLBOX_ROUTER_MCP_ARGS must be a JSON array of strings");
  }

  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new Error("TOOLBOX_ROUTER_MCP_ARGS must be a JSON array of strings");
  }
  return value;
}

function normalizeBaseUrl(raw, required) {
  const value = raw.trim().replace(/\/+$/, "");
  if (!value) {
    if (required) throw new Error("TOOLBOX_ROUTER_UPSTREAM_BASE_URL is required in bridge mode");
    return "";
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("TOOLBOX_ROUTER_UPSTREAM_BASE_URL must be a valid HTTP(S) URL");
  }

  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new Error("TOOLBOX_ROUTER_UPSTREAM_BASE_URL must be a valid HTTP(S) URL without credentials");
  }
  return value;
}

function parseModelCatalog(raw, defaultUpstreamModel, bridgeMode) {
  if (!raw?.trim()) {
    if (!bridgeMode) {
      return [{ id: "toolbox-spike", upstreamModel: defaultUpstreamModel || "mock", requiredBytes: 0 }];
    }

    return [
      { id: "toolbox-spike", upstreamModel: defaultUpstreamModel, requiredBytes: 0 },
      { id: "toolbox-spike-fast", upstreamModel: FALLBACK_UPSTREAM_MODEL, requiredBytes: 0 },
    ];
  }

  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("TOOLBOX_ROUTER_MODELS must be a JSON array of model definitions");
  }

  if (!Array.isArray(value) || value.length === 0 || value.length > 20) {
    throw new Error("TOOLBOX_ROUTER_MODELS must contain between 1 and 20 model definitions");
  }

  const ids = new Set();
  return value.map((model, index) => {
    const id = typeof model?.id === "string" ? model.id.trim() : "";
    const upstreamModel = typeof model?.upstreamModel === "string" ? model.upstreamModel.trim() : "";
    const requiredBytes = model?.requiredBytes ?? 0;
    if (
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id) ||
      !upstreamModel ||
      upstreamModel.length > 256 ||
      /[\u0000-\u001f\u007f]/.test(upstreamModel) ||
      !Number.isSafeInteger(requiredBytes) ||
      requiredBytes < 0
    ) {
      throw new Error(`TOOLBOX_ROUTER_MODELS entry ${index} is invalid`);
    }
    if (ids.has(id)) throw new Error(`TOOLBOX_ROUTER_MODELS contains duplicate model id: ${id}`);
    ids.add(id);
    return { id, upstreamModel, requiredBytes };
  });
}

export function parseConfig(env = process.env) {
  const host = env.TOOLBOX_ROUTER_HOST?.trim() || DEFAULT_HOST;
  const rawPort = env.TOOLBOX_ROUTER_PORT?.trim() || String(DEFAULT_PORT);
  const apiKey = env.TOOLBOX_ROUTER_API_KEY?.trim() || DEFAULT_API_KEY;
  const mode = (env.TOOLBOX_ROUTER_MODE?.trim() || "mock").toLowerCase();
  const dataDir = normalizeLocalPath(env.TOOLBOX_ROUTER_DATA_DIR?.trim() || DEFAULT_DATA_DIR, "TOOLBOX_ROUTER_DATA_DIR");
  const modelRoot = normalizeDPath(env.TOOLBOX_ROUTER_MODEL_ROOT?.trim() || DEFAULT_MODEL_ROOT, "TOOLBOX_ROUTER_MODEL_ROOT");
  const mcpHome = normalizeLocalPath(env.TOOLBOX_ROUTER_MCP_HOME?.trim() || `${dataDir}/mcp-home`, "TOOLBOX_ROUTER_MCP_HOME");
  const logFile = normalizeLogPath(env.TOOLBOX_ROUTER_LOG_FILE?.trim() || `${dataDir}/logs/router.jsonl`);
  const capacityDrive = (env.TOOLBOX_ROUTER_CAPACITY_DRIVE?.trim() || "D:").toUpperCase();
  const mcpRuntime = (env.TOOLBOX_ROUTER_MCP_RUNTIME?.trim() || "source").toLowerCase();

  if (!/^\d+$/.test(rawPort)) {
    throw new Error("TOOLBOX_ROUTER_PORT port must be an integer between 1 and 65535");
  }

  const port = Number(rawPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("TOOLBOX_ROUTER_PORT port must be an integer between 1 and 65535");
  }

  if (apiKey.length < 8) {
    throw new Error("TOOLBOX_ROUTER_API_KEY must contain at least 8 characters");
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(host.toLowerCase()) &&
      (apiKey === DEFAULT_API_KEY || apiKey.length < 16)) {
    throw new Error("A non-loopback Router requires an explicit API key of at least 16 characters.");
  }

  if (!['mock', 'bridge'].includes(mode)) {
    throw new Error(`Unsupported TOOLBOX_ROUTER_MODE: ${mode}`);
  }

  if (capacityDrive !== "D:") {
    throw new Error("TOOLBOX_ROUTER_CAPACITY_DRIVE must be D:; C: capacity is intentionally ignored");
  }

  if (!['source', 'portable', 'installed'].includes(mcpRuntime)) {
    throw new Error(`Unsupported TOOLBOX_ROUTER_MCP_RUNTIME: ${mcpRuntime}`);
  }

  const credential = mode === "bridge"
    ? resolveUpstreamCredential(env)
    : { apiKey: "", source: "none" };
  const upstream = {
    baseUrl: normalizeBaseUrl(
      env.TOOLBOX_ROUTER_UPSTREAM_BASE_URL?.trim() ||
        (mode === "bridge" ? DEFAULT_UPSTREAM_BASE_URL : ""),
      mode === "bridge",
    ),
    apiKey: credential.apiKey,
    apiKeySource: credential.source,
    model:
      env.TOOLBOX_ROUTER_UPSTREAM_MODEL?.trim() ||
      (mode === "bridge" ? DEFAULT_UPSTREAM_MODEL : ""),
    timeoutMs: readInteger(env, "TOOLBOX_ROUTER_UPSTREAM_TIMEOUT_MS", 120_000, 1_000, 600_000),
    maxRetries: readInteger(env, "TOOLBOX_ROUTER_UPSTREAM_MAX_RETRIES", 2, 0, 3),
  };

  if (mode === "bridge") {
    if (!upstream.apiKey) throw new Error("TOOLBOX_ROUTER_UPSTREAM_API_KEY is required in bridge mode");
    if (!upstream.model) throw new Error("TOOLBOX_ROUTER_UPSTREAM_MODEL is required in bridge mode");
  }

  const mcp = {
    runtime: mcpRuntime,
    command: env.TOOLBOX_ROUTER_MCP_COMMAND?.trim() || process.execPath,
    args: parseMcpArgs(env.TOOLBOX_ROUTER_MCP_ARGS),
    cwd: env.TOOLBOX_ROUTER_MCP_CWD?.trim() || "",
    home: mcpHome,
    contractPath: env.TOOLBOX_ROUTER_MCP_CONTRACT_PATH?.trim()
      ? normalizeLocalPath(env.TOOLBOX_ROUTER_MCP_CONTRACT_PATH.trim(), "TOOLBOX_ROUTER_MCP_CONTRACT_PATH")
      : "",
    port: 0,
    startupTimeoutMs: readInteger(env, "TOOLBOX_ROUTER_MCP_STARTUP_TIMEOUT_MS", 15_000, 1_000, 120_000),
    callTimeoutMs: readInteger(env, "TOOLBOX_ROUTER_MCP_CALL_TIMEOUT_MS", 30_000, 100, 600_000),
    maxResultBytes: readInteger(env, "TOOLBOX_ROUTER_MCP_MAX_RESULT_BYTES", 1024 ** 2, 1_024, 16 * 1024 ** 2),
  };

  return {
    host,
    port,
    apiKey,
    mode,
    dataDir,
    modelRoot,
    mcpHome,
    capacityDrive,
    minFreeBytes: readInteger(env, "TOOLBOX_ROUTER_MIN_FREE_BYTES", DEFAULT_MIN_FREE_BYTES, 0, 1024 ** 4),
    logFile,
    models: parseModelCatalog(env.TOOLBOX_ROUTER_MODELS, upstream.model, mode === "bridge"),
    upstream,
    mcp,
    limits: {
      maxModelRounds: readInteger(env, "TOOLBOX_ROUTER_MAX_MODEL_ROUNDS", 6, 1, 20),
      maxToolCallsPerRound: readInteger(env, "TOOLBOX_ROUTER_MAX_TOOL_CALLS_PER_ROUND", 4, 1, 20),
    },
  };
}

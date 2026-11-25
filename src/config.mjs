const DEFAULT_HOST = "192.168.100.66";
const DEFAULT_PORT = 18787;
const DEFAULT_API_KEY = "toolbox-spike-key";

export function parseConfig(env = process.env) {
  const host = env.TOOLBOX_ROUTER_HOST?.trim() || DEFAULT_HOST;
  const rawPort = env.TOOLBOX_ROUTER_PORT?.trim() || String(DEFAULT_PORT);
  const apiKey = env.TOOLBOX_ROUTER_API_KEY?.trim() || DEFAULT_API_KEY;
  const mode = env.TOOLBOX_ROUTER_MODE?.trim() || "mock";
  const logFile = env.TOOLBOX_ROUTER_LOG_FILE?.trim() || "";

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

  if (mode !== "mock") {
    throw new Error(`Unsupported TOOLBOX_ROUTER_MODE: ${mode}`);
  }

  return { host, port, apiKey, mode, logFile };
}

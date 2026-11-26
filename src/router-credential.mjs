import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Read only the existing local Qoder Router provider, never the upstream key. */
export function readQoderRouterKey(env = process.env, { read = readFileSync, home = homedir() } = {}) {
  const settingsPath = env.TOOLBOX_ROUTER_QODER_SETTINGS?.trim() || join(home, ".qoder", "settings.json");
  try {
    const settings = JSON.parse(read(settingsPath, "utf8"));
    const matches = Object.values(settings?.providers || {}).filter(value => value && typeof value === "object" &&
      value.model === "toolbox-spike" && ["http://127.0.0.1:18787/v1", "http://localhost:18787/v1"].includes(value.baseUrl));
    return matches.length === 1 && typeof matches[0].apiKey === "string" ? matches[0].apiKey.trim() : "";
  } catch { return ""; }
}

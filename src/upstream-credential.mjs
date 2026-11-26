import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_PROVIDER = "local-chat";
const DISABLED_PROVIDER = "none";

export function resolveUpstreamCredential(
  env = process.env,
  { readFileSync: read = readFileSync, home = homedir() } = {},
) {
  const explicit = env.TOOLBOX_ROUTER_UPSTREAM_API_KEY?.trim();
  if (explicit) return { apiKey: explicit, source: "environment" };

  const provider = env.TOOLBOX_ROUTER_QODER_PROVIDER?.trim() || DEFAULT_PROVIDER;
  if (provider.toLowerCase() === DISABLED_PROVIDER) return { apiKey: "", source: "none" };

  const settingsPath =
    env.TOOLBOX_ROUTER_QODER_SETTINGS?.trim() || join(home, ".qoder", "settings.json");

  try {
    const settings = JSON.parse(read(settingsPath, "utf8"));
    const apiKey = settings?.providers?.[provider]?.apiKey;
    if (typeof apiKey !== "string" || !apiKey.trim()) return { apiKey: "", source: "none" };
    return { apiKey: apiKey.trim(), source: "qoder-settings" };
  } catch {
    return { apiKey: "", source: "none" };
  }
}

// Explicit integration check: use an isolated MCP home and print no tool data.
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../src/config.mjs";
import { ToolboxMcpBridge } from "../src/mcp-bridge.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const parent = join(root, "test-mcp");
await mkdir(parent, { recursive: true });
const home = await mkdtemp(join(parent, "live-check-"));
const config = parseConfig({
  TOOLBOX_ROUTER_MCP_RUNTIME: "source",
  TOOLBOX_ROUTER_MCP_COMMAND: process.execPath,
  TOOLBOX_ROUTER_MCP_ARGS: JSON.stringify([resolve(root, "../toolbox-mcp/dist/index.js")]),
  TOOLBOX_ROUTER_MCP_CWD: resolve(root, "../toolbox-mcp"),
  TOOLBOX_ROUTER_MCP_HOME: home,
});
const bridge = new ToolboxMcpBridge({ config, logger: { info() {}, error() {} } });
try {
  await bridge.start();
  if (!bridge.status().ready || !bridge.registry.has("system_stats")) throw new Error("MCP did not expose system_stats.");
  const result = await bridge.callTool("system_stats");
  if (result.isError || !result.content) throw new Error("The read-only MCP test call failed.");
  console.log(`Local Toolbox MCP integration passed (${bridge.status().toolCount} allowed tools discovered).`);
} finally {
  await bridge.close();
  await rm(home, { recursive: true, force: true });
}

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod/v4";

const server = new McpServer({ name: "toolbox-router-fake-mcp", version: "1.0.0" });

server.registerTool(
  "system_stats",
  {
    description: "Fake system stats for router lifecycle tests",
    inputSchema: {
      refresh: z.boolean().optional(),
      fail: z.boolean().optional(),
      delayMs: z.number().optional(),
      large: z.boolean().optional(),
      showEnv: z.boolean().optional(),
    },
  },
  async ({ fail = false, delayMs = 0, large = false, showEnv = false }) => {
    if (delayMs > 0) await delay(delayMs);
    if (fail) {
      return { isError: true, content: [{ type: "text", text: "fake system stats failure" }] };
    }
    if (large) {
      return { content: [{ type: "text", text: "x".repeat(5000) }] };
    }
    if (showEnv) {
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              home: process.env.TOOLBOX_MCP_HOME,
              port: process.env.TOOLBOX_MCP_PORT,
            }),
          },
        ],
      };
    }
    return { content: [{ type: "text", text: '{"cpu":12,"memory":34}' }] };
  },
);

server.registerTool(
  "crypto_status",
  { description: "Fake crypto status", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: '{"watchlist":["bitcoin"]}' }] }),
);

server.registerTool(
  "gmail_check",
  { description: "Fake sensitive Gmail read", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "fake inbox metadata" }] }),
);

server.registerTool(
  "gmail_connect",
  {
    description: "Must never be exposed by the router",
    inputSchema: { email: z.string(), password: z.string() },
  },
  async () => ({ content: [{ type: "text", text: "must not run" }] }),
);

server.registerTool(
  "remote_dynamic_shell",
  { description: "Must never be exposed by the router", inputSchema: {} },
  async () => ({ content: [{ type: "text", text: "must not run" }] }),
);

await server.connect(new StdioServerTransport());
process.stdin.on("end", () => {
  void server.close().finally(() => process.exit(0));
});

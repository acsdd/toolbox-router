import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import { parseConfig } from "../src/config.mjs";
import { routerPolicyManifest } from "../src/contract-audit.mjs";
import { ToolboxMcpBridge } from "../src/mcp-bridge.mjs";

const FAKE_SERVER = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const NOISY_SERVER = fileURLToPath(new URL("./fixtures/noisy-mcp-server.mjs", import.meta.url));
const TEST_ROOT = "D:/Projects/toolbox/toolbox-router/test-mcp";
const cleanup = [];

const silentLogger = { info() {}, error() {} };

async function startBridge(overrides = {}, logger = silentLogger) {
  await mkdir(TEST_ROOT, { recursive: true });
  const home = await mkdtemp(join(TEST_ROOT, "home-"));
  cleanup.push(home);
  const config = parseConfig({
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
    TOOLBOX_ROUTER_UPSTREAM_MODEL: "test-model",
    TOOLBOX_ROUTER_MCP_RUNTIME: "source",
    TOOLBOX_ROUTER_MCP_COMMAND: process.execPath,
    TOOLBOX_ROUTER_MCP_ARGS: JSON.stringify([FAKE_SERVER]),
    TOOLBOX_ROUTER_MCP_HOME: home,
    TOOLBOX_ROUTER_MCP_STARTUP_TIMEOUT_MS: "5000",
    TOOLBOX_ROUTER_MCP_CALL_TIMEOUT_MS: "1000",
    TOOLBOX_ROUTER_MCP_MAX_RESULT_BYTES: "1024",
    ...overrides,
  });
  const bridge = new ToolboxMcpBridge({ config, logger });
  cleanup.push(() => bridge.close());
  await bridge.start();
  return bridge;
}

after(async () => {
  for (const item of cleanup.reverse()) {
    if (typeof item === "function") await item();
    else await rm(item, { recursive: true, force: true });
  }
});

test("MCP bridge starts a real stdio child and filters its discovered tool surface", async () => {
  const bridge = await startBridge();
  const names = bridge.tools.map((tool) => tool.function.name);

  assert.equal(bridge.ready, true);
  assert.deepEqual(names, ["system_stats", "crypto_status", "gmail_check"]);
  assert.equal(names.includes("gmail_connect"), false);
  assert.equal(names.includes("remote_dynamic_shell"), false);
  assert.equal(bridge.status().toolCount, 3);
  assert.equal(bridge.status().contract.status, "unavailable");
  assert.match(bridge.status().home, /^D:\/Projects\/toolbox\/toolbox-router\/test-mcp\//);
});

test("MCP bridge fails startup when a shipped contract disagrees with discovery", async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  const home = await mkdtemp(join(TEST_ROOT, "contract-drift-"));
  cleanup.push(home);
  const contractPath = join(home, "tool-contract.json");
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  const contract = {
    schemaVersion: 1,
    service: "toolbox-mcp",
    version: "test",
    groups: [],
    tools: routerPolicyManifest().tools.map(({ name }) => ({
      name,
      group: "system",
      description: name,
      inputSchema: { type: "object", properties: {} },
      annotations: { ...annotations },
    })),
  };
  await writeFile(contractPath, JSON.stringify(contract));

  const entries = [];
  const config = parseConfig({
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
    TOOLBOX_ROUTER_UPSTREAM_MODEL: "test-model",
    TOOLBOX_ROUTER_MCP_RUNTIME: "source",
    TOOLBOX_ROUTER_MCP_COMMAND: process.execPath,
    TOOLBOX_ROUTER_MCP_ARGS: JSON.stringify([FAKE_SERVER]),
    TOOLBOX_ROUTER_MCP_HOME: home,
    TOOLBOX_ROUTER_MCP_CONTRACT_PATH: contractPath,
    TOOLBOX_ROUTER_MCP_STARTUP_TIMEOUT_MS: "5000",
  });
  const bridge = new ToolboxMcpBridge({
    config,
    logger: { info: (line) => entries.push(line), error: (line) => entries.push(line) },
  });
  cleanup.push(() => bridge.close());

  await assert.rejects(() => bridge.start(), /contract does not match/);
  assert.equal(bridge.ready, false);
  assert.equal(bridge.status().contract.status, "drift");
  assert.match(entries.join("\n"), /mcp_contract_audit/);
  assert.doesNotMatch(entries.join("\n"), /remote_dynamic_shell/);
});

test("MCP bridge creates an isolated home and passes a disabled ops-panel port", async () => {
  const bridge = await startBridge();
  const result = await bridge.callTool("system_stats", { showEnv: true });
  const env = JSON.parse(result.content);

  assert.equal(env.port, "0");
  assert.equal(env.home, bridge.status().home);
});

test("MCP bridge converts text results and preserves MCP error status", async () => {
  const bridge = await startBridge();

  const success = await bridge.callTool("system_stats", {});
  assert.equal(success.isError, false);
  assert.equal(success.content, '{"cpu":12,"memory":34}');

  const failure = await bridge.callTool("system_stats", { fail: true });
  assert.equal(failure.isError, true);
  assert.match(failure.content, /fake system stats failure/);
});

test("MCP bridge caps oversized results before they reach the model", async () => {
  const bridge = await startBridge();
  const result = await bridge.callTool("system_stats", { large: true });

  assert.equal(result.isError, true);
  assert.match(result.content, /exceeded/);
  assert.ok(Buffer.byteLength(result.content) <= 1024);
});

test("MCP bridge times out a stalled tool call", async () => {
  const bridge = await startBridge({ TOOLBOX_ROUTER_MCP_CALL_TIMEOUT_MS: "100" });

  await assert.rejects(() => bridge.callTool("system_stats", { delayMs: 500 }), /timed out/i);
});

test("MCP bridge forwards cancellation to an in-flight tool call", async () => {
  const bridge = await startBridge({ TOOLBOX_ROUTER_MCP_CALL_TIMEOUT_MS: "2000" });
  const controller = new AbortController();
  const pending = bridge.callTool("system_stats", { delayMs: 500 }, { signal: controller.signal });
  controller.abort();

  await assert.rejects(() => pending, /abort|cancel/i);
});

test("MCP bridge rejects blocked and undiscovered tools before dispatch", async () => {
  const bridge = await startBridge();

  await assert.rejects(() => bridge.callTool("gmail_connect", { password: "secret" }), /not available/);
  await assert.rejects(() => bridge.callTool("remote_dynamic_shell", {}), /not available/);
});

test("MCP bridge logs metadata without tool arguments or result bodies", async () => {
  const entries = [];
  const bridge = await startBridge({}, { info: (line) => entries.push(line), error() {} });

  await bridge.callTool("system_stats", { refresh: true, secret: "do-not-log-this" });
  const logs = entries.join("\n");
  assert.match(logs, /mcp_tool_call/);
  assert.match(logs, /system_stats/);
  assert.doesNotMatch(logs, /do-not-log-this/);
  assert.doesNotMatch(logs, /cpu/);
});

test("MCP bridge logs tool failures without error bodies or arguments", async () => {
  const entries = [];
  const bridge = await startBridge({}, { info: (line) => entries.push(line), error: (line) => entries.push(line) });
  bridge.client = {
    async callTool() {
      const error = new Error("private-mcp-error-secret");
      error.name = "private-mcp-error-name-secret";
      throw error;
    },
  };

  await assert.rejects(
    () => bridge.callTool("system_stats", { secret: "do-not-log-this" }),
    /private-mcp-error-secret/,
  );

  const logs = entries.join("\n");
  assert.match(logs, /mcp_tool_call/);
  assert.match(logs, /"status":"failed"/);
  assert.doesNotMatch(logs, /do-not-log-this/);
  assert.doesNotMatch(logs, /private-mcp-error-secret/);
  assert.doesNotMatch(logs, /private-mcp-error-name-secret/);
});

test("MCP bridge startup logs exclude child stderr", async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  const home = await mkdtemp(join(TEST_ROOT, "home-"));
  cleanup.push(home);
  const entries = [];
  const config = parseConfig({
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
    TOOLBOX_ROUTER_UPSTREAM_MODEL: "test-model",
    TOOLBOX_ROUTER_MCP_COMMAND: process.execPath,
    TOOLBOX_ROUTER_MCP_ARGS: JSON.stringify([NOISY_SERVER]),
    TOOLBOX_ROUTER_MCP_HOME: home,
  });
  const bridge = new ToolboxMcpBridge({
    config,
    logger: { info: (line) => entries.push(line), error: (line) => entries.push(line) },
  });
  cleanup.push(() => bridge.close());

  await assert.rejects(() => bridge.start());
  assert.equal(bridge.ready, false);
  const logs = entries.join("\n");
  assert.match(logs, /mcp_startup/);
  assert.doesNotMatch(logs, /private-mcp-stderr-secret/);
});

test("MCP bridge close waits for the stdio child to exit", async () => {
  const bridge = await startBridge();
  const pid = bridge.status().pid;
  assert.equal(typeof pid, "number");

  await bridge.close();

  assert.equal(bridge.ready, false);
  assert.equal(bridge.status().pid, null);
  assert.throws(() => process.kill(pid, 0), (error) => error.code === "ESRCH");
});

test("MCP bridge reports startup failure instead of pretending to be ready", async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  const home = await mkdtemp(join(TEST_ROOT, "home-"));
  cleanup.push(home);
  const config = parseConfig({
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
    TOOLBOX_ROUTER_UPSTREAM_MODEL: "test-model",
    TOOLBOX_ROUTER_MCP_COMMAND: "D:/Projects/toolbox/toolbox-router/missing-node.exe",
    TOOLBOX_ROUTER_MCP_ARGS: JSON.stringify([FAKE_SERVER]),
    TOOLBOX_ROUTER_MCP_HOME: home,
  });
  const bridge = new ToolboxMcpBridge({ config, logger: silentLogger });

  await assert.rejects(() => bridge.start(), /connection closed|spawn|ENOENT|not found/i);
  assert.equal(bridge.ready, false);
  await bridge.close();
});

test("ensureReady restarts once after unexpected close and shares a single flight", async () => {
  const bridge = await startBridge();
  process.kill(bridge.pid, "SIGKILL");
  await bridge.closedPromise;
  assert.equal(bridge.ready, false);

  const first = bridge.ensureReady();
  const second = bridge.ensureReady();
  assert.equal(first, second);
  await first;

  assert.equal(bridge.ready, true);
  assert.equal(bridge.tools.length, 3);
  assert.equal(bridge.restartAttempts, 0);
});

test("ensureReady fails closed when the restarted contract drifts", async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  const home = await mkdtemp(join(TEST_ROOT, "restart-drift-"));
  cleanup.push(home);
  const contractPath = join(home, "tool-contract.json");
  const entries = [];
  const bridge = await startBridge(
    { TOOLBOX_ROUTER_MCP_CONTRACT_PATH: contractPath },
    { info: (line) => entries.push(line), error: (line) => entries.push(line) },
  );
  // Missing contract at startup is unavailable, so the first start succeeds.
  assert.equal(bridge.status().contract.status, "unavailable");

  process.kill(bridge.pid, "SIGKILL");
  await bridge.closedPromise;

  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
  const drifted = {
    schemaVersion: 1,
    service: "toolbox-mcp",
    version: "test",
    groups: [],
    tools: routerPolicyManifest().tools.map(({ name }) => ({
      name, group: "system", description: name,
      inputSchema: { type: "object", properties: {} },
      annotations: { ...annotations },
    })),
  };
  await writeFile(contractPath, JSON.stringify(drifted));

  await assert.rejects(() => bridge.ensureReady(), /contract does not match/);
  assert.equal(bridge.ready, false);
  assert.match(entries.join("\n"), /mcp_restart_failed/);
});

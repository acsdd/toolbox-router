import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

import { parseConfig } from "../src/config.mjs";
import { createRouterServer } from "../src/server.mjs";
import {
  assertPortAvailable,
  buildChildEnv,
  findIPv4Address,
  findPortableRuntime,
  prepareMcpRuntime,
  resolveInstalledRuntime,
  resolveLogPath,
  resolveSourceRuntime,
  runSmokeChecks,
  stopLaunchedProcess,
  stopRouterProcess,
} from "../scripts/launch-spike.mjs";

let server;
let baseUrl;

before(async () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_HOST: "127.0.0.1",
    TOOLBOX_ROUTER_PORT: "8787",
    TOOLBOX_ROUTER_API_KEY: "launcher-test-key",
  });
  server = createRouterServer({ config, logger: { info() {}, error() {} } });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test("findIPv4Address returns the matching non-internal interface", () => {
  const interfaces = {
    Ethernet: [
      { address: "192.168.1.20", family: "IPv4", internal: false },
      { address: "192.168.100.66", family: "IPv4", internal: false },
    ],
    Loopback: [{ address: "127.0.0.1", family: "IPv4", internal: true }],
  };

  const adapter = findIPv4Address("192.168.100.66", interfaces);
  assert.equal(adapter.address, "192.168.100.66");
  assert.equal(adapter.name, "Ethernet");
  assert.equal(findIPv4Address("192.168.100.99", interfaces), undefined);
});

test("assertPortAvailable rejects a port already in use", async () => {
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));

  try {
    await assertPortAvailable("127.0.0.1", listener.address().port);
    assert.fail("expected the occupied port check to fail");
  } catch (error) {
    assert.equal(error.code, "EADDRINUSE");
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});

test("buildChildEnv passes every explicit router parameter", () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_HOST: "192.168.100.66",
    TOOLBOX_ROUTER_PORT: "8787",
    TOOLBOX_ROUTER_API_KEY: "launcher-test-key",
    TOOLBOX_ROUTER_LOG_FILE: "logs/test.jsonl",
  });
  const childEnv = buildChildEnv(config, { PATH: "kept-path" });

  assert.equal(childEnv.PATH, "kept-path");
  assert.equal(childEnv.TOOLBOX_ROUTER_HOST, "192.168.100.66");
  assert.equal(childEnv.TOOLBOX_ROUTER_PORT, "8787");
  assert.equal(childEnv.TOOLBOX_ROUTER_API_KEY, "launcher-test-key");
  assert.equal(childEnv.TOOLBOX_ROUTER_MODE, "mock");
  assert.equal(childEnv.TOOLBOX_ROUTER_LOG_FILE, "D:/Projects/toolbox/toolbox-router/logs/test.jsonl");
});

test("buildChildEnv forwards bridge upstream MCP capacity and model settings", () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_HOST: "192.168.100.66",
    TOOLBOX_ROUTER_PORT: "18787",
    TOOLBOX_ROUTER_API_KEY: "launcher-test-key",
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
    TOOLBOX_ROUTER_UPSTREAM_MODEL: "grok-4.7",
    TOOLBOX_ROUTER_MCP_RUNTIME: "installed",
    TOOLBOX_ROUTER_MCP_COMMAND: "D:/Programs/Model Farm/Model Farm.exe",
    TOOLBOX_ROUTER_MCP_ARGS: '["D:/Programs/Model Farm/resources/app.asar/dist/index.js"]',
    TOOLBOX_ROUTER_MCP_CWD: "D:/Programs/Model Farm",
    TOOLBOX_ROUTER_MODELS: '[{"id":"toolbox-spike","upstreamModel":"grok-4.7"}]',
  });
  const childEnv = buildChildEnv(config, { PATH: "kept-path" });

  assert.equal(childEnv.TOOLBOX_ROUTER_UPSTREAM_BASE_URL, "http://localhost:7770/v1");
  assert.equal(childEnv.TOOLBOX_ROUTER_UPSTREAM_API_KEY, "upstream-test-key");
  assert.equal(childEnv.TOOLBOX_ROUTER_UPSTREAM_MODEL, "grok-4.7");
  assert.equal(childEnv.TOOLBOX_ROUTER_MCP_RUNTIME, "installed");
  assert.equal(childEnv.TOOLBOX_ROUTER_MCP_COMMAND, config.mcp.command);
  assert.equal(childEnv.TOOLBOX_ROUTER_MCP_ARGS, JSON.stringify(config.mcp.args));
  assert.equal(childEnv.TOOLBOX_ROUTER_DATA_DIR, config.dataDir);
  assert.equal(childEnv.TOOLBOX_ROUTER_MODEL_ROOT, config.modelRoot);
  assert.equal(childEnv.TOOLBOX_ROUTER_CAPACITY_DRIVE, "D:");
  assert.equal(childEnv.TOOLBOX_ROUTER_MIN_FREE_BYTES, String(config.minFreeBytes));
  assert.equal(childEnv.TOOLBOX_ROUTER_MODELS, JSON.stringify(config.models));
});

test("runtime resolution verifies source and installed entry points", () => {
  const source = resolveSourceRuntime("D:/Projects/Toolbox/toolbox-mcp", {
    existsSync: (path) => path === "D:/Projects/Toolbox/toolbox-mcp/dist/index.js",
  });
  assert.equal(source.command, process.execPath);
  assert.deepEqual(source.args, ["D:/Projects/Toolbox/toolbox-mcp/dist/index.js"]);
  assert.equal(source.runtime, "source");

  const config = parseConfig({ TOOLBOX_ROUTER_MCP_RUNTIME: "installed" });
  const installed = resolveInstalledRuntime(config, {
    env: { LOCALAPPDATA: "D:/Local", TOOLBOX_ROUTER_MCP_INSTALL_DIR: "D:/Programs/Model Farm" },
    existsSync: (path) =>
      path === "D:/Programs/Model Farm/Model Farm.exe" || path === "D:/Programs/Model Farm/resources/app.asar",
  });
  assert.equal(installed.command, "D:/Programs/Model Farm/Model Farm.exe");
  assert.deepEqual(installed.args, ["D:/Programs/Model Farm/resources/app.asar/dist/index.js"]);
  assert.equal(installed.runtime, "installed");
});

test("source runtime can use the bundled MCP directory", async () => {
  const config = parseConfig({ TOOLBOX_ROUTER_MCP_RUNTIME: "source" });
  const runtime = await prepareMcpRuntime(config, {
    env: { TOOLBOX_ROUTER_MCP_SOURCE_ROOT: "D:/bundle/mcp" },
    existsSync: path => path === "D:/bundle/mcp/dist/index.js",
  });
  assert.deepEqual(runtime.args, ["D:/bundle/mcp/dist/index.js"]);
  assert.equal(runtime.command, process.execPath);
});

test("portable discovery only accepts a newly extracted runtime with its asar archive", async () => {
  const runtime = await findPortableRuntime({
    tempRoot: "D:/Temp",
    baseline: new Set(["stale"]),
    readdirImpl: async () => [
      { name: "stale", isDirectory: () => true },
      { name: "unrelated", isDirectory: () => true },
      { name: "new-extraction", isDirectory: () => true },
    ],
    existsSync: (path) =>
      path === "D:/Temp/new-extraction/Model Farm.exe" || path === "D:/Temp/new-extraction/resources/app.asar",
  });

  assert.equal(runtime.command, "D:/Temp/new-extraction/Model Farm.exe");
  assert.deepEqual(runtime.args, ["D:/Temp/new-extraction/resources/app.asar/dist/index.js"]);
  assert.equal(runtime.runtime, "portable");
});

test("router shutdown requests graceful IPC cleanup before falling back to kill", async () => {
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.connected = true;
  let message;
  child.send = (value, callback) => {
    message = value;
    callback();
    queueMicrotask(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    });
  };
  child.kill = () => {
    throw new Error("Graceful IPC shutdown should not require a forced kill");
  };

  await stopRouterProcess(child, 100);

  assert.deepEqual(message, { type: "shutdown" });
  assert.equal(child.exitCode, 0);
});

test("portable preparation starts the GUI before returning its extracted headless runtime", async () => {
  const config = parseConfig({ TOOLBOX_ROUTER_MCP_RUNTIME: "portable" });
  const gui = new EventEmitter();
  gui.exitCode = null;
  gui.signalCode = null;
  gui.kill = () => {
    queueMicrotask(() => {
      gui.exitCode = 0;
      gui.emit("exit", 0, null);
    });
    return true;
  };
  let spawnOptions;
  const prepared = await prepareMcpRuntime(config, {
    env: { PATH: "kept-path" },
    tempRoot: "D:/Temp",
    portableExe: "D:/Dist/ModelFarm-Portable-0.9.25.exe",
    spawnImpl: (_command, _args, options) => {
      spawnOptions = options;
      return gui;
    },
    existsSync: () => true,
    findPortableRuntimeImpl: async () => ({
      runtime: "portable",
      command: "D:/Temp/extracted/Model Farm.exe",
      args: ["D:/Temp/extracted/resources/app.asar/dist/index.js"],
      cwd: "D:/Temp/extracted",
      extractDir: "D:/Temp/extracted",
    }),
  });

  assert.equal(spawnOptions.env.PATH, "kept-path");
  assert.equal(spawnOptions.env.TOOLBOX_MCP_HOME, config.mcpHome);
  assert.equal(spawnOptions.env.TOOLBOX_MCP_PORT, "0");
  assert.notEqual(spawnOptions.env.ELECTRON_RUN_AS_NODE, "1");
  assert.equal(prepared.gui, gui);
  assert.equal(prepared.command, "D:/Temp/extracted/Model Farm.exe");
  await stopLaunchedProcess(gui, 100);
  assert.equal(gui.exitCode, 0);
});

test("portable preparation defaults extraction and temp paths beneath the D-drive data directory", async () => {
  const config = parseConfig({ TOOLBOX_ROUTER_MCP_RUNTIME: "portable" });
  const gui = new EventEmitter();
  gui.exitCode = null;
  gui.signalCode = null;
  gui.kill = () => {
    queueMicrotask(() => {
      gui.exitCode = 0;
      gui.emit("exit", 0, null);
    });
    return true;
  };
  let spawnOptions;
  let discoveredTempRoot;

  const prepared = await prepareMcpRuntime(config, {
    env: { PATH: "kept-path", TEMP: "C:/Users/test/AppData/Local/Temp", TMP: "C:/Users/test/AppData/Local/Temp" },
    portableExe: "D:/Dist/ModelFarm-Portable-0.9.25.exe",
    spawnImpl: (_command, _args, options) => {
      spawnOptions = options;
      return gui;
    },
    existsSync: () => true,
    readdirImpl: async (root) => {
      discoveredTempRoot = root;
      return [];
    },
    findPortableRuntimeImpl: async ({ tempRoot }) => {
      discoveredTempRoot = tempRoot;
      return {
        runtime: "portable",
        command: "D:/Projects/toolbox/toolbox-router/portable-temp/extracted/Model Farm.exe",
        args: ["D:/Projects/toolbox/toolbox-router/portable-temp/extracted/resources/app.asar/dist/index.js"],
        cwd: "D:/Projects/toolbox/toolbox-router/portable-temp/extracted",
        extractDir: "D:/Projects/toolbox/toolbox-router/portable-temp/extracted",
      };
    },
  });

  assert.equal(discoveredTempRoot, "D:/Projects/toolbox/toolbox-router/portable-temp");
  assert.equal(spawnOptions.env.TEMP, "D:/Projects/toolbox/toolbox-router/portable-temp");
  assert.equal(spawnOptions.env.TMP, "D:/Projects/toolbox/toolbox-router/portable-temp");
  assert.equal(spawnOptions.env.PATH, "kept-path");
  assert.equal(prepared.gui, gui);
  await stopLaunchedProcess(gui, 100);
});

test("relative launcher logs resolve under the D-drive data directory", () => {
  const config = parseConfig({ TOOLBOX_ROUTER_LOG_FILE: "logs/test.jsonl" });
  assert.equal(resolveLogPath(config), "D:/Projects/toolbox/toolbox-router/logs/test.jsonl");
  assert.equal(resolveLogPath(parseConfig({})), "D:/Projects/toolbox/toolbox-router/logs/router.jsonl");
});

test("runSmokeChecks exercises models text streaming and tool calls", async () => {
  const results = await runSmokeChecks(baseUrl, "launcher-test-key");

  assert.equal(results.models, true);
  assert.equal(results.chat, true);
  assert.equal(results.stream, true);
  assert.equal(results.toolCall, true);
});

test("bridge smoke checks exercise a real router-owned MCP tool round trip", async () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_HOST: "127.0.0.1",
    TOOLBOX_ROUTER_API_KEY: "launcher-test-key",
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
    TOOLBOX_ROUTER_UPSTREAM_MODEL: "test-model",
  });
  let bridgeCalls = 0;
  const bridge = {
    ready: true,
    tools: [
      {
        type: "function",
        function: { name: "system_stats", parameters: { type: "object", properties: {} } },
      },
    ],
    status: () => ({ ready: true, toolCount: 1 }),
    async callTool() {
      bridgeCalls += 1;
      return { isError: false, content: '{"cpu":12}' };
    },
  };
  const upstream = {
    async complete(payload) {
      const asksForStats = payload.tool_choice === "required" && payload.tools?.some((tool) => tool.function.name === "system_stats");
      const hasToolResult = payload.messages.at(-1)?.role === "tool";
      const message = asksForStats && !hasToolResult
        ? {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_smoke_stats",
                type: "function",
                function: { name: "system_stats", arguments: "{}" },
              },
            ],
          }
        : { role: "assistant", content: "bridge smoke answer" };
      return {
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
    },
  };
  const bridgeServer = createRouterServer({
    config,
    bridge,
    upstream,
    getCapacity: async () => ({ ok: true, availableBytes: 700 }),
    logger: { info() {}, error() {} },
  });
  await new Promise((resolve) => bridgeServer.listen(0, "127.0.0.1", resolve));
  const bridgeBaseUrl = `http://127.0.0.1:${bridgeServer.address().port}`;
  try {
    const results = await runSmokeChecks(bridgeBaseUrl, "launcher-test-key", { mode: "bridge" });
    assert.equal(results.mcpTools, 1);
    assert.equal(results.toolCall, true);
    assert.equal(bridgeCalls, 1);
  } finally {
    bridgeServer.closeAllConnections();
    await new Promise((resolve) => bridgeServer.close(resolve));
  }
});

import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.mjs";

test("parseConfig defaults to a local-only spike address", () => {
  const config = parseConfig({});

  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 18787);
  assert.equal(config.mode, "mock");
  assert.ok(config.apiKey.length >= 8);
});

test("parseConfig applies explicit environment overrides", () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_HOST: "192.168.100.67",
    TOOLBOX_ROUTER_PORT: "9191",
    TOOLBOX_ROUTER_API_KEY: "explicit-test-key",
    TOOLBOX_ROUTER_MODE: "mock",
    TOOLBOX_ROUTER_LOG_FILE: "logs/custom.jsonl",
  });

  assert.equal(config.host, "192.168.100.67");
  assert.equal(config.port, 9191);
  assert.equal(config.apiKey, "explicit-test-key");
  assert.equal(config.logFile, "logs/custom.jsonl");
});

test("non-loopback binding requires a non-default strong key", () => {
  assert.throws(() => parseConfig({ TOOLBOX_ROUTER_HOST: "0.0.0.0" }), /explicit API key/);
  assert.throws(() => parseConfig({ TOOLBOX_ROUTER_HOST: "192.168.1.2", TOOLBOX_ROUTER_API_KEY: "short-key" }), /explicit API key/);
  assert.equal(parseConfig({ TOOLBOX_ROUTER_HOST: "192.168.1.2", TOOLBOX_ROUTER_API_KEY: "example-test-key-123" }).host, "192.168.1.2");
});

test("parseConfig rejects an invalid port instead of silently changing it", () => {
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_PORT: "70000" }),
    /port must be an integer between 1 and 65535/,
  );
});

test("parseConfig keeps runtime data and model capacity on D drive", () => {
  const config = parseConfig({});

  assert.equal(config.dataDir, "D:/Projects/toolbox/toolbox-router");
  assert.equal(config.mcpHome, "D:/Projects/toolbox/toolbox-router/mcp-home");
  assert.equal(config.modelRoot, "D:/LMStudio_Downloads");
  assert.equal(config.capacityDrive, "D:");
  assert.equal(config.minFreeBytes, 5 * 1024 ** 3);
  assert.equal(config.logFile, "D:/Projects/toolbox/toolbox-router/logs/router.jsonl");
  assert.equal(config.limits.maxModelRounds, 6);
  assert.equal(config.limits.maxToolCallsPerRound, 4);
});

test("parseConfig accepts explicit bridge upstream and MCP settings", () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
    TOOLBOX_ROUTER_UPSTREAM_MODEL: "grok-4.7",
    TOOLBOX_ROUTER_UPSTREAM_TIMEOUT_MS: "45000",
    TOOLBOX_ROUTER_MCP_RUNTIME: "portable",
    TOOLBOX_ROUTER_MCP_COMMAND: "D:/Projects/Toolbox/runtime/Model Farm.exe",
    TOOLBOX_ROUTER_MCP_ARGS: '["D:/Projects/Toolbox/runtime/resources/app.asar/dist/index.js"]',
    TOOLBOX_ROUTER_MCP_CWD: "D:/Projects/Toolbox/runtime",
    TOOLBOX_ROUTER_MCP_HOME: "D:/Projects/toolbox/toolbox-router/custom-home",
    TOOLBOX_ROUTER_MCP_STARTUP_TIMEOUT_MS: "20000",
    TOOLBOX_ROUTER_MCP_CALL_TIMEOUT_MS: "9000",
    TOOLBOX_ROUTER_MCP_MAX_RESULT_BYTES: "2048",
    TOOLBOX_ROUTER_MAX_MODEL_ROUNDS: "3",
    TOOLBOX_ROUTER_MAX_TOOL_CALLS_PER_ROUND: "2",
    TOOLBOX_ROUTER_MIN_FREE_BYTES: "1234",
  });

  assert.equal(config.upstream.baseUrl, "http://localhost:7770/v1");
  assert.equal(config.upstream.apiKey, "upstream-test-key");
  assert.equal(config.upstream.model, "grok-4.7");
  assert.equal(config.upstream.timeoutMs, 45000);
  assert.equal(config.mcp.runtime, "portable");
  assert.equal(config.mcp.command, "D:/Projects/Toolbox/runtime/Model Farm.exe");
  assert.deepEqual(config.mcp.args, [
    "D:/Projects/Toolbox/runtime/resources/app.asar/dist/index.js",
  ]);
  assert.equal(config.mcp.cwd, "D:/Projects/Toolbox/runtime");
  assert.equal(config.mcp.home, "D:/Projects/toolbox/toolbox-router/custom-home");
  assert.equal(config.mcp.startupTimeoutMs, 20000);
  assert.equal(config.mcp.callTimeoutMs, 9000);
  assert.equal(config.mcp.maxResultBytes, 2048);
  assert.equal(config.limits.maxModelRounds, 3);
  assert.equal(config.limits.maxToolCallsPerRound, 2);
  assert.equal(config.minFreeBytes, 1234);
});

test("parseConfig requires an upstream credential in bridge mode", () => {
  const env = {
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_QODER_SETTINGS: "D:/Config/missing-settings.json",
  };

  assert.throws(() => parseConfig(env), /UPSTREAM_API_KEY/);
});

test("parseConfig rejects unsupported MCP runtimes and malformed argument arrays", () => {
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_MCP_RUNTIME: "remote" }),
    /MCP_RUNTIME/,
  );
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_MCP_ARGS: "not-json" }),
    /MCP_ARGS/,
  );
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_MCP_ARGS: '["ok", 42]' }),
    /MCP_ARGS/,
  );
});

test("parseConfig rejects C drive paths for router-owned data and models", () => {
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_DATA_DIR: "C:/RouterData" }),
    /DATA_DIR must be an absolute path on D:/,
  );
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_MCP_HOME: "C:/RouterHome" }),
    /MCP_HOME must be an absolute path on D:/,
  );
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_MODEL_ROOT: "C:/Models" }),
    /MODEL_ROOT must be an absolute path on D:/,
  );
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_CAPACITY_DRIVE: "C:" }),
    /CAPACITY_DRIVE must be D:/,
  );
});

test("parseConfig enforces safe bridge loop and timeout bounds", () => {
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_MAX_MODEL_ROUNDS: "0" }),
    /MAX_MODEL_ROUNDS/,
  );
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_MAX_TOOL_CALLS_PER_ROUND: "21" }),
    /MAX_TOOL_CALLS_PER_ROUND/,
  );
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_MCP_CALL_TIMEOUT_MS: "99" }),
    /MCP_CALL_TIMEOUT_MS/,
  );
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_MIN_FREE_BYTES: "-1" }),
    /MIN_FREE_BYTES/,
  );
});

test("parseConfig keeps a caller supplied model catalog unchanged", () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
    TOOLBOX_ROUTER_UPSTREAM_MODEL: "grok-4.7",
    TOOLBOX_ROUTER_MODELS: JSON.stringify([
      { id: "toolbox-spike", upstreamModel: "grok-4.7" },
    ]),
  });

  assert.deepEqual(config.models, [
    { id: "toolbox-spike", upstreamModel: "grok-4.7", requiredBytes: 0 },
  ]);
});

test("parseConfig points bridge mode at the LAN gateway with a tool capable upstream", () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
  });

  assert.equal(config.upstream.baseUrl, "http://127.0.0.1:7770/v1");
  assert.equal(config.upstream.model, "claude-sonnet-4-6");
  assert.equal(config.upstream.apiKeySource, "environment");
});

test("parseConfig publishes an explicit router owned model catalog in bridge mode", () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
  });

  assert.deepEqual(config.models, [
    { id: "toolbox-spike", upstreamModel: "claude-sonnet-4-6", requiredBytes: 0 },
    { id: "toolbox-spike-fast", upstreamModel: "gpt-oss-120b-medium", requiredBytes: 0 },
  ]);
});

test("parseConfig accepts an explicit space-constrained model catalog", () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_MODELS: JSON.stringify([
      { id: "toolbox-spike", upstreamModel: "grok-4.7" },
      { id: "local-large", upstreamModel: "local-model", requiredBytes: 12_000_000_000 },
    ]),
  });

  assert.deepEqual(config.models, [
    { id: "toolbox-spike", upstreamModel: "grok-4.7", requiredBytes: 0 },
    { id: "local-large", upstreamModel: "local-model", requiredBytes: 12_000_000_000 },
  ]);
});

test("parseConfig rejects malformed duplicate or unsafe model catalog entries", () => {
  const invalidCatalogs = [
    "not-json",
    "{}",
    JSON.stringify([]),
    JSON.stringify([{ id: "toolbox-spike" }]),
    JSON.stringify([{ id: "toolbox-spike", upstreamModel: "model", requiredBytes: -1 }]),
    JSON.stringify([{ id: "toolbox-spike", upstreamModel: "model", requiredBytes: 1.5 }]),
    JSON.stringify([
      { id: "duplicate", upstreamModel: "model-a" },
      { id: "duplicate", upstreamModel: "model-b" },
    ]),
  ];

  for (const catalog of invalidCatalogs) {
    assert.throws(() => parseConfig({ TOOLBOX_ROUTER_MODELS: catalog }), /TOOLBOX_ROUTER_MODELS/);
  }
});

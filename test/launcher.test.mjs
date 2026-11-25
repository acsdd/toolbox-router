import assert from "node:assert/strict";
import { createServer } from "node:net";
import { after, before, test } from "node:test";

import { parseConfig } from "../src/config.mjs";
import { createRouterServer } from "../src/server.mjs";
import {
  assertPortAvailable,
  buildChildEnv,
  findIPv4Address,
  runSmokeChecks,
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
  assert.equal(childEnv.TOOLBOX_ROUTER_LOG_FILE, "logs/test.jsonl");
});

test("runSmokeChecks exercises models text streaming and tool calls", async () => {
  const results = await runSmokeChecks(baseUrl, "launcher-test-key");

  assert.equal(results.models, true);
  assert.equal(results.chat, true);
  assert.equal(results.stream, true);
  assert.equal(results.toolCall, true);
});

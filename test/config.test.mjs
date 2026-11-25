import assert from "node:assert/strict";
import test from "node:test";

import { parseConfig } from "../src/config.mjs";

test("parseConfig defaults to the requested LAN spike address", () => {
  const config = parseConfig({});

  assert.equal(config.host, "192.168.100.66");
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

test("parseConfig rejects an invalid port instead of silently changing it", () => {
  assert.throws(
    () => parseConfig({ TOOLBOX_ROUTER_PORT: "70000" }),
    /port must be an integer between 1 and 65535/,
  );
});

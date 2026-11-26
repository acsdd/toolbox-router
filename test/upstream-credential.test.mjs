import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import { resolveUpstreamCredential } from "../src/upstream-credential.mjs";

test("resolveUpstreamCredential prefers the explicit environment credential", () => {
  const result = resolveUpstreamCredential(
    { TOOLBOX_ROUTER_UPSTREAM_API_KEY: "env-key" },
    {
      readFileSync: () => {
        throw new Error("the environment credential must not read any settings file");
      },
    },
  );

  assert.equal(result.apiKey, "env-key");
  assert.equal(result.source, "environment");
});

test("resolveUpstreamCredential reads the gateway credential from the Qoder provider settings", () => {
  const result = resolveUpstreamCredential(
    {},
    {
      home: "C:/Users/test",
      readFileSync: (path, encoding) => {
        assert.equal(path, join("C:/Users/test", ".qoder", "settings.json"));
        assert.equal(encoding, "utf8");
        return JSON.stringify({ providers: { "local-chat": { apiKey: "settings-key" } } });
      },
    },
  );

  assert.equal(result.apiKey, "settings-key");
  assert.equal(result.source, "qoder-settings");
});

test("resolveUpstreamCredential honours an explicit settings path and provider name", () => {
  const result = resolveUpstreamCredential(
    {
      TOOLBOX_ROUTER_QODER_SETTINGS: "D:/Config/qoder-settings.json",
      TOOLBOX_ROUTER_QODER_PROVIDER: "local-responses",
    },
    {
      readFileSync: (path) => {
        assert.equal(path, "D:/Config/qoder-settings.json");
        return JSON.stringify({ providers: { "local-responses": { apiKey: "responses-key" } } });
      },
    },
  );

  assert.equal(result.apiKey, "responses-key");
  assert.equal(result.source, "qoder-settings");
});

test("resolveUpstreamCredential can be switched off without an environment credential", () => {
  const result = resolveUpstreamCredential(
    { TOOLBOX_ROUTER_QODER_PROVIDER: "none" },
    {
      readFileSync: () => {
        throw new Error("the settings fallback must be disabled");
      },
    },
  );

  assert.equal(result.apiKey, "");
  assert.equal(result.source, "none");
});

test("resolveUpstreamCredential reports no credential when the settings are unusable", () => {
  const failing = resolveUpstreamCredential(
    {},
    {
      readFileSync: () => {
        throw new Error("settings file is missing");
      },
    },
  );
  assert.equal(failing.apiKey, "");
  assert.equal(failing.source, "none");

  const malformed = resolveUpstreamCredential(
    {},
    { readFileSync: () => "not-json" },
  );
  assert.equal(malformed.apiKey, "");
  assert.equal(malformed.source, "none");

  const missingProvider = resolveUpstreamCredential(
    {},
    { readFileSync: () => JSON.stringify({ providers: {} }) },
  );
  assert.equal(missingProvider.apiKey, "");
  assert.equal(missingProvider.source, "none");
});

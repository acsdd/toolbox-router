import assert from "node:assert/strict";
import test from "node:test";

import {
  approvalRequiredResult,
  buildBridgeTools,
  classifyTool,
  mergeTools,
  mcpToolToOpenAI,
  namedToolChoice,
  parseToolArguments,
} from "../src/tool-policy.mjs";

const ALL_STATIC_NAMES = [
  "crypto_status",
  "crypto_refresh",
  "crypto_set_watchlist",
  "crypto_series",
  "gmail_status",
  "gmail_check",
  "gmail_connect",
  "gmail_disconnect",
  "system_stats",
  "system_processes",
  "llamafarm_status",
  "llamafarm_catalog",
  "llamafarm_score",
  "llamafarm_refresh",
  "llamafarm_grade",
  "llamafarm_install",
  "llamafarm_search",
  "llamafarm_quants",
  "llamafarm_remove",
  "llamafarm_cancel",
  "llamafarm_run_now",
  "llamafarm_progress",
  "llamafarm_notes",
  "llamafarm_note",
  "runtimes_detect",
  "runtimes_install",
  "runtimes_use",
  "runtimes_models",
  "runtimes_download",
  "gateway_status",
  "gateway_requests",
  "marketplace_list",
  "marketplace_install",
  "marketplace_uninstall",
  "remote_status",
  "widgets_export",
  "widgets_import",
];

function mcpTool(name, inputSchema = { type: "object", properties: {} }) {
  return { name, description: `${name} description`, inputSchema };
}

function clientTool(name, description = "client description") {
  return {
    type: "function",
    function: { name, description, parameters: { type: "object", properties: {} } },
  };
}

test("bridge discovery exposes all static tools except Gmail credential handling and dynamic remotes", () => {
  const discovered = [
    ...ALL_STATIC_NAMES.map((name) => mcpTool(name)),
    mcpTool("remote_dynamic_shell"),
  ];
  const tools = buildBridgeTools(discovered);
  const names = tools.map((tool) => tool.function.name);

  assert.equal(tools.length, 35);
  assert.equal(names.includes("gmail_connect"), false);
  assert.equal(names.includes("gmail_disconnect"), false);
  assert.equal(names.includes("remote_dynamic_shell"), false);
  assert.equal(names.includes("system_stats"), true);
  assert.equal(names.includes("widgets_import"), true);
});

test("tool policy separates auto reads restricted actions and blocked credential tools", () => {
  assert.equal(classifyTool("system_stats"), "auto");
  assert.equal(classifyTool("crypto_series"), "auto");
  assert.equal(classifyTool("gmail_check"), "restricted");
  assert.equal(classifyTool("gmail_status"), "restricted");
  assert.equal(classifyTool("gateway_requests"), "restricted");
  assert.equal(classifyTool("widgets_export"), "restricted");
  assert.equal(classifyTool("llamafarm_notes"), "restricted");
  assert.equal(classifyTool("llamafarm_install"), "restricted");
  assert.equal(classifyTool("widgets_import"), "restricted");
  assert.equal(classifyTool("gmail_connect"), "blocked");
  assert.equal(classifyTool("gmail_disconnect"), "blocked");
  assert.equal(classifyTool("qoder_native_tool"), "external");
});

test("MCP schemas map to OpenAI function tools without losing JSON Schema", () => {
  const schema = {
    type: "object",
    properties: { days: { type: "number", enum: [30, 90, 180] } },
    required: ["days"],
    additionalProperties: false,
  };

  assert.deepEqual(mcpToolToOpenAI(mcpTool("crypto_series", schema)), {
    type: "function",
    function: {
      name: "crypto_series",
      description: "crypto_series description",
      parameters: schema,
    },
  });
});

test("missing MCP schemas become an empty OpenAI object schema", () => {
  const tool = mcpToolToOpenAI({ name: "system_stats", description: "System stats" });

  assert.deepEqual(tool.function.parameters, { type: "object", properties: {} });
});

test("merged tools preserve native tools replace duplicate definitions and strip credential tools", () => {
  const merged = mergeTools(
    [clientTool("qoder_native_tool"), clientTool("system_stats", "stale client schema"), clientTool("gmail_connect")],
    [mcpToolToOpenAI(mcpTool("system_stats", { type: "object", properties: { refresh: { type: "boolean" } } }))],
  );

  assert.deepEqual(merged.map((tool) => tool.function.name), ["qoder_native_tool", "system_stats"]);
  assert.equal(merged[1].function.description, "system_stats description");
  assert.deepEqual(merged[1].function.parameters.properties, { refresh: { type: "boolean" } });
});

test("tool arguments accept JSON objects and reject malformed or non-object values", () => {
  assert.deepEqual(parseToolArguments('{"days":30}'), { days: 30 });
  assert.deepEqual(parseToolArguments({ days: 90 }), { days: 90 });
  assert.throws(() => parseToolArguments("not-json"), /arguments/);
  assert.throws(() => parseToolArguments("[]"), /arguments/);
  assert.throws(() => parseToolArguments(null), /arguments/);
});

test("router-only restricted calls return a structured approval result without arguments", () => {
  const result = approvalRequiredResult("widgets_export");

  assert.deepEqual(result, {
    approval_required: true,
    tool: "widgets_export",
    message: "This Toolbox tool requires Qoder approval and was not executed by the router.",
  });
});

test("named tool choice reports the pinned function and ignores other steering modes", () => {
  assert.equal(namedToolChoice({ type: "function", function: { name: "crypto_status" } }), "crypto_status");
  assert.equal(namedToolChoice("auto"), "");
  assert.equal(namedToolChoice("required"), "");
  assert.equal(namedToolChoice(undefined), "");
  assert.equal(namedToolChoice(null), "");
  assert.equal(namedToolChoice({ type: "function", function: {} }), "");
  assert.equal(namedToolChoice({ type: "function" }), "");
});

import assert from "node:assert/strict";
import test from "node:test";

import { runChatLoop } from "../src/chat-loop.mjs";
import { parseConfig } from "../src/config.mjs";

const silentLogger = { info() {}, error() {} };

function config(overrides = {}) {
  return parseConfig({
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
    TOOLBOX_ROUTER_UPSTREAM_MODEL: "test-model",
    ...overrides,
  });
}

function openAITool(name) {
  return {
    type: "function",
    function: { name, description: `${name} description`, parameters: { type: "object", properties: {} } },
  };
}

function toolCall(name, args = {}, id = `call_${name}`) {
  return {
    id,
    type: "function",
    function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) },
  };
}

function completion(message, finishReason = message.tool_calls ? "tool_calls" : "stop") {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  };
}

function scriptedUpstream(responses, requests = []) {
  return {
    async complete(payload) {
      requests.push(structuredClone(payload));
      const response = responses.shift();
      if (response instanceof Error) throw response;
      if (!response) throw new Error("Unexpected upstream call");
      return response;
    },
  };
}

function fakeBridge(overrides = {}) {
  return {
    ready: true,
    tools: [openAITool("system_stats"), openAITool("widgets_export")],
    calls: [],
    async callTool(name, args) {
      this.calls.push({ name, args });
      return { isError: false, content: '{"cpu":12}' };
    },
    ...overrides,
  };
}

async function run(payload, upstream, bridge = fakeBridge(), overrides = {}) {
  return runChatLoop({
    payload: { model: "toolbox-spike", messages: [{ role: "user", content: "hello" }], ...payload },
    config: config(overrides),
    upstream,
    bridge,
    logger: silentLogger,
  });
}

test("chat loop returns a plain answer and sends merged tool schemas upstream", async () => {
  const requests = [];
  const upstream = scriptedUpstream(
    [completion({ role: "assistant", content: "final answer" })],
    requests,
  );

  const result = await run(
    {
      tools: [openAITool("qoder_native_tool"), openAITool("system_stats"), openAITool("gmail_connect")],
    },
    upstream,
  );

  assert.equal(result.message.content, "final answer");
  assert.equal(result.finishReason, "stop");
  assert.deepEqual(requests[0].tools.map((tool) => tool.function.name), [
    "qoder_native_tool",
    "system_stats",
    "widgets_export",
  ]);
  assert.equal(requests[0].tools[1].function.description, "system_stats description");
});

test("chat loop relaxes forced tool choice after executing tools so the model can finish", async () => {
  const requests = [];
  const upstream = scriptedUpstream(
    [
      completion({ role: "assistant", content: null, tool_calls: [toolCall("system_stats")] }),
      completion({ role: "assistant", content: "CPU is 12 percent" }),
    ],
    requests,
  );

  const result = await run({ tool_choice: "required" }, upstream);

  assert.equal(result.message.content, "CPU is 12 percent");
  assert.equal(requests[0].tool_choice, "required");
  assert.equal(requests[1].tool_choice, "auto");
});

test("chat loop preserves provider tool-call metadata across a tool round", async () => {
  const requests = [];
  const call = { ...toolCall("system_stats"), extra_content: { google: { thought_signature: "opaque-test-signature" } } };
  const upstream = scriptedUpstream([
    completion({ role: "assistant", content: null, tool_calls: [call] }),
    completion({ role: "assistant", content: "done" }),
  ], requests);
  await run({}, upstream);
  assert.deepEqual(requests[1].messages.at(-2).tool_calls[0].extra_content, call.extra_content);
});

test("chat loop routes a public alias to its explicit upstream model on every round", async () => {
  const requests = [];
  const upstream = {
    async complete(payload, options) {
      requests.push({ payload, options });
      return completion({ role: "assistant", content: "routed answer" });
    },
  };

  const result = await runChatLoop({
    payload: { model: "public-alias", messages: [{ role: "user", content: "hello" }] },
    config: config(),
    upstream,
    upstreamModel: "explicit-upstream-model",
    bridge: fakeBridge(),
    logger: silentLogger,
  });

  assert.equal(result.message.content, "routed answer");
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].options, { model: "explicit-upstream-model" });
});

test("chat loop executes auto-approved MCP tools and feeds results back to the model", async () => {
  const requests = [];
  const bridge = fakeBridge();
  const upstream = scriptedUpstream(
    [
      completion({ role: "assistant", content: null, tool_calls: [toolCall("system_stats")] }),
      completion({ role: "assistant", content: "CPU is 12 percent" }),
    ],
    requests,
  );

  const result = await run({}, upstream, bridge);

  assert.equal(result.message.content, "CPU is 12 percent");
  assert.deepEqual(bridge.calls, [{ name: "system_stats", args: {} }]);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].messages.at(-2).role, "assistant");
  assert.equal(requests[1].messages.at(-1).role, "tool");
  assert.equal(requests[1].messages.at(-1).tool_call_id, "call_system_stats");
  assert.equal(requests[1].messages.at(-1).content, '{"cpu":12}');
});

test("chat loop returns native Qoder tool calls without executing them", async () => {
  const bridge = fakeBridge();
  const message = { role: "assistant", content: null, tool_calls: [toolCall("qoder_native_tool")] };
  const upstream = scriptedUpstream([completion(message)]);

  const result = await run({ tools: [openAITool("qoder_native_tool")] }, upstream, bridge);

  assert.equal(result.finishReason, "tool_calls");
  assert.deepEqual(result.message.tool_calls, message.tool_calls);
  assert.equal(bridge.calls.length, 0);
});

test("chat loop passes restricted tools through when Qoder already advertises them", async () => {
  const bridge = fakeBridge();
  const message = { role: "assistant", content: null, tool_calls: [toolCall("widgets_export")] };
  const upstream = scriptedUpstream([completion(message)]);

  const result = await run({ tools: [openAITool("widgets_export")] }, upstream, bridge);

  assert.equal(result.finishReason, "tool_calls");
  assert.equal(result.message.tool_calls[0].function.name, "widgets_export");
  assert.equal(bridge.calls.length, 0);
});

test("chat loop returns approval_required for router-only restricted calls", async () => {
  const requests = [];
  const bridge = fakeBridge();
  const upstream = scriptedUpstream(
    [
      completion({ role: "assistant", content: null, tool_calls: [toolCall("widgets_export")] }),
      completion({ role: "assistant", content: "Approval is required before export." }),
    ],
    requests,
  );

  const result = await run({}, upstream, bridge);

  assert.equal(result.message.content, "Approval is required before export.");
  assert.equal(bridge.calls.length, 0);
  const toolResult = JSON.parse(requests[1].messages.at(-1).content);
  assert.equal(toolResult.approval_required, true);
  assert.equal(toolResult.tool, "widgets_export");
});

test("chat loop converts MCP failures into tool results instead of losing the conversation", async () => {
  const requests = [];
  const bridge = fakeBridge({
    async callTool() {
      return { isError: true, content: "fake MCP failure" };
    },
  });
  const upstream = scriptedUpstream(
    [
      completion({ role: "assistant", content: null, tool_calls: [toolCall("system_stats")] }),
      completion({ role: "assistant", content: "The stats tool failed." }),
    ],
    requests,
  );

  await run({}, upstream, bridge);

  assert.match(requests[1].messages.at(-1).content, /fake MCP failure/);
});

test("chat loop hides thrown MCP error bodies from model tool results", async () => {
  const requests = [];
  const bridge = fakeBridge({
    async callTool() {
      throw new Error("private-tool-error with secret argument");
    },
  });
  const upstream = scriptedUpstream(
    [
      completion({ role: "assistant", content: null, tool_calls: [toolCall("system_stats", { secret: "private-argument" })] }),
      completion({ role: "assistant", content: "The stats tool failed." }),
    ],
    requests,
  );

  await run({}, upstream, bridge);

  const content = requests[1].messages.at(-1).content;
  assert.match(content, /failed/i);
  assert.doesNotMatch(content, /private-tool-error/);
  assert.doesNotMatch(content, /private-argument/);
});

test("chat loop blocks credential tools even if the model hallucinates a call", async () => {
  const requests = [];
  const bridge = fakeBridge();
  const upstream = scriptedUpstream(
    [
      completion({
        role: "assistant",
        content: null,
        tool_calls: [toolCall("gmail_connect", { password: "never-send-this" })],
      }),
      completion({ role: "assistant", content: "Credential tools are unavailable." }),
    ],
    requests,
  );

  await run({}, upstream, bridge);

  assert.equal(bridge.calls.length, 0);
  assert.match(requests[1].messages.at(-1).content, /blocked/i);
  assert.doesNotMatch(requests[1].messages.at(-1).content, /never-send-this/);
});

test("chat loop rejects a round with more than the configured tool-call limit", async () => {
  const bridge = fakeBridge();
  const calls = Array.from({ length: 5 }, (_, index) => toolCall("system_stats", {}, `call_${index}`));
  const upstream = scriptedUpstream([
    completion({ role: "assistant", content: null, tool_calls: calls }),
  ]);

  await assert.rejects(() => run({}, upstream, bridge), /tool call limit/i);
  assert.equal(bridge.calls.length, 0);
});

test("chat loop rejects an already cancelled request before calling upstream", async () => {
  const controller = new AbortController();
  controller.abort();
  const requests = [];
  const upstream = scriptedUpstream([completion({ role: "assistant", content: "unused" })], requests);

  await assert.rejects(
    () =>
      runChatLoop({
        payload: { messages: [{ role: "user", content: "hello" }] },
        config: config(),
        upstream,
        bridge: fakeBridge(),
        signal: controller.signal,
        logger: silentLogger,
      }),
    (error) => error.code === "request_cancelled" && error.status === 499,
  );
  assert.equal(requests.length, 0);
});

test("chat loop does not start another model round after cancellation during a tool call", async () => {
  const controller = new AbortController();
  const requests = [];
  const bridge = fakeBridge();
  const callTool = bridge.callTool.bind(bridge);
  bridge.callTool = async (...args) => {
    const result = await callTool(...args);
    controller.abort();
    return result;
  };
  const upstream = scriptedUpstream(
    [
      completion({ role: "assistant", content: null, tool_calls: [toolCall("system_stats")] }),
      completion({ role: "assistant", content: "must not be requested" }),
    ],
    requests,
  );

  await assert.rejects(
    () =>
      runChatLoop({
        payload: { messages: [{ role: "user", content: "hello" }] },
        config: config(),
        upstream,
        bridge,
        signal: controller.signal,
        logger: silentLogger,
      }),
    (error) => error.code === "request_cancelled" && error.status === 499,
  );
  assert.equal(bridge.calls.length, 1);
  assert.equal(requests.length, 1);
});

test("chat loop stops at the configured model-round bound", async () => {
  const bridge = fakeBridge();
  const upstream = scriptedUpstream([
    completion({ role: "assistant", content: null, tool_calls: [toolCall("system_stats")] }),
    completion({ role: "assistant", content: null, tool_calls: [toolCall("system_stats")] }),
  ]);

  await assert.rejects(
    () => run({}, upstream, bridge, { TOOLBOX_ROUTER_MAX_MODEL_ROUNDS: "2" }),
    /round limit/i,
  );
  assert.equal(bridge.calls.length, 1);
});

test("chat loop logs real duration and request id, and ignores invalid usage", async () => {
  const logs = [];
  const logger = { info: (line) => logs.push(JSON.parse(line)), error() {} };
  const upstream = {
    complete: async () => ({
      choices: [{ index: 0, message: { role: "assistant", content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: -5, completion_tokens: "x", total_tokens: 11 },
    }),
  };
  const result = await runChatLoop({
    payload: { model: "toolbox-spike", messages: [{ role: "user", content: "hi" }] },
    config: config(),
    upstream,
    bridge: fakeBridge(),
    logger,
    requestId: "req-test-123",
  });
  assert.equal(result.usage.prompt_tokens, 0);
  assert.equal(result.usage.completion_tokens, 0);
  assert.equal(result.usage.total_tokens, 11);
  const complete = logs.find((entry) => entry.event === "chat_loop_complete");
  assert.equal(complete.request_id, "req-test-123");
  assert.equal(typeof complete.duration_ms, "number");
  assert.equal(complete.duration_ms >= 0, true);
});

test("tool execution failure exposes only safe error type/code", async () => {
  const requests = [];
  const upstream = scriptedUpstream([
    completion({ role: "assistant", content: null, tool_calls: [toolCall("system_stats")] }),
    completion({ role: "assistant", content: "recovered" }),
  ], requests);
  const bridge = fakeBridge({
    async callTool() {
      const err = new Error("secret D:/private/path");
      err.name = "TimeoutError";
      err.code = "eternal_timeout";
      throw err;
    },
  });
  const result = await run({}, upstream, bridge);
  assert.equal(result.message.content, "recovered");
  const toolMessage = requests[1].messages.find((message) => message.role === "tool");
  assert.equal(toolMessage.content, "Toolbox tool system_stats failed: TimeoutError (eternal_timeout)");
  assert.equal(toolMessage.content.includes("secret"), false);
  assert.equal(toolMessage.content.includes("D:/"), false);
});

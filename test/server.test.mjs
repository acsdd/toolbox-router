import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { parseConfig } from "../src/config.mjs";
import { boundedModelId, toolChoiceLabel, validateChatPayload } from "../src/request-validation.mjs";
import { createRouterServer } from "../src/server.mjs";

const silentLogger = {
  info() {},
  error() {},
};

let server;
let baseUrl;

before(async () => {
  const config = parseConfig({
    TOOLBOX_ROUTER_HOST: "127.0.0.1",
    TOOLBOX_ROUTER_PORT: "8787",
    TOOLBOX_ROUTER_API_KEY: "test-key-123",
    TOOLBOX_ROUTER_MODE: "mock",
  });

  server = createRouterServer({ config, logger: silentLogger });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
});

test("health reports the mock spike without authentication", async () => {
  const response = await fetch(`${baseUrl}/health`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.service, "toolbox-router");
  assert.equal(body.mode, "mock");
});

test("model listing rejects a missing bearer key", async () => {
  const response = await fetch(`${baseUrl}/v1/models`);

  assert.equal(response.status, 401);
});

test("model listing exposes the Qoder-selectable spike model", async () => {
  const response = await fetch(`${baseUrl}/v1/models`, {
    headers: { authorization: "Bearer test-key-123" },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.object, "list");
  assert.equal(body.data[0].id, "toolbox-spike");
  assert.equal(body.data[0].object, "model");
});

test("non-streaming chat returns an OpenAI-compatible completion", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key-123",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "toolbox-spike",
      messages: [{ role: "user", content: "hello" }],
      stream: false,
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.object, "chat.completion");
  assert.equal(body.model, "toolbox-spike");
  assert.equal(body.choices[0].message.role, "assistant");
  assert.match(body.choices[0].message.content, /reachable/);
  assert.equal(body.choices[0].finish_reason, "stop");
  assert.ok(body.usage.total_tokens > 0);
});

test("streaming chat emits role content finish and done events", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key-123",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "toolbox-spike",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/event-stream/);
  assert.match(text, /"role":"assistant"/);
  assert.match(text, /"content":"Toolbox/);
  assert.match(text, /"finish_reason":"stop"/);
  assert.match(text, /data: \[DONE\]/);
});

test("required tool choice returns a real tool call", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key-123",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "toolbox-spike",
      messages: [{ role: "user", content: "probe the tool" }],
      tools: [
        {
          type: "function",
          function: {
            name: "probe_tool",
            description: "Test tool",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "required",
      stream: false,
    }),
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.choices[0].finish_reason, "tool_calls");
  assert.equal(body.choices[0].message.content, null);
  assert.equal(body.choices[0].message.tool_calls[0].type, "function");
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "probe_tool");
  assert.deepEqual(JSON.parse(body.choices[0].message.tool_calls[0].function.arguments), {
    probe: "qoder",
  });
});

test("streaming tool calls preserve the function name and arguments", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key-123",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "toolbox-spike",
      messages: [{ role: "user", content: "probe the tool" }],
      tools: [
        {
          type: "function",
          function: {
            name: "probe_tool",
            description: "Test tool",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "required",
      stream: true,
    }),
  });
  const text = await response.text();

  assert.equal(response.status, 200);
  assert.match(text, /"tool_calls":\[\{"index":0/);
  assert.match(text, /"name":"probe_tool"/);
  assert.match(text, /"arguments":"\{\\"probe\\":\\"qoder\\"\}"/);
  assert.match(text, /"finish_reason":"tool_calls"/);
  assert.match(text, /data: \[DONE\]/);
});

test("an unknown model returns a client error instead of a fake success", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key-123",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "missing-model",
      messages: [{ role: "user", content: "hello" }],
    }),
  });

  assert.equal(response.status, 404);
});

test("malformed JSON returns a client error", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: {
      authorization: "Bearer test-key-123",
      "content-type": "application/json",
    },
    body: "{not-json",
  });

  assert.equal(response.status, 400);
});


test("public health does not expose local filesystem paths or process IDs", async () => {
  const config = { ...parseConfig({TOOLBOX_ROUTER_MODE:'mock'}), mode:'bridge' };
  const bridge = { ready:true, status:()=>({ready:true,toolCount:7,pid:1234,home:'C:/private/home',runtime:'source'}) };
  const probe = createRouterServer({config, logger:silentLogger, bridge, getCapacity:async()=>({ok:true,modelRoot:'D:/private/models',freeBytes:42})});
  await new Promise(resolve=>probe.listen(0,'127.0.0.1',resolve));
  try {
    const response=await fetch(`http://127.0.0.1:${probe.address().port}/health`);
    const text=await response.text();const body=JSON.parse(text);
    assert.equal(body.mcp.ready,true);assert.equal(body.mcp.toolCount,7);assert.equal(body.capacity.ok,true);
    assert.doesNotMatch(text,/private|1234|modelRoot|pid/);
  } finally {probe.closeAllConnections();await new Promise(resolve=>probe.close(resolve));}
});

test("validateChatPayload rejects malformed messages, tools, tool_choice, stream", () => {
  const base = { model: "toolbox-spike", messages: [{ role: "user", content: "hi" }] };
  assert.throws(() => validateChatPayload({ ...base, messages: [] }), (e) => e.code === "invalid_messages");
  assert.throws(() => validateChatPayload({ ...base, messages: [{ role: "boss", content: "hi" }] }), (e) => e.code === "invalid_messages");
  assert.throws(() => validateChatPayload({ ...base, messages: [{ role: "tool", content: "x" }] }), (e) => e.code === "invalid_messages");
  assert.throws(() => validateChatPayload({ ...base, messages: [{ role: "user", content: 42 }] }), (e) => e.code === "invalid_messages");
  assert.throws(() => validateChatPayload({ ...base, tools: [{ type: "function", function: { name: "" } }] }), (e) => e.code === "invalid_tools");
  assert.throws(() => validateChatPayload({ ...base, tool_choice: { type: "function", function: {} } }), (e) => e.code === "invalid_tool_choice");
  assert.throws(() => validateChatPayload({ ...base, stream: "yes" }), (e) => e.code === "invalid_stream");
  assert.throws(() => validateChatPayload({ ...base, model: "" }), (e) => e.code === "invalid_model");
  assert.doesNotThrow(() => validateChatPayload(base));
  assert.doesNotThrow(() => validateChatPayload({ ...base, tool_choice: "required", stream: true }));
});

test("toolChoiceLabel names the steering mode without echoing caller contents", () => {
  assert.equal(toolChoiceLabel("auto"), "auto");
  assert.equal(toolChoiceLabel("none"), "none");
  assert.equal(toolChoiceLabel("required"), "required");
  assert.equal(toolChoiceLabel({ type: "function", function: { name: "system_stats" } }), "specific");
  assert.equal(toolChoiceLabel(undefined), "unspecified");
  assert.equal(toolChoiceLabel(null), "unspecified");
  assert.equal(toolChoiceLabel("bogus"), "unspecified");
});

test("boundedModelId strips control characters and caps length", () => {
  const bounded = boundedModelId("a\u0000b".repeat(200));
  assert.equal(bounded.length <= 128, true);
  assert.equal(/[\u0000-\u001f\u007f]/.test(boundedModelId("a\u0000b")), false);
});

test("chat rejects non-JSON content type with 415", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key-123", "content-type": "text/plain" },
    body: "model=toolbox-spike",
  });
  const body = await response.json();
  assert.equal(response.status, 415);
  assert.equal(body.error.code, "unsupported_media_type");
});

test("chat rejects an oversized body with a delivered 413", async () => {
  const response = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key-123", "content-type": "application/json" },
    body: JSON.stringify({
      model: "toolbox-spike",
      messages: [{ role: "user", content: "x".repeat(3 * 1024 * 1024) }],
    }),
  });
  const body = await response.json();
  assert.equal(response.status, 413);
  assert.equal(body.error.code, "request_too_large");
});

test("chat validates payload shape and returns a request id header", async () => {
  const bad = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key-123", "content-type": "application/json" },
    body: JSON.stringify({ model: "toolbox-spike", messages: [{ role: "user", content: 42 }] }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, "invalid_messages");
  assert.match(bad.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);

  const good = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { authorization: "Bearer test-key-123", "content-type": "application/json" },
    body: JSON.stringify({ model: "toolbox-spike", messages: [{ role: "user", content: "hello" }] }),
  });
  assert.equal(good.status, 200);
  assert.match(good.headers.get("x-request-id"), /^[0-9a-f-]{36}$/);
});

import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { parseConfig } from "../src/config.mjs";
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

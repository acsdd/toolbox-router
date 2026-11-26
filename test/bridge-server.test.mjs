import assert from "node:assert/strict";
import { test } from "node:test";

import { parseConfig } from "../src/config.mjs";
import { UpstreamError } from "../src/upstream.mjs";
import { createRouterServer } from "../src/server.mjs";

const API_KEY = "bridge-server-test-key";
const silentLogger = { info() {}, error() {} };

function bridgeConfig(overrides = {}) {
  return parseConfig({
    TOOLBOX_ROUTER_HOST: "127.0.0.1",
    TOOLBOX_ROUTER_PORT: "8787",
    TOOLBOX_ROUTER_API_KEY: API_KEY,
    TOOLBOX_ROUTER_MODE: "bridge",
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
    TOOLBOX_ROUTER_UPSTREAM_MODEL: "test-model",
    ...overrides,
  });
}

function testCapacity(overrides = {}) {
  return {
    ok: true,
    drive: "D:",
    modelRoot: "D:/LMStudio_Downloads",
    freeBytes: 1_000,
    reserveBytes: 300,
    availableBytes: 700,
    ...overrides,
  };
}

function completion(message, finishReason = "stop") {
  return {
    choices: [{ index: 0, message, finish_reason: finishReason, logprobs: null }],
    usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
  };
}

async function withRouter(
  { bridge, upstream, config = bridgeConfig(), getCapacity = async () => testCapacity(), logger = silentLogger },
  run,
) {
  const server = createRouterServer({
    config,
    bridge,
    upstream,
    getCapacity,
    logger,
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    await run(baseUrl);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function readyBridge() {
  return {
    ready: true,
    tools: [
      {
        type: "function",
        function: { name: "system_stats", description: "System stats", parameters: { type: "object", properties: {} } },
      },
    ],
    status: () => ({ ready: true, toolCount: 1, runtime: "source", pid: 123, home: "D:/Projects/toolbox/toolbox-router/mcp-home" }),
    async callTool() {
      return { isError: false, content: '{"cpu":12}' };
    },
  };
}

function headers() {
  return { authorization: `Bearer ${API_KEY}`, "content-type": "application/json" };
}

test("bridge health reports readiness and MCP status", async () => {
  await withRouter(
    {
      bridge: readyBridge(),
      upstream: { complete: async () => completion({ role: "assistant", content: "ok" }) },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.ok, true);
      assert.equal(body.mode, "bridge");
      assert.equal(body.mcp.toolCount, 1);
      assert.equal(body.capacity.drive, "D:");
      assert.equal(body.capacity.availableBytes, 700);
    },
  );
});

test("bridge chat fails clearly while the MCP child is unavailable", async () => {
  const bridge = { ...readyBridge(), ready: false };
  await withRouter(
    { bridge, upstream: { complete: async () => completion({ role: "assistant", content: "unused" }) } },
    async (baseUrl) => {
      const health = await fetch(`${baseUrl}/health`);
      assert.equal((await health.json()).ok, false);

      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: "toolbox-spike", messages: [{ role: "user", content: "hello" }] }),
      });
      const body = await response.json();
      assert.equal(response.status, 503);
      assert.equal(body.error.code, "mcp_not_ready");
    },
  );
});

test("bridge non-streaming chat returns the real upstream answer as toolbox-spike", async () => {
  await withRouter(
    {
      bridge: readyBridge(),
      upstream: { complete: async () => completion({ role: "assistant", content: "real bridge answer" }) },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
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
      assert.equal(body.choices[0].message.content, "real bridge answer");
      assert.equal(body.choices[0].finish_reason, "stop");
      assert.equal(body.usage.total_tokens, 11);
    },
  );
});

test("bridge streaming chat emits a complete OpenAI event stream", async () => {
  await withRouter(
    {
      bridge: readyBridge(),
      upstream: { complete: async () => completion({ role: "assistant", content: "streamed bridge answer" }) },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          model: "toolbox-spike",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.match(response.headers.get("content-type"), /text\/event-stream/);
      assert.match(text, /"content":"streamed bridge answer"/);
      assert.match(text, /"finish_reason":"stop"/);
      assert.match(text, /data: \[DONE\]/);
    },
  );
});

test("bridge streaming preserves the requested public model alias in every chunk", async () => {
  const config = bridgeConfig({
    TOOLBOX_ROUTER_MODELS: JSON.stringify([
      { id: "toolbox-spike", upstreamModel: "test-model" },
      { id: "local-alias", upstreamModel: "explicit-local-model", requiredBytes: 0 },
    ]),
  });

  await withRouter(
    {
      config,
      bridge: readyBridge(),
      upstream: { complete: async () => completion({ role: "assistant", content: "aliased stream answer" }) },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          model: "local-alias",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });
      const text = await response.text();
      const chunks = text
        .split("\n")
        .filter((line) => line.startsWith("data: ") && line !== "data: [DONE]")
        .map((line) => JSON.parse(line.slice(6)));

      assert.equal(response.status, 200);
      assert.ok(chunks.length > 0);
      assert.ok(chunks.every((chunk) => chunk.model === "local-alias"));
      assert.doesNotMatch(text, /"model":"toolbox-spike"/);
    },
  );
});

test("bridge streaming defensively completes when an injected upstream returns malformed tool_calls", async () => {
  await withRouter(
    {
      bridge: readyBridge(),
      upstream: {
        complete: async () =>
          completion({ role: "assistant", content: "safe answer", tool_calls: { malformed: true } }),
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          model: "toolbox-spike",
          messages: [{ role: "user", content: "hello" }],
          stream: true,
        }),
      });
      const text = await response.text();

      assert.equal(response.status, 200);
      assert.match(text, /safe answer/);
      assert.match(text, /"finish_reason":"stop"/);
      assert.match(text, /data: \[DONE\]/);
    },
  );
});

test("bridge tool pass-through preserves standard tool_calls", async () => {
  const message = {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: "call_native",
        type: "function",
        function: { name: "qoder_native_tool", arguments: "{}" },
      },
    ],
  };
  await withRouter(
    {
      bridge: readyBridge(),
      upstream: { complete: async () => completion(message, "tool_calls") },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          model: "toolbox-spike",
          messages: [{ role: "user", content: "use the native tool" }],
          tools: [
            {
              type: "function",
              function: { name: "qoder_native_tool", parameters: { type: "object", properties: {} } },
            },
          ],
        }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.choices[0].finish_reason, "tool_calls");
      assert.equal(body.choices[0].message.tool_calls[0].function.name, "qoder_native_tool");
    },
  );
});

test("model listing filters explicit additions by D-drive headroom", async () => {
  const config = bridgeConfig({
    TOOLBOX_ROUTER_MODELS: JSON.stringify([
      { id: "toolbox-spike", upstreamModel: "test-model" },
      { id: "exact-fit", upstreamModel: "local-a", requiredBytes: 700 },
      { id: "too-large", upstreamModel: "local-b", requiredBytes: 701 },
    ]),
  });

  await withRouter(
    {
      config,
      bridge: readyBridge(),
      upstream: { complete: async () => completion({ role: "assistant", content: "unused" }) },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/models`, { headers: headers() });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.deepEqual(body.data.map((model) => model.id), ["toolbox-spike", "exact-fit"]);
      assert.equal(body.capacity.availableBytes, 700);
    },
  );
});

test("direct requests reject space-constrained models before calling upstream", async () => {
  const config = bridgeConfig({
    TOOLBOX_ROUTER_MODELS: JSON.stringify([
      { id: "toolbox-spike", upstreamModel: "test-model" },
      { id: "too-large", upstreamModel: "local-b", requiredBytes: 701 },
    ]),
  });
  let called = false;

  await withRouter(
    {
      config,
      bridge: readyBridge(),
      upstream: {
        async complete() {
          called = true;
          return completion({ role: "assistant", content: "unused" });
        },
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: "too-large", messages: [{ role: "user", content: "hello" }] }),
      });
      const body = await response.json();

      assert.equal(response.status, 409);
      assert.equal(body.error.code, "insufficient_capacity");
      assert.equal(body.error.details.requiredBytes, 701);
      assert.equal(called, false);
    },
  );
});

test("an available alias routes to its explicit upstream model and keeps the public response id", async () => {
  const config = bridgeConfig({
    TOOLBOX_ROUTER_MODELS: JSON.stringify([
      { id: "toolbox-spike", upstreamModel: "test-model" },
      { id: "local-alias", upstreamModel: "explicit-local-model", requiredBytes: 700 },
    ]),
  });
  const requests = [];

  await withRouter(
    {
      config,
      bridge: readyBridge(),
      upstream: {
        async complete(payload, options) {
          requests.push({ payload, options });
          return completion({ role: "assistant", content: "local answer" });
        },
      },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: "local-alias", messages: [{ role: "user", content: "hello" }] }),
      });
      const body = await response.json();

      assert.equal(response.status, 200);
      assert.equal(body.model, "local-alias");
      assert.equal(requests[0].options.model, "explicit-local-model");
      assert.equal(requests[0].options.signal.aborted, false);
    },
  );
});

test("bridge maps upstream failures to safe OpenAI errors and logs", async () => {
  const entries = [];
  await withRouter(
    {
      bridge: readyBridge(),
      upstream: {
        async complete() {
          throw new UpstreamError(
            "Upstream rate limited for upstream-test-key after private-user-prompt",
            429,
            "upstream_http_error",
          );
        },
      },
      logger: { info: (line) => entries.push(line), error: (line) => entries.push(line) },
    },
    async (baseUrl) => {
      const response = await fetch(`${baseUrl}/v1/chat/completions`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ model: "toolbox-spike", messages: [{ role: "user", content: "private-user-prompt" }] }),
      });
      const body = await response.json();

      assert.equal(response.status, 429);
      assert.equal(body.error.code, "upstream_http_error");
      assert.doesNotMatch(body.error.message, /upstream-test-key/);
      assert.doesNotMatch(body.error.message, /private-user-prompt/);
      assert.doesNotMatch(body.error.message, /rate limited/);
    },
  );

  const logs = entries.join("\n");
  assert.doesNotMatch(logs, /upstream-test-key/);
  assert.doesNotMatch(logs, /private-user-prompt/);
  assert.doesNotMatch(logs, /rate limited/);
});

test("provider payment errors offer safe recovery guidance", async () => {
  await withRouter({ bridge: readyBridge(), upstream: {
    async complete() { throw new UpstreamError("private upstream body", 402, "upstream_http_error"); },
  } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({ model: "toolbox-spike", messages: [{ role: "user", content: "test" }] }),
    });
    const body = await response.json();
    assert.equal(response.status, 402);
    assert.match(body.error.message, /provider account or select another available model/i);
    assert.doesNotMatch(body.error.message, /private upstream body/);
  });
});

test("disconnecting the client cancels an in-flight upstream request", async () => {
  let started;
  const upstreamStarted = new Promise((resolve) => { started = resolve; });
  let cancelled;
  const upstreamCancelled = new Promise((resolve) => { cancelled = resolve; });
  await withRouter({ bridge: readyBridge(), upstream: {
    async complete(_payload, { signal }) {
      started();
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      cancelled();
      throw new Error("cancelled");
    },
  } }, async (baseUrl) => {
    const controller = new AbortController();
    const pending = fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: headers(), signal: controller.signal,
      body: JSON.stringify({ model: "toolbox-spike", messages: [{ role: "user", content: "hello" }] }),
    }).catch(() => undefined);
    await upstreamStarted;
    controller.abort();
    await Promise.race([upstreamCancelled, new Promise((_, reject) => setTimeout(() => reject(new Error("upstream cancellation timed out")), 3000))]);
    await pending;
  });
});

test("request logs never include caller-supplied tool-choice contents", async () => {
  const entries = [];
  await withRouter({ bridge: readyBridge(), upstream: { async complete() { return completion({ role: "assistant", content: "ok" }); } }, logger: { info: line => entries.push(line), error: line => entries.push(line) } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST", headers: headers(),
      body: JSON.stringify({ model: "toolbox-spike", messages: [{ role: "user", content: "hello" }], tool_choice: { type: "function", private: "SYNTHETIC-PRIVATE-DATA" } }),
    });
    assert.equal(response.status, 200);
  });
  assert.doesNotMatch(entries.join("\n"), /SYNTHETIC-PRIVATE-DATA/);
});
test("unreachable upstream returns a gateway error", async () => {
  await withRouter({ bridge: readyBridge(), upstream: { async complete() { throw new UpstreamError("connection failed", 0, "upstream_network_error"); } }, logger: { info() {}, error() {} } }, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, { method: "POST", headers: headers(), body: JSON.stringify({ model: "toolbox-spike", messages: [{ role: "user", content: "hello" }] }) });
    assert.equal(response.status, 502);
    assert.equal((await response.json()).error.code, "upstream_network_error");
  });
});

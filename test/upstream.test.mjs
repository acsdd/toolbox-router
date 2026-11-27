import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";

import { createUpstreamClient, UpstreamError } from "../src/upstream.mjs";

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    return await run(`http://127.0.0.1:${server.address().port}/v1`);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function completion(message = { role: "assistant", content: "upstream answer" }) {
  return {
    id: "chatcmpl-upstream",
    object: "chat.completion",
    created: 1,
    model: "configured-upstream-model",
    choices: [{ index: 0, message, finish_reason: "stop", logprobs: null }],
    usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
  };
}

function clientOptions(baseUrl, overrides = {}) {
  return {
    baseUrl,
    apiKey: "upstream-secret-key",
    model: "configured-upstream-model",
    timeoutMs: 1000,
    logger: { info() {}, error() {} },
    ...overrides,
  };
}

test("upstream client sends explicit credentials model messages and tools without streaming", async () => {
  await withServer(
    async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(request.url, "/v1/chat/completions");
      assert.equal(request.headers.authorization, "Bearer upstream-secret-key");
      assert.equal(body.model, "configured-upstream-model");
      assert.equal(body.stream, false);
      assert.deepEqual(body.messages, [{ role: "user", content: "hello" }]);
      assert.equal(body.tools[0].function.name, "system_stats");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completion()));
    },
    async (baseUrl) => {
      const client = createUpstreamClient(clientOptions(baseUrl));
      const result = await client.complete({
        model: "caller-model-must-not-win",
        messages: [{ role: "user", content: "hello" }],
        tools: [
          {
            type: "function",
            function: { name: "system_stats", parameters: { type: "object", properties: {} } },
          },
        ],
        stream: true,
      });

      assert.equal(result.choices[0].message.content, "upstream answer");
      assert.equal(result.usage.total_tokens, 7);
    },
  );
});

test("upstream client forwards supported generation settings and tool choice", async () => {
  await withServer(
    async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.temperature, 0.2);
      assert.equal(body.top_p, 0.8);
      assert.equal(body.max_tokens, 300);
      assert.equal(body.parallel_tool_calls, false);
      assert.equal(body.tool_choice, "required");
      assert.equal(body.seed, 7);
      assert.equal(body.response_format.type, "json_object");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completion()));
    },
    async (baseUrl) => {
      const client = createUpstreamClient(clientOptions(baseUrl));
      await client.complete({
        messages: [{ role: "user", content: "hello" }],
        temperature: 0.2,
        top_p: 0.8,
        max_tokens: 300,
        parallel_tool_calls: false,
        tool_choice: "required",
        seed: 7,
        response_format: { type: "json_object" },
      });
    },
  );
});

for (const scenario of [
  {
    name: "missing thought signature",
    status: 400,
    text: "A thought signature is required for this function call.",
    expectedCode: "upstream_provider_state",
  },
  {
    name: "expired conversation context",
    status: 409,
    text: "The conversation context has expired.",
    expectedCode: "upstream_provider_state",
  },
  {
    name: "invalid function call context",
    status: 422,
    text: "Function call context is invalid.",
    expectedCode: "upstream_provider_state",
  },
  {
    name: "rate limit mentioning thought signature",
    status: 429,
    text: "Rate limited: thought signature is required.",
    expectedCode: "upstream_http_error",
  },
  {
    name: "present thought signature without missing state",
    status: 400,
    text: "The thought signature was processed successfully.",
    expectedCode: "upstream_http_error",
  },
  {
    name: "unrelated bad request",
    status: 400,
    text: "messages must be an array",
    expectedCode: "upstream_http_error",
  },
]) {
  test(`upstream client safely classifies ${scenario.name}`, async () => {
    const entries = [];
    await withServer(
      (_request, response) => {
        response.writeHead(scenario.status, { "content-type": "application/json" });
        response.end(JSON.stringify({
          error: { message: `${scenario.text} upstream-secret-key private-user-prompt` },
        }));
      },
      async (baseUrl) => {
        const client = createUpstreamClient(
          clientOptions(baseUrl, {
            logger: { info: (line) => entries.push(line), error: (line) => entries.push(line) },
          }),
        );
        await assert.rejects(
          () => client.complete({ messages: [{ role: "user", content: "private-user-prompt" }] }),
          (error) => {
            assert.ok(error instanceof UpstreamError);
            assert.equal(error.status, scenario.status);
            assert.equal(error.code, scenario.expectedCode);
            assert.doesNotMatch(error.message, /thought signature|conversation context|upstream-secret-key|private-user-prompt/i);
            return true;
          },
        );
      },
    );

    const logs = entries.join("\n");
    assert.doesNotMatch(logs, /thought signature|conversation context|upstream-secret-key|private-user-prompt/i);
  });
}

test("upstream client rejects provider errors without exposing keys prompts or provider text", async () => {
  const entries = [];
  await withServer(
    (_request, response) => {
      response.writeHead(429, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          error: {
            message: "rate limited for upstream-secret-key after private-user-prompt",
            type: "rate_limit_error",
          },
        }),
      );
    },
    async (baseUrl) => {
      const client = createUpstreamClient(
        clientOptions(baseUrl, {
          logger: { info: (line) => entries.push(line), error: (line) => entries.push(line) },
        }),
      );
      await assert.rejects(
        () => client.complete({ messages: [{ role: "user", content: "private-user-prompt" }] }),
        (error) => {
          assert.ok(error instanceof UpstreamError);
          assert.equal(error.status, 429);
          assert.match(error.message, /HTTP 429/);
          assert.doesNotMatch(error.message, /upstream-secret-key/);
          assert.doesNotMatch(error.message, /private-user-prompt/);
          assert.doesNotMatch(error.message, /rate limited/);
          return true;
        },
      );
    },
  );

  const logs = entries.join("\n");
  assert.doesNotMatch(logs, /upstream-secret-key/);
  assert.doesNotMatch(logs, /private-user-prompt/);
  assert.doesNotMatch(logs, /rate limited/);
});

for (const scenario of [
  { name: "chunked", contentLength: undefined },
  { name: "underdeclared", contentLength: "1" },
]) {
  test(`upstream client stops reading a ${scenario.name} oversized response at the limit`, async () => {
    let pulls = 0;
    let cancelled = false;
    const body = new ReadableStream({
      pull(controller) {
        pulls += 1;
        if (pulls <= 8) {
          controller.enqueue(new Uint8Array(1024 * 1024));
        } else {
          controller.close();
        }
      },
      cancel() {
        cancelled = true;
      },
    });
    const headers = scenario.contentLength ? { "content-length": scenario.contentLength } : undefined;
    const client = createUpstreamClient(
      clientOptions("http://upstream.test/v1", {
        fetchImpl: async () => new Response(body, { status: 200, headers }),
      }),
    );

    await assert.rejects(
      () => client.complete({ messages: [{ role: "user", content: "hello" }] }),
      /response was too large/i,
    );
    assert.equal(cancelled, true);
    assert.ok(pulls <= 6, `Expected cancellation within one prefetched chunk of the limit, read ${pulls}`);
  });
}

test("upstream client rejects malformed success payloads", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [] }));
    },
    async (baseUrl) => {
      const client = createUpstreamClient(clientOptions(baseUrl));
      await assert.rejects(
        () => client.complete({ messages: [{ role: "user", content: "hello" }] }),
        /invalid Chat Completions response/i,
      );
    },
  );
});

test("upstream client rejects a non-array tool_calls payload", async () => {
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify(
          completion({ role: "assistant", content: "answer", tool_calls: { malformed: true } }),
        ),
      );
    },
    async (baseUrl) => {
      const client = createUpstreamClient(clientOptions(baseUrl));
      await assert.rejects(
        () => client.complete({ messages: [{ role: "user", content: "hello" }] }),
        /tool_calls must be an array/i,
      );
    },
  );
});

test("upstream client times out a stalled provider", async () => {
  await withServer(
    async (_request, response) => {
      await delay(250);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completion()));
    },
    async (baseUrl) => {
      const client = createUpstreamClient(clientOptions(baseUrl, { timeoutMs: 50 }));
      await assert.rejects(
        () => client.complete({ messages: [{ role: "user", content: "hello" }] }),
        /timed out/i,
      );
    },
  );
});

test("upstream client cancels an in-flight request when its caller signal aborts", async () => {
  let notifyRequest;
  const requestReceived = new Promise((resolve) => {
    notifyRequest = resolve;
  });
  const controller = new AbortController();

  await withServer(
    async (request, response) => {
      request.resume();
      notifyRequest();
      // Keep the provider response open until the client cancels it.
    },
    async (baseUrl) => {
      const client = createUpstreamClient(clientOptions(baseUrl, { timeoutMs: 5_000 }));
      const pending = client.complete(
        { messages: [{ role: "user", content: "hello" }] },
        { signal: controller.signal },
      );
      await Promise.race([
        requestReceived,
        delay(2_000).then(() => {
          throw new Error("Upstream did not receive the request");
        }),
      ]);
      controller.abort();

      await assert.rejects(
        () => pending,
        (error) => {
          assert.ok(error instanceof UpstreamError);
          assert.equal(error.code, "upstream_cancelled");
          assert.equal(error.status, 499);
          return true;
        },
      );
    },
  );
});

test("upstream client accepts an explicit per-request model route without trusting the public alias", async () => {
  await withServer(
    async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(body.model, "explicit-alternate-upstream-model");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completion()));
    },
    async (baseUrl) => {
      const client = createUpstreamClient(clientOptions(baseUrl));
      await client.complete(
        { model: "public-alias-must-not-win", messages: [{ role: "user", content: "hello" }] },
        { model: "explicit-alternate-upstream-model" },
      );
    },
  );
});

test("upstream client logs metadata without prompts responses or credentials", async () => {
  const entries = [];
  await withServer(
    (_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(completion({ role: "assistant", content: "private-provider-answer" })));
    },
    async (baseUrl) => {
      const client = createUpstreamClient(
        clientOptions(baseUrl, {
          logger: { info: (line) => entries.push(line), error: (line) => entries.push(line) },
        }),
      );
      await client.complete({ messages: [{ role: "user", content: "private-user-prompt" }] });
    },
  );

  const logs = entries.join("\n");
  assert.match(logs, /upstream_request/);
  assert.doesNotMatch(logs, /private-user-prompt/);
  assert.doesNotMatch(logs, /private-provider-answer/);
  assert.doesNotMatch(logs, /upstream-secret-key/);
});

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}
const okCompletion = { choices: [{ index: 0, message: { role: "assistant", content: "ok" }, finish_reason: "stop" }] };

test("retries transient 429 then succeeds, honoring bounded retry-after", async () => {
  let calls = 0;
  const client = createUpstreamClient({
    baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m", timeoutMs: 1000, maxRetries: 2,
    logger: { info() {}, error() {} },
    fetchImpl: async () => {
      calls += 1;
      if (calls === 1) return jsonResponse({ error: "rate" }, 429, { "retry-after": "0" });
      return jsonResponse(okCompletion);
    },
  });
  const result = await client.complete({ messages: [{ role: "user", content: "hi" }] });
  assert.equal(calls, 2);
  assert.equal(result.choices[0].message.content, "ok");
});

test("does not retry provider-state, invalid JSON, timeout, or cancellation", async () => {
  let calls = 0;
  const client = createUpstreamClient({
    baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m", timeoutMs: 1000, maxRetries: 2,
    logger: { info() {}, error() {} },
    fetchImpl: async () => { calls += 1; return jsonResponse({ error: "thought signature missing" }, 400); },
  });
  await assert.rejects(() => client.complete({ messages: [] }), (e) => e.code === "upstream_provider_state");
  assert.equal(calls, 1);
});

test("maxRetries 0 disables retry", async () => {
  let calls = 0;
  const client = createUpstreamClient({
    baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m", timeoutMs: 1000, maxRetries: 0,
    logger: { info() {}, error() {} },
    fetchImpl: async () => { calls += 1; return jsonResponse({ error: "boom" }, 503); },
  });
  await assert.rejects(() => client.complete({ messages: [] }));
  assert.equal(calls, 1);
});

test("a negative maxRetries is clamped to no retry", async () => {
  let calls = 0;
  const client = createUpstreamClient({
    baseUrl: "http://127.0.0.1:9/v1", apiKey: "k", model: "m", timeoutMs: 1000, maxRetries: -3,
    logger: { info() {}, error() {} },
    fetchImpl: async () => { calls += 1; return jsonResponse({ error: "boom" }, 503); },
  });
  await assert.rejects(() => client.complete({ messages: [] }));
  assert.equal(calls, 1);
});

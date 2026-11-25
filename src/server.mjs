import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { parseConfig } from "./config.mjs";

const MODEL_ID = "toolbox-spike";
const MAX_BODY_BYTES = 2 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function sendJson(response, status, body, extraHeaders = {}) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
    ...extraHeaders,
  });
  response.end(text);
}

function sendError(response, status, message, code, extraHeaders = {}) {
  sendJson(
    response,
    status,
    { error: { message, type: "invalid_request_error", param: null, code } },
    extraHeaders,
  );
}

function isAuthorized(request, apiKey) {
  const authorization = request.headers.authorization;
  if (!authorization) return false;

  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1] === apiKey;
}

async function readJson(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, "Request body is too large", "request_too_large");
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    throw new HttpError(400, "Request body must be valid JSON", "invalid_json");
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Request body must be valid JSON", "invalid_json");
  }
}

function estimateTokens(value) {
  return Math.max(1, Math.ceil(JSON.stringify(value ?? "").length / 4));
}

function baseCompletion(config, payload) {
  return {
    id: `chatcmpl-${randomUUID()}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: MODEL_ID,
    system_fingerprint: `toolbox-router-${config.mode}`,
  };
}

function toolCallMessage() {
  return {
    role: "assistant",
    content: null,
    tool_calls: [
      {
        id: `call_${randomUUID()}`,
        type: "function",
        function: {
          name: "probe_tool",
          arguments: '{"probe":"qoder"}',
        },
      },
    ],
  };
}

function streamEvent(response, payload) {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamCompletion(response, config, payload, shouldCallTool) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders();

  const completion = baseCompletion(config, payload);
  streamEvent(response, {
    ...completion,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });

  if (shouldCallTool) {
    const toolCall = toolCallMessage().tool_calls[0];
    streamEvent(response, {
      ...completion,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: toolCall.id,
                type: "function",
                function: { name: toolCall.function.name, arguments: "" },
              },
            ],
          },
          finish_reason: null,
        },
      ],
    });
    streamEvent(response, {
      ...completion,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: toolCall.function.arguments } }],
          },
          finish_reason: null,
        },
      ],
    });
  } else {
    streamEvent(response, {
      ...completion,
      choices: [
        {
          index: 0,
          delta: {
            content: `Toolbox Router spike is reachable through ${config.host}:${config.port}.`,
          },
          finish_reason: null,
        },
      ],
    });
  }

  streamEvent(response, {
    ...completion,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: shouldCallTool ? "tool_calls" : "stop",
      },
    ],
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

function completeChat(response, config, payload) {
  const shouldCallTool =
    payload.tool_choice === "required" && Array.isArray(payload.tools) && payload.tools.length > 0;
  const promptTokens = estimateTokens(payload.messages);
  const message = shouldCallTool
    ? toolCallMessage()
    : {
        role: "assistant",
        content: `Toolbox Router spike is reachable through ${config.host}:${config.port}.`,
      };
  const completionTokens = estimateTokens(message.content ?? message.tool_calls);

  if (payload.stream === true) {
    streamCompletion(response, config, payload, shouldCallTool);
    return;
  }

  sendJson(response, 200, {
    ...baseCompletion(config, payload),
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message,
        logprobs: null,
        finish_reason: shouldCallTool ? "tool_calls" : "stop",
      },
    ],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  });
}

export function createRouterServer({ config, logger = console }) {
  return createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://toolbox-router.local");

      if (request.method === "GET" && url.pathname === "/health") {
        sendJson(response, 200, { ok: true, service: "toolbox-router", mode: config.mode });
        return;
      }

      if (url.pathname.startsWith("/v1/") && !isAuthorized(request, config.apiKey)) {
        sendError(response, 401, "Invalid or missing bearer token", "invalid_api_key", {
          "www-authenticate": "Bearer",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        sendJson(response, 200, {
          object: "list",
          data: [
            {
              id: MODEL_ID,
              object: "model",
              created: 0,
              owned_by: "toolbox-router",
            },
          ],
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = await readJson(request);
        logger.info(
          JSON.stringify({
            event: "chat_request",
            model: payload?.model,
            stream: payload?.stream === true,
            tool_choice: payload?.tool_choice,
            tool_count: Array.isArray(payload?.tools) ? payload.tools.length : 0,
            message_count: Array.isArray(payload?.messages) ? payload.messages.length : 0,
          }),
        );

        if (payload?.model !== MODEL_ID) {
          throw new HttpError(404, `Unknown model: ${payload?.model ?? "(missing)"}`, "model_not_found");
        }

        if (!Array.isArray(payload.messages)) {
          throw new HttpError(400, "messages must be an array", "invalid_messages");
        }

        completeChat(response, config, payload);
        return;
      }

      sendError(response, 404, "Not found", "not_found");
    } catch (error) {
      if (error instanceof HttpError) {
        sendError(response, error.status, error.message, error.code);
        return;
      }

      logger.error(JSON.stringify({ event: "server_error", message: error.message }));
      if (!response.headersSent) {
        sendError(response, 500, "Internal server error", "internal_error");
      } else {
        response.end();
      }
    }
  });
}

function start() {
  const config = parseConfig();
  const server = createRouterServer({ config });
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close(() => process.exit(0));
    server.closeAllConnections();
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  server.on("error", (error) => {
    console.error(JSON.stringify({ event: "listen_error", message: error.message }));
    process.exit(1);
  });

  server.listen(config.port, config.host, () => {
    console.log(
      JSON.stringify({
        event: "ready",
        host: config.host,
        port: config.port,
        base_url: `http://${config.host}:${config.port}/v1`,
        model: MODEL_ID,
        mode: config.mode,
      }),
    );
  });
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) start();

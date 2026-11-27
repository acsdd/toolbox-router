import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ChatLoopError, runChatLoop } from "./chat-loop.mjs";
import { assertModelAvailable, CapacityError, filterModelsByCapacity, inspectCapacity } from "./capacity.mjs";
import { advertisedHost, assertSecureRouterKey, parseConfig } from "./config.mjs";
import { ToolboxMcpBridge } from "./mcp-bridge.mjs";
import { RequestValidationError, boundedModelId, validateChatPayload } from "./request-validation.mjs";
import { createUpstreamClient, UpstreamError } from "./upstream.mjs";

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

function sendError(response, status, message, code, extraHeaders = {}, details = undefined) {
  sendJson(
    response,
    status,
    { error: { message, type: "invalid_request_error", param: null, code, ...(details ? { details } : {}) } },
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
  // Reject an unsupported media type before reading the body.
  const contentType = request.headers["content-type"]?.split(";")[0].trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new HttpError(415, "Content-Type must be application/json", "unsupported_media_type");
  }

  const chunks = [];
  let size = 0;
  let overflow = false;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      // Keep draining so the client can finish sending and still receives a
      // status code, but stop buffering the oversized body.
      overflow = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk);
  }

  if (overflow) throw new HttpError(413, "Request body is too large", "request_too_large");
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
    model: payload?.model ?? config.models?.[0]?.id ?? MODEL_ID,
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

function assistantText(message) {
  if (typeof message?.content === "string") return message.content;
  if (!Array.isArray(message?.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("");
}

function streamBridgeResult(response, config, payload, result) {
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

  const content = assistantText(result.message);
  if (content) {
    streamEvent(response, {
      ...completion,
      choices: [{ index: 0, delta: { content }, finish_reason: null }],
    });
  }

  const toolCalls = Array.isArray(result.message.tool_calls) ? result.message.tool_calls : [];
  for (const [index, toolCall] of toolCalls.entries()) {
    streamEvent(response, {
      ...completion,
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index,
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
            tool_calls: [{ index, function: { arguments: toolCall.function.arguments } }],
          },
          finish_reason: null,
        },
      ],
    });
  }

  streamEvent(response, {
    ...completion,
    choices: [{ index: 0, delta: {}, finish_reason: result.finishReason }],
  });
  response.write("data: [DONE]\n\n");
  response.end();
}

function sendBridgeResult(response, config, payload, result) {
  if (payload.stream === true) {
    streamBridgeResult(response, config, payload, result);
    return;
  }

  sendJson(response, 200, {
    ...baseCompletion(config, payload),
    object: "chat.completion",
    choices: [
      {
        index: 0,
        message: result.message,
        logprobs: null,
        finish_reason: result.finishReason,
      },
    ],
    usage: result.usage,
    toolbox: { rounds: result.rounds },
  });
}

function sanitizeErrorMessage(message, apiKey) {
  const text = apiKey ? String(message).replaceAll(apiKey, "[redacted]") : String(message);
  return text
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

function safeErrorType(error) {
  const value = error?.name;
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : "Error";
}

function safeErrorCode(error) {
  const value = error?.code;
  return typeof value === "string" && /^[a-z0-9_]{1,64}$/.test(value) ? value : "internal_error";
}

function clientErrorMessage(error) {
  if (error instanceof HttpError || error instanceof ChatLoopError || error instanceof CapacityError) return error.message;
  if (error instanceof UpstreamError) {
    if (error.code === "upstream_timeout") return "Upstream Chat Completions request timed out";
    if (error.code === "upstream_provider_state") {
      return "The model provider requires missing conversation state, such as a thought signature. Start a new chat or select a provider that preserves tool-call state.";
    }
    if (error.status === 402) return "The model provider requires payment or account access. Check your provider account or select another available model.";
    if (error.status >= 400 && error.status <= 599) {
      return `Upstream Chat Completions failed with HTTP ${error.status}`;
    }
    return "Upstream Chat Completions request failed";
  }
  return "Internal server error";
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

export function createRouterServer({
  config,
  logger = console,
  bridge = null,
  upstream = null,
  getCapacity = () => inspectCapacity(config),
  shutdownSignal,
  isShuttingDown = () => false,
}) {
  const readCapacity = async () => {
    try {
      return await getCapacity();
    } catch (error) {
      logger.error(
        JSON.stringify({
          event: "capacity_error",
          message: sanitizeErrorMessage(error.message, config.upstream?.apiKey ?? ""),
        }),
      );
      return {
        ok: false,
        drive: "D:",
        modelRoot: config.modelRoot,
        freeBytes: 0,
        reserveBytes: config.minFreeBytes,
        availableBytes: 0,
        error: sanitizeErrorMessage(error.message, config.upstream?.apiKey ?? ""),
      };
    }
  };

  return createServer(async (request, response) => {
    try {
      if (isShuttingDown()) {
        sendError(response, 503, "Router is shutting down", "router_shutting_down");
        return;
      }
      const url = new URL(request.url, "http://toolbox-router.local");

      if (request.method === "GET" && url.pathname === "/health") {
        const ok = config.mode === "mock" || bridge?.ready === true;
        const capacity = await readCapacity();
        const mcp = bridge?.status?.();
        const authenticated = isAuthorized(request, config.apiKey);
        // Health is public for local status dashboards. Do not expose local paths,
        // process IDs, or verbose runtime errors to unauthenticated callers.
        sendJson(response, 200, {
          ok,
          service: "toolbox-router",
          mode: config.mode,
          capacity: authenticated ? capacity : { ok: capacity.ok === true },
          ...(config.mode === "bridge" ? { mcp: authenticated ? (mcp ?? { ready: false, toolCount: 0 }) : { ready: mcp?.ready === true, toolCount: Number.isSafeInteger(mcp?.toolCount) ? mcp.toolCount : 0 } } : {}),
        });
        return;
      }

      if (url.pathname.startsWith("/v1/") && !isAuthorized(request, config.apiKey)) {
        sendError(response, 401, "Invalid or missing bearer token", "invalid_api_key", {
          "www-authenticate": "Bearer",
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/v1/models") {
        const capacity = await readCapacity();
        const models = filterModelsByCapacity(config.models, capacity);
        sendJson(response, 200, {
          object: "list",
          data: models.map((model) => ({
            id: model.id,
            object: "model",
            created: 0,
            owned_by: "toolbox-router",
          })),
          capacity,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
        const payload = await readJson(request);
        const requestId = randomUUID();
        response.setHeader("x-request-id", requestId);
        validateChatPayload(payload);
        const selectedModel = config.models.find((model) => model.id === payload.model);
        if (!selectedModel) {
          throw new HttpError(404, `Unknown model: ${boundedModelId(payload.model) || "(missing)"}`, "model_not_found");
        }
        logger.info(
          JSON.stringify({
            event: "chat_request",
            request_id: requestId,
            model: selectedModel.id,
            stream: payload.stream === true,
            tool_choice: ["auto", "none", "required"].includes(payload.tool_choice)
              ? payload.tool_choice
              : payload.tool_choice && typeof payload.tool_choice === "object" ? "specific" : "unspecified",
            tool_count: Array.isArray(payload.tools) ? payload.tools.length : 0,
            message_count: Array.isArray(payload.messages) ? payload.messages.length : 0,
          }),
        );

        assertModelAvailable(selectedModel, await readCapacity());

        if (config.mode === "bridge") {
          if (!upstream) throw new HttpError(503, "Upstream model is not configured", "upstream_not_ready");
          if (!bridge.ready && typeof bridge.ensureReady === "function") {
            try {
              await bridge.ensureReady();
            } catch (error) {
              logger.error(
                JSON.stringify({
                  event: "bridge_not_ready",
                  request_id: requestId,
                  error: sanitizeErrorMessage(error?.message ?? String(error), config.upstream?.apiKey ?? ""),
                }),
              );
              throw new ChatLoopError("Toolbox MCP bridge is not ready", 503, "mcp_not_ready");
            }
          }
          const clientAbort = new AbortController();
          const onClose = () => { if (!response.writableFinished) clientAbort.abort(); };
          response.once("close", onClose);
          if (response.destroyed) clientAbort.abort();
          const signal = shutdownSignal ? AbortSignal.any([shutdownSignal, clientAbort.signal]) : clientAbort.signal;
          let result;
          try {
            result = await runChatLoop({ payload, config, upstream, upstreamModel: selectedModel.upstreamModel, bridge, logger, signal, requestId });
          } finally {
            response.off("close", onClose);
          }
          if (response.destroyed) return;
          sendBridgeResult(response, config, payload, result);
          return;
        }

        completeChat(response, config, payload);
        return;
      }

      sendError(response, 404, "Not found", "not_found");
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof HttpError || error instanceof RequestValidationError) {
        sendError(response, error.status, error.message, error.code);
        return;
      }
      if (error instanceof ChatLoopError && error.code === "request_cancelled") {
        if (!response.headersSent) {
          sendError(response, error.status, error.message, error.code);
        } else {
          response.end();
        }
        return;
      }

      logger.error(
        JSON.stringify({
          event: "server_error",
          error_type: safeErrorType(error),
          code: safeErrorCode(error),
        }),
      );
      if (!response.headersSent) {
        const status = error.status >= 400 && error.status <= 599 ? error.status : error instanceof UpstreamError ? 502 : 500;
        sendError(
          response,
          status,
          clientErrorMessage(error),
          safeErrorCode(error),
          {},
          error instanceof HttpError || error instanceof CapacityError ? error.details : undefined,
        );
      } else {
        response.end();
      }
    }
  });
}

async function start() {
  const config = parseConfig();
  assertSecureRouterKey(config);
  const logger = console;
  const bridge = config.mode === "bridge" ? new ToolboxMcpBridge({ config, logger }) : null;
  const upstream =
    config.mode === "bridge"
      ? createUpstreamClient({ ...config.upstream, logger })
      : null;
  let shuttingDown = false;
  const shutdownController = new AbortController();
  const server = createRouterServer({
    config,
    logger,
    bridge,
    upstream,
    shutdownSignal: shutdownController.signal,
    isShuttingDown: () => shuttingDown,
  });

  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    shutdownController.abort();
    logger.info(JSON.stringify({ event: "shutdown_started" }));

    try {
      if (bridge) await bridge.close();
      logger.info(JSON.stringify({ event: "mcp_shutdown_complete" }));
    } catch (error) {
      logger.error(
        JSON.stringify({
          event: "mcp_shutdown_error",
          error_type: safeErrorType(error),
        }),
      );
      process.exitCode = 1;
    }

    await new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 1_000);
      timer.unref();
      server.close(finish);
      server.closeIdleConnections();
      server.closeAllConnections();
    });
    logger.info(JSON.stringify({ event: "shutdown_complete" }));
    process.exitCode = process.exitCode ?? 0;
    if (process.connected) process.disconnect();
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
  // The launcher owns an IPC channel so it can request graceful cleanup on
  // Windows, where child.kill() cannot deliver a catchable SIGTERM.
  process.on("message", (message) => {
    if (message?.type === "shutdown") void shutdown();
  });

  if (shuttingDown) return;
  if (bridge) {
    try {
      await bridge.start();
    } catch (error) {
      if (!shuttingDown) {
        logger.error(
          JSON.stringify({
            event: "mcp_startup_error",
            error_type: safeErrorType(error),
          }),
        );
      }
    }
  }
  if (shuttingDown) return;

  let capacity;
  try {
    capacity = await inspectCapacity(config);
  } catch (error) {
    capacity = {
      ok: false,
      drive: "D:",
      availableBytes: 0,
      error: sanitizeErrorMessage(error.message, config.upstream?.apiKey ?? ""),
    };
    logger.error(JSON.stringify({ event: "capacity_error", message: capacity.error }));
  }
  if (shuttingDown) return;

  server.on("error", (error) => {
    logger.error(
      JSON.stringify({
        event: "listen_error",
        message: sanitizeErrorMessage(error.message, config.upstream?.apiKey ?? ""),
      }),
    );
    void shutdown().finally(() => process.exit(1));
  });

  server.listen(config.port, config.host, () => {
    logger.info(
      JSON.stringify({
        event: "ready",
        host: config.host,
        port: config.port,
        base_url: `http://${advertisedHost(config.host)}:${config.port}/v1`,
        model: config.models[0].id,
        mode: config.mode,
        ready: config.mode === "mock" || bridge?.ready === true,
        capacity,
        ...(bridge ? { mcp: bridge.status() } : {}),
      }),
    );
  });
}

const isMain =
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) start();

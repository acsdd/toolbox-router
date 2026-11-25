const MAX_RESPONSE_BYTES = 4 * 1024 ** 2;
const FORWARDED_FIELDS = [
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "presence_penalty",
  "frequency_penalty",
  "stop",
  "response_format",
  "seed",
  "user",
  "parallel_tool_calls",
  "tool_choice",
  "reasoning_effort",
];

export class UpstreamError extends Error {
  constructor(message, status = 0, code = "upstream_error") {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.code = code;
  }
}

function redact(value, apiKey) {
  return String(value)
    .replaceAll(apiKey, "[redacted]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [redacted]")
    .slice(0, 1000);
}

async function readResponseText(response) {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new UpstreamError("Upstream response was too large", response.status);
  }

  const reader = response.body?.getReader();
  if (!reader) return "";

  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new UpstreamError("Upstream response was too large", response.status);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, size).toString("utf8");
}

function validateCompletion(value) {
  const choice = value?.choices?.[0];
  const message = choice?.message;
  if (message?.tool_calls != null && !Array.isArray(message.tool_calls)) {
    throw new UpstreamError("Upstream message tool_calls must be an array", 502, "invalid_upstream_response");
  }
  if (
    !message ||
    typeof message !== "object" ||
    (typeof message.content !== "string" && message.content !== null && !Array.isArray(message.tool_calls))
  ) {
    throw new UpstreamError("Upstream returned an invalid Chat Completions response", 502, "invalid_upstream_response");
  }
  return value;
}

export function createUpstreamClient({
  baseUrl,
  apiKey,
  model,
  timeoutMs,
  fetchImpl = fetch,
  logger = console,
}) {
  if (!baseUrl || !apiKey || !model) {
    throw new Error("Upstream base URL, API key, and model are required");
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;

  return {
    endpoint,
    async complete(payload = {}, { model: requestedModel, signal } = {}) {
      const selectedModel = requestedModel ?? model;
      if (typeof selectedModel !== "string" || !selectedModel.trim()) {
        throw new UpstreamError("An explicit upstream model is required", 500, "upstream_model_missing");
      }
      const body = { model: selectedModel, messages: payload.messages, stream: false };
      for (const field of FORWARDED_FIELDS) {
        if (payload[field] !== undefined) body[field] = payload[field];
      }
      if (Array.isArray(payload.tools) && payload.tools.length > 0) body.tools = payload.tools;

      const controller = new AbortController();
      const requestSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const startedAt = Date.now();

      try {
        const response = await fetchImpl(endpoint, {
          method: "POST",
          headers: {
            authorization: `Bearer ${apiKey}`,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          signal: requestSignal,
        });
        const text = await readResponseText(response);

        if (!response.ok) {
          throw new UpstreamError(
            `Upstream Chat Completions failed with HTTP ${response.status}`,
            response.status,
            "upstream_http_error",
          );
        }

        let parsed;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new UpstreamError("Upstream returned invalid JSON", response.status, "invalid_upstream_json");
        }

        logger.info(
          JSON.stringify({
            event: "upstream_request",
            model: selectedModel,
            status: response.status,
            duration_ms: Date.now() - startedAt,
            message_count: Array.isArray(payload.messages) ? payload.messages.length : 0,
            tool_count: Array.isArray(payload.tools) ? payload.tools.length : 0,
          }),
        );
        return validateCompletion(parsed);
      } catch (error) {
        if (error instanceof UpstreamError) {
          logger.error(
            JSON.stringify({
              event: "upstream_request",
              model: selectedModel,
              status: error.status,
              duration_ms: Date.now() - startedAt,
              error: redact(error.message, apiKey),
            }),
          );
          throw error;
        }
        if (signal?.aborted) {
          throw new UpstreamError("Upstream Chat Completions request was cancelled", 499, "upstream_cancelled");
        }
        if (timedOut || controller.signal.aborted) {
          throw new UpstreamError(`Upstream Chat Completions timed out after ${timeoutMs}ms`, 504, "upstream_timeout");
        }
        throw new UpstreamError("Upstream Chat Completions request failed", 0, "upstream_network_error");
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

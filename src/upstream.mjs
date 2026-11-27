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

export function classifyProviderStateError(text, status) {
  if (![400, 409, 422].includes(status)) return "upstream_http_error";
  const body = String(text).slice(0, 16_384);
  const thoughtSignature = /thought[\s_-]*signature/i.test(body);
  const stateWords = /missing|required|invalid|expired|not found|must be (?:supplied|provided|passed)/i.test(body);
  const providerState = /(?:conversation|provider|request|function call)[\s\S]{0,100}(?:state|context)[\s\S]{0,100}(?:missing|invalid|expired|not found|required)/i.test(body);
  return (thoughtSignature && stateWords) || providerState
    ? "upstream_provider_state"
    : "upstream_http_error";
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

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

function parseRetryAfterMs(header) {
  if (!header) return 0;
  const seconds = Number(header);
  if (Number.isFinite(seconds)) return Math.min(Math.max(seconds * 1000, 0), 30_000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 30_000);
  return 0;
}

function cancelledError() {
  return new UpstreamError("Upstream Chat Completions request was cancelled", 499, "upstream_cancelled");
}

function toUpstreamError(error, { signal, timedOut, controller, timeoutMs }) {
  if (error instanceof UpstreamError) return error;
  if (signal?.aborted) return cancelledError();
  if (timedOut || controller.signal.aborted) {
    return new UpstreamError(`Upstream Chat Completions timed out after ${timeoutMs}ms`, 504, "upstream_timeout");
  }
  return new UpstreamError("Upstream Chat Completions request failed", 0, "upstream_network_error");
}

function isRetryable(error) {
  if (!(error instanceof UpstreamError)) return false;
  if (["upstream_provider_state", "upstream_timeout", "upstream_cancelled", "invalid_upstream_json", "invalid_upstream_response"].includes(error.code)) return false;
  return error.code === "upstream_network_error" || RETRYABLE_STATUS.has(error.status);
}

function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(cancelledError());
      return;
    }
    function onAbort() {
      clearTimeout(timer);
      reject(cancelledError());
    }
    const timer = setTimeout(() => {
      // Drop the listener once the wait is over so a long-lived signal does not
      // accumulate one listener per retry.
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createUpstreamClient({
  baseUrl,
  apiKey,
  model,
  timeoutMs,
  fetchImpl = fetch,
  logger = console,
  maxRetries = 2,
}) {
  if (!baseUrl || !apiKey || !model) {
    throw new Error("Upstream base URL, API key, and model are required");
  }

  const endpoint = `${baseUrl.replace(/\/+$/, "")}/chat/completions`;
  const retries = Math.max(0, Math.floor(Number(maxRetries) || 0));

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

      async function attemptOnce(attempt) {
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
            const code = classifyProviderStateError(text, response.status);
            const error = new UpstreamError(
              code === "upstream_provider_state"
                ? "The model provider requires missing conversation state"
                : `Upstream Chat Completions failed with HTTP ${response.status}`,
              response.status,
              code,
            );
            error.retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
            throw error;
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
          const failure = toUpstreamError(error, { signal, timedOut, controller, timeoutMs });
          const entry = JSON.stringify({
            event: "upstream_request",
            model: selectedModel,
            attempt: attempt + 1,
            status: failure.status,
            duration_ms: Date.now() - startedAt,
            error: redact(failure.message, apiKey),
          });
          // Only the last attempt is a failure worth an error entry; the ones
          // before it are retries and stay at info level.
          if (attempt >= retries) logger.error(entry);
          else logger.info(entry);
          throw failure;
        } finally {
          clearTimeout(timer);
        }
      }

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          return await attemptOnce(attempt);
        } catch (error) {
          if (!isRetryable(error) || attempt === retries || signal?.aborted) throw error;
          const base = Math.min(250 * 2 ** attempt, 5000);
          const jitter = Math.floor(Math.random() * 100);
          const delayMs = Math.max(error.retryAfterMs ?? 0, base) + jitter;
          logger.info(
            JSON.stringify({
              event: "upstream_retry",
              model: selectedModel,
              attempt: attempt + 1,
              status: error.status,
              delay_ms: delayMs,
            }),
          );
          await abortableDelay(delayMs, signal);
        }
      }
      // The loop above always returns or throws; this keeps the contract explicit.
      throw new UpstreamError("Upstream Chat Completions request failed", 0, "upstream_network_error");
    },
  };
}

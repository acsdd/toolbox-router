import {
  approvalRequiredResult,
  classifyTool,
  mergeTools,
  parseToolArguments,
} from "./tool-policy.mjs";

export class ChatLoopError extends Error {
  constructor(message, status = 502, code = "chat_loop_error") {
    super(message);
    this.name = "ChatLoopError";
    this.status = status;
    this.code = code;
  }
}

function throwIfCancelled(signal) {
  if (signal?.aborted) {
    throw new ChatLoopError("Chat request was cancelled", 499, "request_cancelled");
  }
}

function toolName(tool) {
  return typeof tool?.function?.name === "string" ? tool.function.name : "";
}

function normalizeToolCalls(message, round) {
  if (!Array.isArray(message?.tool_calls)) return [];

  return message.tool_calls.map((call, index) => {
    const name = toolName(call);
    if (!name) throw new ChatLoopError("Upstream returned a tool call without a function name", 502, "invalid_tool_call");
    return {
      ...call,
      id: typeof call.id === "string" && call.id ? call.id : `call_${round}_${index}`,
      type: "function",
      function: {
        ...call.function,
        name,
        arguments:
          typeof call.function.arguments === "string"
            ? call.function.arguments
            : JSON.stringify(call.function.arguments ?? {}),
      },
    };
  });
}

function addUsage(total, usage) {
  return {
    prompt_tokens: total.prompt_tokens + (usage?.prompt_tokens ?? 0),
    completion_tokens: total.completion_tokens + (usage?.completion_tokens ?? 0),
    total_tokens: total.total_tokens + (usage?.total_tokens ?? 0),
  };
}

function toolResultText(name, result) {
  if (result?.isError) return `Toolbox tool ${name} failed: ${result.content}`;
  return result?.content ?? "";
}

export async function runChatLoop({ payload, config, upstream, upstreamModel, bridge, logger = console, signal }) {
  throwIfCancelled(signal);
  if (!bridge?.ready) {
    throw new ChatLoopError("Toolbox MCP bridge is not ready", 503, "mcp_not_ready");
  }

  const clientTools = Array.isArray(payload.tools) ? payload.tools : [];
  const clientNames = new Set(clientTools.map(toolName).filter(Boolean));
  const bridgeNames = new Set(bridge.tools.map(toolName));
  const tools = mergeTools(clientTools, bridge.tools);
  const messages = payload.messages.map((message) => ({ ...message }));
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };

  for (let round = 1; round <= config.limits.maxModelRounds; round += 1) {
    throwIfCancelled(signal);
    const roundPayload = { ...payload, messages, tools };
    if (round > 1 && payload.tool_choice !== undefined) roundPayload.tool_choice = "auto";
    const options = {
      ...(upstreamModel ? { model: upstreamModel } : {}),
      ...(signal ? { signal } : {}),
    };
    let completion;
    try {
      completion = await upstream.complete(roundPayload, Object.keys(options).length ? options : undefined);
    } catch (error) {
      throwIfCancelled(signal);
      throw error;
    }
    throwIfCancelled(signal);
    const choice = completion.choices[0];
    const message = choice.message;
    const toolCalls = normalizeToolCalls(message, round);
    const nextUsage = addUsage(usage, completion.usage);

    if (toolCalls.length === 0) {
      logger.info(
        JSON.stringify({
          event: "chat_loop_complete",
          rounds: round,
          tool_calls: 0,
          duration_ms: 0,
        }),
      );
      return {
        message,
        finishReason: choice.finish_reason || "stop",
        usage: nextUsage,
        rounds: round,
      };
    }

    if (toolCalls.length > config.limits.maxToolCallsPerRound) {
      throw new ChatLoopError(
        `Model exceeded the tool call limit of ${config.limits.maxToolCallsPerRound} per round`,
        502,
        "tool_call_limit",
      );
    }

    const passThrough = toolCalls.some((call) => {
      const name = call.function.name;
      const classification = classifyTool(name);
      if (classification === "external") return clientNames.has(name);
      if (classification === "restricted") return clientNames.has(name);
      return classification === "auto" && !bridgeNames.has(name) && clientNames.has(name);
    });

    if (passThrough) {
      logger.info(
        JSON.stringify({
          event: "chat_loop_passthrough",
          rounds: round,
          tool_calls: toolCalls.length,
        }),
      );
      return {
        message: { ...message, role: "assistant", content: message.content ?? null, tool_calls: toolCalls },
        finishReason: "tool_calls",
        usage: nextUsage,
        rounds: round,
      };
    }

    if (round >= config.limits.maxModelRounds) {
      throw new ChatLoopError(
        `Model reached the ${config.limits.maxModelRounds}-round limit without a final answer`,
        502,
        "model_round_limit",
      );
    }

    messages.push({ ...message, role: "assistant", content: message.content ?? null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      throwIfCancelled(signal);
      const name = call.function.name;
      const classification = classifyTool(name);
      let content;

      if (classification === "blocked") {
        content = JSON.stringify({ error: "blocked", tool: name, message: "This tool is blocked by router policy." });
      } else if (classification === "restricted") {
        content = JSON.stringify(approvalRequiredResult(name));
      } else if (classification === "external" || !bridgeNames.has(name)) {
        content = JSON.stringify({ error: "unknown_tool", tool: name, message: "The requested tool is not available." });
      } else {
        try {
          const args = parseToolArguments(call.function.arguments);
          const result = await bridge.callTool(name, args, { signal });
          throwIfCancelled(signal);
          content = toolResultText(name, result);
        } catch (error) {
          throwIfCancelled(signal);
          content = `Toolbox tool ${name} failed`;
        }
      }

      messages.push({ role: "tool", tool_call_id: call.id, content });
    }

    logger.info(
      JSON.stringify({
        event: "chat_loop_round",
        round,
        tool_calls: toolCalls.length,
      }),
    );
  }

  throw new ChatLoopError(
    `Model reached the ${config.limits.maxModelRounds}-round limit without a final answer`,
    502,
    "model_round_limit",
  );
}

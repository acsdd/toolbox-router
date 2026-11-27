const ROLES = new Set(["system", "user", "assistant", "tool"]);
const TOOL_CHOICE_STRINGS = new Set(["auto", "none", "required"]);

export class RequestValidationError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "RequestValidationError";
    this.status = 400;
    this.code = code;
  }
}

export function boundedModelId(value) {
  return String(value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 128);
}

function isContentPart(part) {
  return part !== null && typeof part === "object" && typeof part.type === "string";
}

function isValidToolCall(call) {
  return (
    call !== null && typeof call === "object" &&
    typeof call.id === "string" && call.id.length > 0 &&
    call.type === "function" &&
    call.function !== null && typeof call.function === "object" &&
    typeof call.function.name === "string" && call.function.name.length > 0 &&
    (call.function.arguments === undefined ||
      typeof call.function.arguments === "string" ||
      (call.function.arguments !== null && typeof call.function.arguments === "object"))
  );
}

function isValidMessage(message) {
  if (message === null || typeof message !== "object") return false;
  if (!ROLES.has(message.role)) return false;
  if (message.role === "tool" && (typeof message.tool_call_id !== "string" || !message.tool_call_id)) return false;
  if (
    message.content !== undefined && message.content !== null &&
    typeof message.content !== "string" && !Array.isArray(message.content)
  ) return false;
  if (Array.isArray(message.content) && !message.content.every(isContentPart)) return false;
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || !message.tool_calls.every(isValidToolCall)) return false;
  }
  return true;
}

function isValidTool(tool) {
  return (
    tool !== null && typeof tool === "object" &&
    tool.type === "function" &&
    tool.function !== null && typeof tool.function === "object" &&
    typeof tool.function.name === "string" && tool.function.name.length > 0 &&
    (tool.function.parameters === undefined ||
      (tool.function.parameters !== null && typeof tool.function.parameters === "object" && !Array.isArray(tool.function.parameters)))
  );
}

function isValidToolChoice(choice) {
  if (typeof choice === "string") return TOOL_CHOICE_STRINGS.has(choice);
  return (
    choice !== null && typeof choice === "object" &&
    choice.type === "function" &&
    choice.function !== null && typeof choice.function === "object" &&
    typeof choice.function.name === "string" && choice.function.name.length > 0
  );
}

/** How the request steered tool use, in a form that is safe to log. */
export function toolChoiceLabel(choice) {
  if (typeof choice === "string") return TOOL_CHOICE_STRINGS.has(choice) ? choice : "unspecified";
  if (choice !== null && typeof choice === "object") return "specific";
  return "unspecified";
}

export function validateChatPayload(payload) {
  if (payload === null || typeof payload !== "object") {
    throw new RequestValidationError("Request body must be a JSON object", "invalid_payload");
  }
  if (typeof payload.model !== "string" || !payload.model.trim()) {
    throw new RequestValidationError("model must be a non-empty string", "invalid_model");
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0 || !payload.messages.every(isValidMessage)) {
    throw new RequestValidationError("messages must be a non-empty array of valid chat messages", "invalid_messages");
  }
  if (payload.tools !== undefined && (!Array.isArray(payload.tools) || !payload.tools.every(isValidTool))) {
    throw new RequestValidationError("tools must be an array of valid function tools", "invalid_tools");
  }
  if (payload.tool_choice !== undefined && !isValidToolChoice(payload.tool_choice)) {
    throw new RequestValidationError("tool_choice must be auto, none, required, or a function selector", "invalid_tool_choice");
  }
  if (payload.stream !== undefined && typeof payload.stream !== "boolean") {
    throw new RequestValidationError("stream must be a boolean", "invalid_stream");
  }
}
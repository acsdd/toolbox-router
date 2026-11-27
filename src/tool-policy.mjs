export const BRIDGE_TOOL_NAMES = new Set([
  "crypto_status",
  "crypto_refresh",
  "crypto_set_watchlist",
  "crypto_series",
  "gmail_status",
  "gmail_check",
  "system_stats",
  "system_processes",
  "llamafarm_status",
  "llamafarm_catalog",
  "llamafarm_score",
  "llamafarm_refresh",
  "llamafarm_grade",
  "llamafarm_install",
  "llamafarm_search",
  "llamafarm_quants",
  "llamafarm_remove",
  "llamafarm_cancel",
  "llamafarm_run_now",
  "llamafarm_progress",
  "llamafarm_notes",
  "llamafarm_note",
  "runtimes_detect",
  "runtimes_install",
  "runtimes_use",
  "runtimes_models",
  "runtimes_download",
  "gateway_status",
  "gateway_requests",
  "marketplace_list",
  "marketplace_install",
  "marketplace_uninstall",
  "remote_status",
  "widgets_export",
  "widgets_import",
]);

export const CREDENTIAL_TOOL_NAMES = new Set(["gmail_connect", "gmail_disconnect"]);

export const RESTRICTED_TOOL_NAMES = new Set([
  "gmail_status",
  "gmail_check",
  "gateway_requests",
  "widgets_export",
  "llamafarm_notes",
  "crypto_set_watchlist",
  "llamafarm_install",
  "llamafarm_remove",
  "llamafarm_cancel",
  "llamafarm_note",
  "runtimes_install",
  "runtimes_use",
  "runtimes_download",
  "marketplace_install",
  "marketplace_uninstall",
  "widgets_import",
]);

const EMPTY_OBJECT_SCHEMA = { type: "object", properties: {} };

export function classifyTool(name) {
  if (CREDENTIAL_TOOL_NAMES.has(name)) return "blocked";
  if (RESTRICTED_TOOL_NAMES.has(name)) return "restricted";
  if (BRIDGE_TOOL_NAMES.has(name)) return "auto";
  return "external";
}

export function mcpToolToOpenAI(tool) {
  const schema =
    tool?.inputSchema && typeof tool.inputSchema === "object" && !Array.isArray(tool.inputSchema)
      ? tool.inputSchema
      : EMPTY_OBJECT_SCHEMA;

  return {
    type: "function",
    function: {
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: schema,
    },
  };
}

export function buildBridgeTools(mcpTools) {
  const names = new Set();
  const tools = [];

  for (const tool of Array.isArray(mcpTools) ? mcpTools : []) {
    if (!BRIDGE_TOOL_NAMES.has(tool?.name) || names.has(tool.name)) continue;
    names.add(tool.name);
    tools.push(mcpToolToOpenAI(tool));
  }

  return tools;
}

function isValidOpenAITool(tool) {
  return (
    tool?.type === "function" &&
    typeof tool.function?.name === "string" &&
    tool.function.name.length > 0
  );
}

export function mergeTools(clientTools, bridgeTools) {
  const merged = new Map();

  for (const tool of Array.isArray(clientTools) ? clientTools : []) {
    if (!isValidOpenAITool(tool) || CREDENTIAL_TOOL_NAMES.has(tool.function.name)) continue;
    merged.set(tool.function.name, tool);
  }

  for (const tool of Array.isArray(bridgeTools) ? bridgeTools : []) {
    if (!isValidOpenAITool(tool) || CREDENTIAL_TOOL_NAMES.has(tool.function.name)) continue;
    merged.set(tool.function.name, tool);
  }

  return [...merged.values()];
}

export function parseToolArguments(raw) {
  if (raw === undefined || (typeof raw === "string" && raw.trim() === "")) return {};

  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Tool arguments must be valid JSON");
    }
  }

  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  return value;
}

export function approvalRequiredResult(name) {
  return {
    approval_required: true,
    tool: name,
    message: "This Toolbox tool requires Qoder approval and was not executed by the router.",
  };
}

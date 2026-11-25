import { mkdir } from "node:fs/promises";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { buildBridgeTools } from "./tool-policy.mjs";

function withTimeout(promise, timeoutMs, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function safeErrorType(error) {
  const value = error?.name;
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value) ? value : "Error";
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function extractResultText(result) {
  if (result?.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }

  if (typeof result?.content === "string") return result.content;
  if (!Array.isArray(result?.content)) return JSON.stringify(result ?? {});

  return result.content
    .map((item) => {
      if (item?.type === "text" && typeof item.text === "string") return item.text;
      return `[${item?.type ?? "unknown"} content]`;
    })
    .join("\n");
}

export class ToolboxMcpBridge {
  constructor({ config, logger = console }) {
    this.config = config;
    this.logger = logger;
    this.ready = false;
    this.tools = [];
    this.registry = new Map();
    this.client = null;
    this.transport = null;
    this.pid = null;
    this.starting = null;
    this.closing = null;
    this.stderrBytes = 0;
    this.closedPromise = new Promise((resolveClose) => {
      this.resolveClosed = resolveClose;
    });
  }

  status() {
    return {
      ready: this.ready,
      toolCount: this.tools.length,
      runtime: this.config.mcp.runtime,
      pid: this.pid,
      home: this.config.mcp.home,
    };
  }

  async start() {
    if (this.ready) return;
    if (this.starting) return this.starting;

    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  async startInternal() {
    await mkdir(this.config.mcp.home, { recursive: true });

    const env = {
      TOOLBOX_MCP_HOME: this.config.mcp.home,
      TOOLBOX_MCP_PORT: String(this.config.mcp.port),
    };
    if (["portable", "installed"].includes(this.config.mcp.runtime)) {
      env.ELECTRON_RUN_AS_NODE = "1";
    }

    this.transport = new StdioClientTransport({
      command: this.config.mcp.command,
      args: this.config.mcp.args,
      cwd: this.config.mcp.cwd || undefined,
      env,
      stderr: "pipe",
    });
    this.transport.onclose = () => {
      this.ready = false;
      this.pid = null;
      this.resolveClosed();
      if (!this.closing) {
        this.logger.error(JSON.stringify({ event: "mcp_closed", runtime: this.config.mcp.runtime }));
      }
    };

    this.client = new Client({ name: "toolbox-router", version: "0.1.0" }, { capabilities: {} });
    this.client.onerror = (error) => {
      this.logger.error(JSON.stringify({ event: "mcp_error", error_type: safeErrorType(error) }));
    };

    this.transport.stderr?.on("data", (chunk) => {
      this.stderrBytes += chunk.length;
    });

    try {
      await withTimeout(
        this.client.connect(this.transport),
        this.config.mcp.startupTimeoutMs,
        "MCP startup",
      );
      this.pid = this.transport.pid;

      const listed = await withTimeout(
        this.client.listTools({}, { timeout: this.config.mcp.startupTimeoutMs }),
        this.config.mcp.startupTimeoutMs,
        "MCP tools/list",
      );
      this.tools = buildBridgeTools(listed.tools);
      const allowedNames = new Set(this.tools.map((tool) => tool.function.name));
      this.registry = new Map(
        (Array.isArray(listed.tools) ? listed.tools : [])
          .filter((tool) => allowedNames.has(tool.name))
          .map((tool) => [tool.name, tool]),
      );

      if (this.tools.length === 0) {
        throw new Error("No allowed Toolbox MCP tools were discovered");
      }

      this.ready = true;
      this.logger.info(
        JSON.stringify({
          event: "mcp_ready",
          runtime: this.config.mcp.runtime,
          pid: this.pid,
          tool_count: this.tools.length,
        }),
      );
    } catch (error) {
      this.ready = false;
      this.logger.error(
        JSON.stringify({
          event: "mcp_startup_failed",
          error_type: safeErrorType(error),
          stderr_bytes: this.stderrBytes,
        }),
      );
      await this.close().catch(() => {});
      throw error;
    }
  }

  async callTool(name, args = {}, { signal } = {}) {
    if (!this.ready || !this.registry.has(name)) {
      throw new Error(`Toolbox MCP tool is not available: ${name}`);
    }

    const startedAt = Date.now();
    try {
      const result = await withTimeout(
        this.client.callTool({ name, arguments: args }, undefined, {
          timeout: this.config.mcp.callTimeoutMs,
          ...(signal ? { signal } : {}),
        }),
        this.config.mcp.callTimeoutMs,
        `Toolbox MCP tool ${name}`,
      );
      const content = extractResultText(result);
      const bytes = Buffer.byteLength(content);
      const normalized =
        bytes > this.config.mcp.maxResultBytes
          ? {
              isError: true,
              content: `Tool result exceeded the ${this.config.mcp.maxResultBytes}-byte router limit and was not sent to the model.`,
              bytes,
            }
          : { isError: result?.isError === true, content, bytes };

      this.logger.info(
        JSON.stringify({
          event: "mcp_tool_call",
          name,
          duration_ms: Date.now() - startedAt,
          status: normalized.isError ? "error" : "ok",
          result_bytes: bytes,
        }),
      );
      return normalized;
    } catch (error) {
      this.logger.error(
        JSON.stringify({
          event: "mcp_tool_call",
          name,
          duration_ms: Date.now() - startedAt,
          status: "failed",
          error_type: safeErrorType(error),
        }),
      );
      throw error;
    }
  }

  close() {
    if (this.closing) return this.closing;
    this.closing = this.closeInternal();
    return this.closing;
  }

  async closeInternal() {
    this.ready = false;
    const pid = this.pid;

    try {
      if (this.client) await this.client.close();
    } catch (error) {
      this.logger.error(JSON.stringify({ event: "mcp_shutdown_error", error_type: safeErrorType(error) }));
    }

    const exited = await Promise.race([
      this.closedPromise.then(() => true),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000).unref()),
    ]);

    if (!exited && isProcessAlive(pid)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // The child may have exited between the liveness check and the signal.
      }
    }

    if (isProcessAlive(pid)) {
      throw new Error(`Toolbox MCP child ${pid} did not exit during shutdown`);
    }

    this.pid = null;
    this.client = null;
    this.transport = null;
    this.resolveClosed();
    this.logger.info(JSON.stringify({ event: "mcp_stopped", runtime: this.config.mcp.runtime, pid }));
  }
}

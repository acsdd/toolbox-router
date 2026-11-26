import { spawn } from "node:child_process";
import { createWriteStream, existsSync as fsExistsSync } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, join, resolve, win32 } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { parseConfig } from "../src/config.mjs";

const SERVER_PATH = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const DEFAULT_TOOLBOX_SOURCE = "D:/Projects/Toolbox/toolbox-mcp";
const DEFAULT_PORTABLE_EXE = "D:/Projects/Toolbox/toolbox-mcp/dist/ModelFarm-Portable-0.9.25.exe";
const DEFAULT_PORTABLE_TEMP = "D:/Projects/toolbox/toolbox-router/portable-temp";

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/\/+$/, "");
}

export function findIPv4Address(address, interfaces = networkInterfaces()) {
  for (const [name, addresses] of Object.entries(interfaces)) {
    const entry = (addresses ?? []).find(
      (candidate) =>
        candidate &&
        candidate.family === "IPv4" &&
        candidate.internal === false &&
        candidate.address === address,
    );
    if (entry) return { ...entry, name };
  }

  return undefined;
}

export function assertPortAvailable(host, port) {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(port, host, () => {
      probe.close((error) => (error ? reject(error) : resolve()));
    });
  });
}

export function resolveSourceRuntime(sourceRoot = DEFAULT_TOOLBOX_SOURCE, { existsSync = fsExistsSync } = {}) {
  const root = normalizePath(sourceRoot);
  const entry = normalizePath(join(root, "dist", "index.js"));
  if (!existsSync(entry)) throw new Error(`Toolbox source MCP entry not found: ${entry}`);
  return { runtime: "source", command: process.execPath, args: [entry], cwd: root };
}

export function resolveInstalledRuntime(config, { env = process.env, existsSync = fsExistsSync } = {}) {
  const explicitCommand = config.mcp.command && normalizePath(config.mcp.command) !== normalizePath(process.execPath);
  const configuredDir = env.TOOLBOX_ROUTER_MCP_INSTALL_DIR?.trim() || (explicitCommand ? dirname(config.mcp.command) : "");
  const candidates = configuredDir
    ? [configuredDir]
    : [
        env.LOCALAPPDATA ? normalizePath(join(env.LOCALAPPDATA, "Programs", "Model Farm")) : "",
        env.ProgramFiles ? normalizePath(join(env.ProgramFiles, "Model Farm")) : "",
        "D:/Programs/Model Farm",
      ].filter(Boolean);

  for (const candidate of candidates) {
    const installDir = normalizePath(candidate);
    const command = normalizePath(explicitCommand ? config.mcp.command : join(installDir, "Model Farm.exe"));
    const asar = normalizePath(join(installDir, "resources", "app.asar"));
    if (!existsSync(command) || !existsSync(asar)) continue;
    return {
      runtime: "installed",
      command,
      args: config.mcp.args.length ? config.mcp.args : [normalizePath(join(asar, "dist", "index.js"))],
      cwd: normalizePath(config.mcp.cwd || installDir),
    };
  }

  throw new Error("Installed Model Farm runtime not found; set TOOLBOX_ROUTER_MCP_INSTALL_DIR or TOOLBOX_ROUTER_MCP_COMMAND");
}

export async function findPortableRuntime({
  tempRoot = DEFAULT_PORTABLE_TEMP,
  baseline = new Set(),
  readdirImpl = readdir,
  existsSync = fsExistsSync,
} = {}) {
  const root = normalizePath(tempRoot);
  let entries;
  try {
    entries = await readdirImpl(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || baseline.has(entry.name)) continue;
    const extractDir = normalizePath(join(root, entry.name));
    const command = normalizePath(join(extractDir, "Model Farm.exe"));
    const asar = normalizePath(join(extractDir, "resources", "app.asar"));
    if (existsSync(command) && existsSync(asar)) {
      return {
        runtime: "portable",
        command,
        args: [normalizePath(join(asar, "dist", "index.js"))],
        cwd: extractDir,
        extractDir,
      };
    }
  }

  return undefined;
}

export function stopLaunchedProcess(child, timeoutMs = 2_000) {
  if (!child || child.exitCode != null || child.signalCode != null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("exit", finish);
      child.removeListener("error", finish);
      resolve();
    };
    const timer = setTimeout(() => {
      if (child.exitCode != null || child.signalCode != null) {
        finish();
        return;
      }
      try {
        child.kill("SIGKILL");
      } finally {
        setTimeout(finish, 250).unref();
      }
    }, timeoutMs);
    timer.unref();
    child.once("exit", finish);
    child.once("error", finish);

    try {
      child.kill();
    } catch {
      finish();
    }
  });
}

export async function stopRouterProcess(child, gracefulTimeoutMs = 2_000) {
  if (!child || child.exitCode != null || child.signalCode != null) return;

  let onExit;
  const exited = new Promise((resolve) => {
    onExit = resolve;
    child.once("exit", onExit);
  });
  let sendError;
  try {
    if (child.connected && typeof child.send === "function") {
      child.send({ type: "shutdown" }, (error) => {
        sendError = error;
      });
    } else {
      sendError = new Error("Router IPC channel is not connected");
    }
  } catch (error) {
    sendError = error;
  }

  if (!sendError) {
    let timer;
    const timeout = new Promise((resolve) => {
      timer = setTimeout(resolve, gracefulTimeoutMs);
    });
    await Promise.race([exited, timeout]);
    clearTimeout(timer);
  }
  if (child.exitCode == null && child.signalCode == null) {
    await stopLaunchedProcess(child, 1_000);
  }
  child.removeListener("exit", onExit);
}

export async function prepareMcpRuntime(
  config,
  {
    env = process.env,
    tempRoot = normalizePath(join(config.dataDir, "portable-temp")),
    sourceRoot = env.TOOLBOX_ROUTER_MCP_SOURCE_ROOT?.trim() || DEFAULT_TOOLBOX_SOURCE,
    portableExe = DEFAULT_PORTABLE_EXE,
    spawnImpl = spawn,
    readdirImpl = readdir,
    findPortableRuntimeImpl = findPortableRuntime,
    existsSync = fsExistsSync,
  } = {},
) {
  if (config.mcp.runtime === "source") {
    return resolveSourceRuntime(sourceRoot, { existsSync });
  }
  if (config.mcp.runtime === "installed") {
    return resolveInstalledRuntime(config, { env, existsSync });
  }
  if (config.mcp.runtime !== "portable") {
    throw new Error(`Unsupported MCP runtime: ${config.mcp.runtime}`);
  }
  if (!existsSync(normalizePath(portableExe))) {
    throw new Error(`Portable Model Farm artifact not found: ${normalizePath(portableExe)}`);
  }

  const extractionTempRoot = normalizePath(tempRoot);
  await mkdir(extractionTempRoot, { recursive: true });
  let entries;
  try {
    entries = await readdirImpl(extractionTempRoot, { withFileTypes: true });
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    entries = [];
  }
  const baseline = new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name));
  const portableDir = normalizePath(join(config.dataDir, "portable-home"));
  await mkdir(portableDir, { recursive: true });

  const guiEnv = {
    ...env,
    PORTABLE_EXECUTABLE_DIR: portableDir,
    TEMP: extractionTempRoot,
    TMP: extractionTempRoot,
    TOOLBOX_MCP_HOME: config.mcpHome,
    TOOLBOX_MCP_PORT: "0",
  };
  delete guiEnv.ELECTRON_RUN_AS_NODE;
  const gui = spawnImpl(normalizePath(portableExe), [], {
    cwd: portableDir,
    env: guiEnv,
    stdio: "inherit",
    windowsHide: false,
  });
  let spawnError;
  gui.once("error", (error) => {
    spawnError = error;
  });

  const deadline = Date.now() + config.mcp.startupTimeoutMs;
  try {
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError;
      if (gui.exitCode !== null || gui.signalCode !== null) {
        throw new Error(`Portable Model Farm exited before extraction completed (code ${gui.exitCode}, signal ${gui.signalCode})`);
      }
      const runtime = await findPortableRuntimeImpl({ tempRoot: extractionTempRoot, baseline });
      if (runtime) return { ...runtime, gui };
      await delay(100);
    }
    throw new Error(`Portable Model Farm did not expose an extracted MCP runtime within ${config.mcp.startupTimeoutMs}ms`);
  } catch (error) {
    await stopLaunchedProcess(gui, 1_000);
    throw error;
  }
}

export function resolveLogPath(config) {
  return normalizePath(win32.isAbsolute(config.logFile) ? config.logFile : resolve(config.dataDir, config.logFile));
}

export function buildChildEnv(config, env = process.env) {
  return {
    ...env,
    TOOLBOX_ROUTER_HOST: config.host,
    TOOLBOX_ROUTER_PORT: String(config.port),
    TOOLBOX_ROUTER_API_KEY: config.apiKey,
    TOOLBOX_ROUTER_MODE: config.mode,
    TOOLBOX_ROUTER_DATA_DIR: config.dataDir,
    TOOLBOX_ROUTER_MODEL_ROOT: config.modelRoot,
    TOOLBOX_ROUTER_MCP_HOME: config.mcpHome,
    TOOLBOX_ROUTER_CAPACITY_DRIVE: config.capacityDrive,
    TOOLBOX_ROUTER_MIN_FREE_BYTES: String(config.minFreeBytes),
    TOOLBOX_ROUTER_LOG_FILE: resolveLogPath(config),
    TOOLBOX_ROUTER_MODELS: JSON.stringify(config.models),
    TOOLBOX_ROUTER_UPSTREAM_BASE_URL: config.upstream.baseUrl,
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: config.upstream.apiKey,
    TOOLBOX_ROUTER_UPSTREAM_MODEL: config.upstream.model,
    TOOLBOX_ROUTER_UPSTREAM_TIMEOUT_MS: String(config.upstream.timeoutMs),
    TOOLBOX_ROUTER_MCP_RUNTIME: config.mcp.runtime,
    TOOLBOX_ROUTER_MCP_COMMAND: config.mcp.command,
    TOOLBOX_ROUTER_MCP_ARGS: JSON.stringify(config.mcp.args),
    TOOLBOX_ROUTER_MCP_CWD: config.mcp.cwd,
    TOOLBOX_ROUTER_MCP_STARTUP_TIMEOUT_MS: String(config.mcp.startupTimeoutMs),
    TOOLBOX_ROUTER_MCP_CALL_TIMEOUT_MS: String(config.mcp.callTimeoutMs),
    TOOLBOX_ROUTER_MCP_MAX_RESULT_BYTES: String(config.mcp.maxResultBytes),
    TOOLBOX_ROUTER_MAX_MODEL_ROUNDS: String(config.limits.maxModelRounds),
    TOOLBOX_ROUTER_MAX_TOOL_CALLS_PER_ROUND: String(config.limits.maxToolCallsPerRound),
  };
}

async function assertResponse(response, label) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} failed with HTTP ${response.status}: ${text}`);
  }
}

export async function runSmokeChecks(baseUrl, apiKey, { mode = "mock", model = "toolbox-spike" } = {}) {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  const rootUrl = baseUrl.replace(/\/$/, "");
  const apiBaseUrl = `${rootUrl}/v1`;

  const healthResponse = await fetch(`${rootUrl}/health`);
  await assertResponse(healthResponse, "Health");
  const health = await healthResponse.json();
  if (health.ok !== true) throw new Error("Health check reported a degraded router");
  const mcpTools = mode === "bridge" ? health.mcp?.toolCount : undefined;
  if (mode === "bridge" && (health.mcp?.ready !== true || !Number.isInteger(mcpTools) || mcpTools < 1)) {
    throw new Error("Bridge health did not report a ready MCP tool surface");
  }

  const modelsResponse = await fetch(`${apiBaseUrl}/models`, { headers });
  await assertResponse(modelsResponse, "Model listing");
  const models = await modelsResponse.json();
  if (!models.data?.some((entry) => entry.id === model)) {
    throw new Error(`Model listing did not include ${model}`);
  }

  const chatResponse = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "launcher smoke test" }],
      stream: false,
    }),
  });
  await assertResponse(chatResponse, "Non-streaming chat");
  const chat = await chatResponse.json();
  if (chat.choices?.[0]?.message?.role !== "assistant") {
    throw new Error("Non-streaming chat did not return an assistant message");
  }

  const streamResponse = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: "launcher stream test" }],
      stream: true,
    }),
  });
  await assertResponse(streamResponse, "Streaming chat");
  if (!streamResponse.headers.get("content-type")?.includes("text/event-stream")) {
    throw new Error("Streaming chat did not return an event stream");
  }
  const streamText = await streamResponse.text();
  if (!streamText.includes('"role":"assistant"') || !streamText.includes("data: [DONE]")) {
    throw new Error("Streaming chat did not return a complete OpenAI event stream");
  }

  const isBridge = mode === "bridge";
  const toolName = isBridge ? "system_stats" : "probe_tool";
  const toolResponse = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "user",
          content: isBridge
            ? "Call system_stats once with an empty object, then summarize the result."
            : "launcher tool test",
        },
      ],
      tools: [
        {
          type: "function",
          function: {
            name: toolName,
            description: isBridge ? "Read current system statistics" : "Launcher tool-call probe",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      tool_choice: "required",
      stream: false,
    }),
  });
  await assertResponse(toolResponse, "Tool call");
  const toolResult = await toolResponse.json();
  const choice = toolResult.choices?.[0];
  const toolCall = choice?.message?.tool_calls?.[0];
  if (isBridge) {
    if (choice?.finish_reason !== "stop" || choice?.message?.role !== "assistant" || toolResult.toolbox?.rounds < 2) {
      throw new Error("Bridge tool smoke did not complete a router-owned MCP tool round trip");
    }
  } else if (choice?.finish_reason !== "tool_calls" || toolCall?.function?.name !== toolName) {
    throw new Error("Tool call did not return the expected function call");
  }

  return { models: true, chat: true, stream: true, toolCall: true, ...(isBridge ? { mcpTools } : {}) };
}

async function waitForHealth(baseUrl, child, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`Router exited before becoming ready (code ${child.exitCode}, signal ${child.signalCode})`);
    }

    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(1_000) });
      if (response.ok && (await response.json()).ok === true) return;
    } catch {
      // The listener may not be ready yet; retry until the deadline.
    }

    await delay(100);
  }

  throw new Error(`Router did not become healthy at ${baseUrl}/health within ${timeoutMs}ms`);
}

async function main() {
  const config = parseConfig();

  if (!config.logFile) {
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    config.logFile = `logs/spike-${timestamp}.jsonl`;
  }
  config.logFile = resolveLogPath(config);

  const local = ["127.0.0.1", "::1", "localhost"].includes(config.host.toLowerCase());
  const adapter = local ? null : findIPv4Address(config.host);
  if (!local && !adapter) throw new Error(`${config.host} is not assigned to an active IPv4 network adapter`);
  console.log(local ? `[launcher] Using local address ${config.host}` : `[launcher] Using ${adapter.name}: ${config.host}/${adapter.netmask}`);
  await assertPortAvailable(config.host, config.port);
  console.log(`[launcher] Port ${config.port} is available`);

  let runtime;
  let child;
  let logStream;
  let stopping = false;
  let stopPromise;
  const onSignal = () => void cleanup();

  const cleanup = async () => {
    if (stopPromise) return stopPromise;
    stopping = true;
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    stopPromise = (async () => {
      if (child) await stopRouterProcess(child, 5_000);
      if (runtime?.gui) await stopLaunchedProcess(runtime.gui);
      if (runtime?.extractDir) {
        await rm(runtime.extractDir, { recursive: true, force: true }).catch((error) => {
          console.error(`[launcher] Could not remove portable extraction directory: ${error.message}`);
          process.exitCode = 1;
        });
      }
      if (logStream) {
        await new Promise((resolve) => logStream.end(resolve));
      }
    })();
    return stopPromise;
  };

  try {
    if (config.mode === "bridge") {
      runtime = await prepareMcpRuntime(config);
      config.mcp.command = runtime.command;
      config.mcp.args = runtime.args;
      config.mcp.cwd = runtime.cwd;
      console.log(`[launcher] MCP runtime: ${runtime.runtime}`);
    }

    await mkdir(dirname(resolve(config.logFile)), { recursive: true });
    logStream = createWriteStream(resolve(config.logFile), { flags: "a" });
    logStream.on("error", (error) => {
      console.error(`[launcher] Could not write router log: ${error.message}`);
      process.exitCode = 1;
    });

    child = spawn(process.execPath, [SERVER_PATH], {
      env: buildChildEnv(config),
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      windowsHide: false,
    });
    child.stdout.on("data", (chunk) => {
      process.stdout.write(chunk);
      logStream.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      process.stderr.write(chunk);
      logStream.write(chunk);
    });
    child.on("error", (error) => {
      console.error(`[launcher] Could not start router: ${error.message}`);
      process.exitCode = 1;
    });
    child.on("exit", (code, signal) => {
      if (!stopping && (code !== 0 || signal)) {
        console.error(`[launcher] Router stopped unexpectedly (code ${code}, signal ${signal})`);
        process.exitCode = 1;
      }
      void cleanup();
    });
    if (runtime?.gui) {
      runtime.gui.once("exit", (code, signal) => {
        if (!stopping) {
          console.error(`[launcher] Portable Model Farm stopped unexpectedly (code ${code}, signal ${signal})`);
          process.exitCode = 1;
          void cleanup();
        }
      });
    }
    process.on("SIGINT", onSignal);
    process.on("SIGTERM", onSignal);

    const rootUrl = `http://${config.host}:${config.port}`;
    const apiBaseUrl = `${rootUrl}/v1`;
    await waitForHealth(rootUrl, child, config.mode === "bridge" ? config.mcp.startupTimeoutMs + 10_000 : 10_000);
    console.log("[launcher] Health check passed");

    const model = config.models[0].id;
    if (process.argv.includes("--smoke") || process.argv.includes("--smoke-only")) {
      const smoke = await runSmokeChecks(rootUrl, config.apiKey, { mode: config.mode, model });
      console.log(`[launcher] Smoke checks passed: ${JSON.stringify(smoke)}`);
    }
    console.log("");
    console.log("Add this custom model in Qoder:");
    console.log("  Provider:  OpenAI Compatible (Chat Completions)");
    console.log(`  Base URL:  ${apiBaseUrl}`);
    console.log("  API key:   Use your configured Router key (never the AstrLink key)");
    console.log(`  Model ID:  ${model}`);
    console.log(`  Log file:  ${config.logFile}`);
    console.log("");

    if (process.argv.includes("--smoke-only")) {
      console.log("[launcher] --smoke-only requested; stopping router, MCP, and portable runtime");
      await cleanup();
    } else {
      console.log("[launcher] Router is ready. Press Ctrl+C to stop.");
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(`[launcher] ${error.message}`);
    process.exitCode = 1;
  });
}

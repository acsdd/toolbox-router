import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { createServer } from "node:net";
import { networkInterfaces } from "node:os";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { parseConfig } from "../src/config.mjs";

const SERVER_PATH = fileURLToPath(new URL("../src/server.mjs", import.meta.url));

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

export function buildChildEnv(config, env = process.env) {
  return {
    ...env,
    TOOLBOX_ROUTER_HOST: config.host,
    TOOLBOX_ROUTER_PORT: String(config.port),
    TOOLBOX_ROUTER_API_KEY: config.apiKey,
    TOOLBOX_ROUTER_MODE: config.mode,
    TOOLBOX_ROUTER_LOG_FILE: config.logFile,
  };
}

async function assertResponse(response, label) {
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${label} failed with HTTP ${response.status}: ${text}`);
  }
}

export async function runSmokeChecks(baseUrl, apiKey) {
  const headers = {
    authorization: `Bearer ${apiKey}`,
    "content-type": "application/json",
  };
  const apiBaseUrl = `${baseUrl.replace(/\/$/, "")}/v1`;

  const modelsResponse = await fetch(`${apiBaseUrl}/models`, { headers });
  await assertResponse(modelsResponse, "Model listing");
  const models = await modelsResponse.json();
  if (models.data?.[0]?.id !== "toolbox-spike") {
    throw new Error("Model listing did not include toolbox-spike");
  }

  const chatResponse = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "toolbox-spike",
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
      model: "toolbox-spike",
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

  const toolResponse = await fetch(`${apiBaseUrl}/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: "toolbox-spike",
      messages: [{ role: "user", content: "launcher tool test" }],
      tools: [
        {
          type: "function",
          function: {
            name: "probe_tool",
            description: "Launcher tool-call probe",
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
  const toolCall = toolResult.choices?.[0]?.message?.tool_calls?.[0];
  if (toolResult.choices?.[0]?.finish_reason !== "tool_calls" || toolCall?.function?.name !== "probe_tool") {
    throw new Error("Tool call did not return the expected function call");
  }

  return { models: true, chat: true, stream: true, toolCall: true };
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

  if (["127.0.0.1", "::1", "localhost"].includes(config.host.toLowerCase())) {
    throw new Error("Use the assigned LAN address (192.168.100.66), not a loopback address");
  }

  if (!config.logFile) {
    const timestamp = new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
    config.logFile = `logs/spike-${timestamp}.jsonl`;
  }

  const adapter = findIPv4Address(config.host);
  if (!adapter) {
    throw new Error(`${config.host} is not assigned to an active IPv4 network adapter`);
  }

  console.log(`[launcher] Using ${adapter.name}: ${config.host}/${adapter.netmask}`);
  await assertPortAvailable(config.host, config.port);
  console.log(`[launcher] Port ${config.port} is available`);

  await mkdir(dirname(resolve(config.logFile)), { recursive: true });
  const logStream = createWriteStream(resolve(config.logFile), { flags: "a" });
  const child = spawn(process.execPath, [SERVER_PATH], {
    env: buildChildEnv(config),
    stdio: ["ignore", "pipe", "pipe"],
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

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    child.kill();
  };

  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  child.on("error", (error) => {
    logStream.end();
    console.error(`[launcher] Could not start router: ${error.message}`);
    process.exitCode = 1;
  });

  child.on("exit", (code, signal) => {
    logStream.end(() => {
      if (!stopping && (code !== 0 || signal)) {
        console.error(`[launcher] Router stopped unexpectedly (code ${code}, signal ${signal})`);
      }
      process.exit(stopping ? 0 : (code ?? 1));
    });
  });

  const rootUrl = `http://${config.host}:${config.port}`;
  const apiBaseUrl = `${rootUrl}/v1`;
  await waitForHealth(rootUrl, child);
  console.log("[launcher] Health check passed");

  const smoke = await runSmokeChecks(rootUrl, config.apiKey);
  console.log(`[launcher] Smoke checks passed: ${JSON.stringify(smoke)}`);
  console.log("");
  console.log("Add this custom model in Qoder:");
  console.log(`  Provider:  OpenAI Compatible (Chat Completions)`);
  console.log(`  Base URL:  ${apiBaseUrl}`);
  console.log(`  API key:   ${config.apiKey}`);
  console.log(`  Model ID:  toolbox-spike`);
  console.log(`  Log file:  ${config.logFile}`);
  console.log("");

  if (process.argv.includes("--smoke-only")) {
    console.log("[launcher] --smoke-only requested; stopping router");
    stop();
  } else {
    console.log("[launcher] Router is ready. Press Ctrl+C to stop.");
  }
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main().catch((error) => {
    console.error(`[launcher] ${error.message}`);
    process.exitCode = 1;
  });
}

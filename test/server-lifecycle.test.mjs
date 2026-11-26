import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SERVER = fileURLToPath(new URL("../src/server.mjs", import.meta.url));
const FAKE_MCP = fileURLToPath(new URL("./fixtures/fake-mcp-server.mjs", import.meta.url));
const STALLED_MCP = fileURLToPath(new URL("./fixtures/stalled-mcp-server.mjs", import.meta.url));
const TEST_ROOT = "D:/Projects/toolbox/toolbox-router/test-lifecycle";

async function reservePort() {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

test("a launcher shutdown message drains the router MCP child", async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  const home = await mkdtemp(join(TEST_ROOT, "home-"));
  const port = await reservePort();
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      TOOLBOX_ROUTER_HOST: "127.0.0.1",
      TOOLBOX_ROUTER_PORT: String(port),
      TOOLBOX_ROUTER_API_KEY: "lifecycle-test-key",
      TOOLBOX_ROUTER_MODE: "bridge",
      TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
      TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
      TOOLBOX_ROUTER_UPSTREAM_MODEL: "test-model",
      TOOLBOX_ROUTER_MCP_RUNTIME: "source",
      TOOLBOX_ROUTER_MCP_COMMAND: process.execPath,
      TOOLBOX_ROUTER_MCP_ARGS: JSON.stringify([FAKE_MCP]),
      TOOLBOX_ROUTER_MCP_HOME: home,
      TOOLBOX_ROUTER_DATA_DIR: join(TEST_ROOT, "data"),
      TOOLBOX_ROUTER_LOG_FILE: join(TEST_ROOT, "router.jsonl"),
      TOOLBOX_ROUTER_MODELS: JSON.stringify([{ id: "lifecycle-test", upstreamModel: "test-model", requiredBytes: 0 }]),
    },
  });
  let stderr = "";
  let stdout = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });

  try {
    const deadline = Date.now() + 8_000;
    let health;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Router exited during startup: ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {
        // The listener may not be ready yet.
      }
      await delay(50);
    }
    assert.equal(health?.mcp?.ready, true, stderr);
    const mcpPid = health.mcp.pid;
    assert.equal(typeof mcpPid, "number");

    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await new Promise((resolve, reject) => {
      child.send({ type: "shutdown" }, (error) => (error ? reject(error) : resolve()));
    });
    const cleanupDeadline = Date.now() + 3_000;
    while (Date.now() < cleanupDeadline) {
      try {
        process.kill(mcpPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") break;
        throw error;
      }
      await delay(50);
    }
    assert.match(stdout, /"event":"mcp_shutdown_complete"/);
    assert.match(stdout, /"event":"shutdown_complete"/);
    assert.throws(() => process.kill(mcpPid, 0), (error) => error.code === "ESRCH", stderr);
    const exit = await Promise.race([exitPromise, delay(2_000).then(() => null)]);
    assert.notEqual(exit, null, `${stdout}${stderr}`);
    assert.equal(exit.code, 0, stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    await rm(home, { recursive: true, force: true });
  }
});

test("shutdown aborts an active upstream chat request", async () => {
  let notifyUpstreamRequest;
  const upstreamRequestReceived = new Promise((resolve) => {
    notifyUpstreamRequest = resolve;
  });
  let upstreamAborted = false;
  const upstreamServer = createHttpServer(async (request, response) => {
    request.resume();
    response.on("close", () => {
      if (!response.writableEnded) upstreamAborted = true;
    });
    notifyUpstreamRequest();
    // Hold the response open until router shutdown aborts the fetch.
  });
  await new Promise((resolve) => upstreamServer.listen(0, "127.0.0.1", resolve));
  const upstreamPort = upstreamServer.address().port;

  await mkdir(TEST_ROOT, { recursive: true });
  const home = await mkdtemp(join(TEST_ROOT, "home-"));
  const port = await reservePort();
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      TOOLBOX_ROUTER_HOST: "127.0.0.1",
      TOOLBOX_ROUTER_PORT: String(port),
      TOOLBOX_ROUTER_API_KEY: "lifecycle-test-key",
      TOOLBOX_ROUTER_MODE: "bridge",
      TOOLBOX_ROUTER_UPSTREAM_BASE_URL: `http://127.0.0.1:${upstreamPort}/v1`,
      TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
      TOOLBOX_ROUTER_UPSTREAM_MODEL: "test-model",
      TOOLBOX_ROUTER_UPSTREAM_TIMEOUT_MS: "10000",
      TOOLBOX_ROUTER_MCP_RUNTIME: "source",
      TOOLBOX_ROUTER_MCP_COMMAND: process.execPath,
      TOOLBOX_ROUTER_MCP_ARGS: JSON.stringify([FAKE_MCP]),
      TOOLBOX_ROUTER_MCP_HOME: home,
      TOOLBOX_ROUTER_DATA_DIR: join(TEST_ROOT, "data"),
      TOOLBOX_ROUTER_LOG_FILE: join(TEST_ROOT, "router.jsonl"),
      TOOLBOX_ROUTER_MODELS: JSON.stringify([{ id: "lifecycle-test", upstreamModel: "test-model", requiredBytes: 0 }]),
    },
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    const deadline = Date.now() + 8_000;
    let ready = false;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(`Router exited during startup: ${stderr}`);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/health`);
        if (response.ok && (await response.json()).ok === true) {
          ready = true;
          break;
        }
      } catch {
        // The listener may not be ready yet.
      }
      await delay(50);
    }
    assert.equal(ready, true, stderr);

    const chatResponse = fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        authorization: "Bearer lifecycle-test-key",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "lifecycle-test",
        messages: [{ role: "user", content: "hold the upstream request open" }],
      }),
    });
    void chatResponse.catch(() => {});
    await Promise.race([
      upstreamRequestReceived,
      delay(3_000).then(() => {
        throw new Error(`Upstream did not receive the chat request: ${stderr}`);
      }),
    ]);

    const exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    await new Promise((resolve, reject) => {
      child.send({ type: "shutdown" }, (error) => (error ? reject(error) : resolve()));
    });
    const exit = await Promise.race([exitPromise, delay(3_000).then(() => null)]);
    assert.notEqual(exit, null, `Router did not cancel active upstream work: ${stderr}`);
    assert.equal(exit.code, 0, stderr);
    assert.equal(upstreamAborted, true, "Router shutdown did not abort the upstream HTTP request");
    await chatResponse.catch(() => null);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    upstreamServer.closeAllConnections();
    await new Promise((resolve) => upstreamServer.close(resolve));
    await rm(home, { recursive: true, force: true });
  }
});

test("shutdown during MCP startup still closes the child process", async () => {
  await mkdir(TEST_ROOT, { recursive: true });
  const home = await mkdtemp(join(TEST_ROOT, "home-"));
  const port = await reservePort();
  const child = spawn(process.execPath, [SERVER], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      TOOLBOX_ROUTER_HOST: "127.0.0.1",
      TOOLBOX_ROUTER_PORT: String(port),
      TOOLBOX_ROUTER_API_KEY: "lifecycle-test-key",
      TOOLBOX_ROUTER_MODE: "bridge",
      TOOLBOX_ROUTER_UPSTREAM_BASE_URL: "http://localhost:7770/v1",
      TOOLBOX_ROUTER_UPSTREAM_API_KEY: "upstream-test-key",
      TOOLBOX_ROUTER_UPSTREAM_MODEL: "test-model",
      TOOLBOX_ROUTER_MCP_RUNTIME: "source",
      TOOLBOX_ROUTER_MCP_COMMAND: process.execPath,
      TOOLBOX_ROUTER_MCP_ARGS: JSON.stringify([STALLED_MCP]),
      TOOLBOX_ROUTER_MCP_HOME: home,
      TOOLBOX_ROUTER_MCP_STARTUP_TIMEOUT_MS: "10000",
      TOOLBOX_ROUTER_DATA_DIR: join(TEST_ROOT, "data"),
      TOOLBOX_ROUTER_LOG_FILE: join(TEST_ROOT, "router.jsonl"),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  let mcpPid;
  try {
    const startupDeadline = Date.now() + 3_000;
    while (Date.now() < startupDeadline && !mcpPid) {
      try {
        mcpPid = Number(await readFile(join(home, "stalled.pid"), "utf8"));
      } catch {
        await delay(25);
      }
    }
    assert.equal(typeof mcpPid, "number", stderr);

    await new Promise((resolve, reject) => {
      child.send({ type: "shutdown" }, (error) => (error ? reject(error) : resolve()));
    });
    const cleanupDeadline = Date.now() + 5_000;
    while (Date.now() < cleanupDeadline) {
      try {
        process.kill(mcpPid, 0);
      } catch (error) {
        if (error.code === "ESRCH") break;
        throw error;
      }
      await delay(50);
    }
    assert.match(stdout, /"event":"shutdown_complete"/);
    assert.throws(() => process.kill(mcpPid, 0), (error) => error.code === "ESRCH", stderr);
  } finally {
    if (child.exitCode === null) {
      child.kill();
      await new Promise((resolve) => child.once("exit", resolve));
    }
    if (mcpPid) {
      try {
        process.kill(mcpPid, "SIGKILL");
      } catch {
        // The bridge already stopped it.
      }
    }
    await rm(home, { recursive: true, force: true });
  }
});

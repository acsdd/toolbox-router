// Start the bundled Node and MCP with synthetic credentials and an isolated home.
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:net'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { resolveUpstreamCredential } from '../src/upstream-credential.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bundleIndex = process.argv.indexOf('--bundle')
if (bundleIndex >= 0 && !process.argv[bundleIndex + 1]) throw new Error('--bundle needs a directory path.')
const bundle = bundleIndex >= 0 ? resolve(process.argv[bundleIndex + 1]) : join(root, 'dist', 'portable-preview')
const parent = join(root, 'test-mcp')
const routerKey = 'portable-synthetic-check-key-2026'
const live = process.argv.includes('--live')
const upstreamKey = live ? resolveUpstreamCredential(process.env).apiKey : 'synthetic-only'
if (!upstreamKey) throw new Error('The live check needs a configured AstrLink provider credential.')

function safeDiagnostics(text) {
  return text
    .replaceAll(routerKey, '[redacted]')
    .replaceAll(upstreamKey, '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .slice(-4000)
}

function startSyntheticUpstream(exe, script) {
  return new Promise((resolveReady, rejectReady) => {
    const fixture = spawn(exe, [script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    let settled = false
    const finish = (error, port) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fixture.stdout.off('data', onStdout)
      fixture.stderr.off('data', onStderr)
      fixture.off('error', onError)
      fixture.off('exit', onExit)
      if (error) {
        if (fixture.exitCode === null && fixture.pid) fixture.kill()
        rejectReady(new Error(`${error.message} ${safeDiagnostics(stderr)}`.trim()))
      } else {
        resolveReady({ fixture, port })
      }
    }
    const onStdout = (chunk) => {
      stdout = (stdout + chunk.toString()).slice(-16384)
      const match = stdout.match(/^SYNTHETIC_UPSTREAM_READY (\d+)\s*$/m)
      if (match) finish(null, Number(match[1]))
    }
    const onStderr = (chunk) => { stderr = (stderr + chunk.toString()).slice(-4000) }
    const onError = (error) => finish(error)
    const onExit = (code, signal) => finish(new Error(`Synthetic upstream exited before readiness (${code ?? signal}).`))
    const timer = setTimeout(() => finish(new Error('Synthetic upstream did not become ready.')), 5000)
    fixture.stdout.on('data', onStdout)
    fixture.stderr.on('data', onStderr)
    fixture.once('error', onError)
    fixture.once('exit', onExit)
  })
}

function completionPayload(stream) {
  return {
    model: 'toolbox-spike',
    messages: [{ role: 'user', content: 'Call system_stats and summarize the result.' }],
    tool_choice: { type: 'function', function: { name: 'system_stats' } },
    max_tokens: 120,
    stream,
  }
}

function parseEventStream(text) {
  let content = ''
  let finished = false
  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data: ')) continue
    const data = line.slice(6)
    if (data === '[DONE]') continue
    let event
    try {
      event = JSON.parse(data)
    } catch {
      throw new Error('Portable Router returned malformed SSE JSON.')
    }
    const choice = event.choices?.[0]
    if (typeof choice?.delta?.content === 'string') content += choice.delta.content
    if (choice?.finish_reason === 'stop') finished = true
  }
  return { content, finished }
}

const listener = createServer()
await new Promise((ok, fail) => { listener.once('error', fail); listener.listen(0, '127.0.0.1', ok) })
const port = listener.address().port
await new Promise((ok) => listener.close(ok))
await mkdir(parent, { recursive: true })
const home = await mkdtemp(join(parent, 'portable-check-'))
const exe = join(bundle, 'node.exe')
const mcp = join(bundle, 'mcp')
const headers = { authorization: `Bearer ${routerKey}`, 'content-type': 'application/json' }
let fixture = null
let child = null
let diagnostics = ''
try {
  let synthetic
  if (!live) {
    synthetic = await startSyntheticUpstream(exe, join(bundle, 'router', 'scripts', 'fixtures', 'synthetic-upstream.mjs'))
    fixture = synthetic.fixture
  }

  const env = {
    ...process.env,
    TOOLBOX_ROUTER_HOST: '127.0.0.1',
    TOOLBOX_ROUTER_PORT: String(port),
    TOOLBOX_ROUTER_MODE: 'bridge',
    TOOLBOX_ROUTER_API_KEY: routerKey,
    TOOLBOX_ROUTER_UPSTREAM_API_KEY: upstreamKey,
    TOOLBOX_ROUTER_MCP_COMMAND: exe,
    TOOLBOX_ROUTER_MCP_ARGS: JSON.stringify([join(mcp, 'dist', 'index.js')]),
    TOOLBOX_ROUTER_MCP_CWD: mcp,
    TOOLBOX_ROUTER_MCP_HOME: home,
    TOOLBOX_ROUTER_MCP_CONTRACT_PATH: join(mcp, 'dist', 'tool-contract.json'),
  }
  if (!live) {
    Object.assign(env, {
      TOOLBOX_ROUTER_UPSTREAM_BASE_URL: `http://127.0.0.1:${synthetic.port}/v1`,
      TOOLBOX_ROUTER_UPSTREAM_MODEL: 'synthetic-tool-model',
      TOOLBOX_ROUTER_MODELS: JSON.stringify([{ id: 'toolbox-spike', upstreamModel: 'synthetic-tool-model', requiredBytes: 0 }]),
      TOOLBOX_ROUTER_MIN_FREE_BYTES: '0',
    })
  }

  let childError = null
  child = spawn(exe, [join(bundle, 'router', 'src', 'server.mjs')], {
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    env,
  })
  child.once('error', (error) => { childError = error })
  child.stderr.on('data', (chunk) => { diagnostics = (diagnostics + chunk.toString()).slice(-4000) })

  let ready = false
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    if (childError) throw childError
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('Bundled Router exited before readiness.')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        headers,
        signal: AbortSignal.timeout(500),
      })
      if (response.ok) {
        const health = await response.json()
        if (health.mode === 'bridge' && health.mcp?.ready === true && health.mcp?.contract?.status === 'aligned') {
          ready = true
          break
        }
      }
    } catch {}
    await delay(100)
  }
  if (!ready) throw new Error(`Bundled Router did not become ready with an aligned MCP contract. ${safeDiagnostics(diagnostics)}`)

  const modelsResponse = await fetch(`http://127.0.0.1:${port}/v1/models`, {
    headers,
    signal: AbortSignal.timeout(5000),
  })
  if (!modelsResponse.ok) throw new Error('Bundled Router model endpoint failed.')

  if (live) {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        ...completionPayload(false),
        messages: [{ role: 'user', content: 'Call crypto_status with an empty object and briefly summarize the result.' }],
        tool_choice: { type: 'function', function: { name: 'crypto_status' } },
      }),
      signal: AbortSignal.timeout(120000),
    })
    const body = await response.json()
    if (!response.ok || !(body?.toolbox?.rounds >= 2)) throw new Error(`Portable live tool check failed (HTTP ${response.status}).`)
    console.log('Portable Router → AstrLink → bundled MCP live tool check passed.')
  } else {
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(completionPayload(false)),
      signal: AbortSignal.timeout(120000),
    })
    const body = await response.json()
    if (!response.ok || body?.choices?.[0]?.finish_reason !== 'stop' ||
        body?.choices?.[0]?.message?.content !== 'Synthetic tool round trip completed.' ||
        !(body?.toolbox?.rounds >= 2)) {
      throw new Error(`Portable synthetic non-streaming tool check failed (HTTP ${response.status}).`)
    }

    const streamResponse = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(completionPayload(true)),
      signal: AbortSignal.timeout(120000),
    })
    const streamText = await streamResponse.text()
    const streamed = parseEventStream(streamText)
    if (!streamResponse.ok || !streamResponse.headers.get('content-type')?.startsWith('text/event-stream') ||
        !streamText.includes('data: [DONE]') || !streamed.finished ||
        streamed.content !== 'Synthetic tool round trip completed.') {
      throw new Error(`Portable synthetic streaming tool check failed (HTTP ${streamResponse.status}).`)
    }
    console.log('Portable Router → synthetic upstream → bundled MCP full-loop checks passed (JSON and SSE).')
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.send({ type: 'shutdown' }) } catch { child.kill() }
    await Promise.race([once(child, 'exit'), delay(5000)])
    if (child.exitCode === null && child.signalCode === null) child.kill()
  }
  if (fixture && fixture.exitCode === null && fixture.signalCode === null) {
    fixture.kill()
    await Promise.race([once(fixture, 'exit'), delay(1000)])
  }
  await rm(home, { recursive: true, force: true })
}

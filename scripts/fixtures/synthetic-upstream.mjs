import { createServer } from 'node:http'

const model = 'synthetic-tool-model'
const maxBodyBytes = 1024 * 1024
let round = 0

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json' })
  response.end(JSON.stringify(body))
}

const server = createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/chat/completions') {
    response.writeHead(404).end()
    return
  }

  const chunks = []
  let size = 0
  try {
    for await (const chunk of request) {
      size += chunk.length
      if (size > maxBodyBytes) {
        sendJson(response, 413, { error: { message: 'synthetic request too large' } })
        return
      }
      chunks.push(chunk)
    }
  } catch {
    sendJson(response, 400, { error: { message: 'invalid synthetic request' } })
    return
  }

  let body
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    sendJson(response, 400, { error: { message: 'invalid synthetic JSON' } })
    return
  }

  if (body.stream !== false || body.model !== model || !Array.isArray(body.messages)) {
    sendJson(response, 400, { error: { message: 'unexpected synthetic request' } })
    return
  }

  round += 1
  const toolResult = body.messages.findLast((message) => message?.role === 'tool')
  let message
  let finishReason
  if (!toolResult) {
    message = {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: `call_synthetic_${round}`,
        type: 'function',
        function: { name: 'system_stats', arguments: '{}' },
      }],
    }
    finishReason = 'tool_calls'
  } else {
    let stats
    try {
      stats = JSON.parse(toolResult.content)
    } catch {
      sendJson(response, 502, { error: { message: 'real MCP stats were not valid JSON' } })
      return
    }
    if (typeof stats.cpuPercent !== 'number' || !Number.isFinite(stats.cpuPercent)) {
      sendJson(response, 502, { error: { message: 'real MCP stats were not returned' } })
      return
    }
    message = { role: 'assistant', content: 'Synthetic tool round trip completed.' }
    finishReason = 'stop'
  }

  sendJson(response, 200, {
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
  })
})

server.listen(0, '127.0.0.1', () => {
  console.log(`SYNTHETIC_UPSTREAM_READY ${server.address().port}`)
})

function shutdown() {
  server.close(() => process.exit(0))
  server.closeAllConnections()
}

process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

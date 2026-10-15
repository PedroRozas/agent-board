import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HOST = '127.0.0.1'
const PORT = Number(process.argv[2] ?? process.env.AGENT_BOARD_PORT ?? 4317)
const SESSIONS_DIR = join(homedir(), '.claude', 'agent-board', 'sessions')
const PAGE_PATH = join(dirname(fileURLToPath(import.meta.url)), 'index.html')
const HIDDEN_AFTER_MS = 10 * 60_000
const IDLE_SHUTDOWN_MS = 30 * 60_000
const IDLE_CHECK_MS = 60_000
const ALLOWED_HOSTS = new Set([`${HOST}:${PORT}`, `localhost:${PORT}`])

let lastRequestAt = Date.now()

const readSessionFile = async (name, now) => {
  const path = join(SESSIONS_DIR, name)

  try {
    const info = await stat(path)

    if (now - info.mtimeMs > HIDDEN_AFTER_MS) {
      return null
    }

    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error.code !== 'ENOENT') {
      console.error(`agent-board: se ignoró ${name}: ${error.message}`)
    }

    return null
  }
}

const listSessionFiles = async () => {
  try {
    return (await readdir(SESSIONS_DIR)).filter(name => name.endsWith('.json'))
  } catch (error) {
    if (error.code === 'ENOENT') {
      return []
    }

    throw error
  }
}

const readSessions = async () => {
  const now = Date.now()
  const sessions = await Promise.all((await listSessionFiles()).map(name => readSessionFile(name, now)))

  return { now, sessions: sessions.filter(session => session !== null) }
}

const sendJson = (response, status, body) => {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  response.end(JSON.stringify(body))
}

const handleRequest = async (request, response) => {
  if (!ALLOWED_HOSTS.has(request.headers.host ?? '')) {
    sendJson(response, 403, { error: 'forbidden host' })

    return
  }

  lastRequestAt = Date.now()
  const { pathname } = new URL(request.url ?? '/', `http://${HOST}:${PORT}`)

  if (request.method !== 'GET') {
    sendJson(response, 405, { error: 'method not allowed' })

    return
  }

  if (pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
    response.end(await readFile(PAGE_PATH, 'utf8'))

    return
  }

  if (pathname === '/api/sessions') {
    sendJson(response, 200, await readSessions())

    return
  }

  if (pathname === '/api/health') {
    sendJson(response, 200, { app: 'agent-board' })

    return
  }

  sendJson(response, 404, { error: 'not found' })
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch(error => {
    console.error(`agent-board: ${error.message}`)
    sendJson(response, 500, { error: error.message })
  })
})

server.on('error', error => {
  console.error(`agent-board: no se pudo iniciar en ${HOST}:${PORT}: ${error.message}`)
  process.exit(1)
})

server.listen(PORT, HOST, () => {
  console.log(`agent-board: http://${HOST}:${PORT}`)
})

setInterval(() => {
  if (Date.now() - lastRequestAt > IDLE_SHUTDOWN_MS) {
    server.close(() => process.exit(0))
  }
}, IDLE_CHECK_MS).unref()

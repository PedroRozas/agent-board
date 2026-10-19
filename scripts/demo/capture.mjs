import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { buildSessions, writeScenario } from './scenario.mjs'

const MODES = new Set(['stills', 'gif', 'check'])
const USAGE = 'Usage: PLAYWRIGHT_CORE=<playwright-core folder> node scripts/demo/capture.mjs stills|gif|check [out-dir]'
const PORT = 4399
const POLL_WAIT_MS = 2400
const PAD = 24
const GIF_HEIGHT = 980

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repo = resolve(scriptDir, '..', '..')
const [mode, outArgument = join(repo, 'docs')] = process.argv.slice(2)

if (!MODES.has(mode)) {
  console.error(USAGE)
  process.exit(1)
}

const loadChromium = async () => {
  const location = process.env.PLAYWRIGHT_CORE
  const specifier = location === undefined ? 'playwright-core' : pathToFileURL(join(resolve(location), 'index.mjs')).href

  try {
    return (await import(specifier)).chromium
  } catch (error) {
    throw new Error(`could not load playwright-core (${error.message}). ${USAGE}`)
  }
}

const runPython = (script, args) =>
  new Promise((resolvePython, rejectPython) => {
    const child = spawn('python3', [script, ...args], { stdio: 'inherit' })
    child.on('error', rejectPython)
    child.on('exit', code => (code === 0 ? resolvePython() : rejectPython(new Error(`${script} exited with ${code}`))))
  })

const outDir = resolve(outArgument)
const workDir = await mkdtemp(join(tmpdir(), 'agent-board-demo-'))
const demoHome = join(workDir, 'home')
const sessionsDir = join(demoHome, '.claude', 'agent-board', 'sessions')
const chromium = await loadChromium()

await writeScenario(sessionsDir, 200)
await mkdir(outDir, { recursive: true })

const server = spawn('node', [join(repo, 'dashboard', 'server.mjs'), String(PORT)], {
  env: { ...process.env, HOME: demoHome },
  stdio: 'inherit',
})
await sleep(800)

const browser = await chromium.launch()

const lowerClip = async (page, fixedHeight = null) => {
  const box = await page.locator('.lower').boundingBox()
  const scrollY = await page.evaluate(() => window.scrollY)

  return { x: box.x - PAD, y: box.y + scrollY - PAD, width: box.width + PAD * 2, height: fixedHeight ?? box.height + PAD * 2 }
}

const openPage = async (colorScheme, language = 'en', sessionId = 'demo-shop-api') => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1600 }, colorScheme })
  await page.goto(`http://127.0.0.1:${PORT}/?lang=${language}#${sessionId}`)
  await page.waitForSelector('[data-agent="agent-e2e"]')

  return page
}

const advance = async T => {
  await writeScenario(sessionsDir, T)
  await sleep(POLL_WAIT_MS)
}

const captureStills = async () => {
  for (const scheme of ['light', 'dark']) {
    const page = await openPage(scheme)
    await advance(200)
    await page.screenshot({ path: join(outDir, `session-${scheme}.png`), clip: await lowerClip(page), fullPage: true })
    await page.click('[data-agent="agent-e2e"]')
    await page.mouse.move(0, 0)
    await page.screenshot({ path: join(outDir, `agent-${scheme}.png`), clip: await lowerClip(page), fullPage: true })
    await page.close()
  }
}

const captureGif = async () => {
  const framesDir = join(workDir, 'frames')
  await mkdir(framesDir, { recursive: true })
  const page = await openPage('dark')
  let index = 0
  const shot = async () => {
    await page.screenshot({
      path: join(framesDir, `frame-${String(index).padStart(2, '0')}.png`),
      clip: await lowerClip(page, GIF_HEIGHT),
      fullPage: true,
    })
    index += 1
  }

  await advance(180)
  await shot()
  await advance(210)
  await page.hover('[data-agent="agent-e2e"]')
  await shot()
  await page.click('[data-agent="agent-e2e"]')
  await page.mouse.move(0, 0)
  await shot()
  await advance(270)
  await shot()
  await page.click('[data-back]')
  await advance(300)
  await page.hover('[data-agent="agent-executor"]')
  await shot()
  await page.click('[data-agent="agent-executor"]')
  await page.mouse.move(0, 0)
  await advance(310)
  await shot()

  for (const T of [345, 385, 425, 465, 505]) {
    await advance(T)
    await shot()
  }

  await page.close()
  await runPython(join(scriptDir, 'build-gif.py'), [framesDir, join(outDir, 'agent-detail.gif')])
}

const expectEqual = (label, actual, expected) => {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

const runChecks = async () => {
  const page = await openPage('light')
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  page.on('console', message => message.type() === 'error' && errors.push(message.text()))

  await page.focus('[data-agent="agent-e2e"]')
  await page.keyboard.press('Enter')
  expectEqual('focus after opening an agent', await page.evaluate(() => document.activeElement?.dataset?.back), 'true')
  expectEqual('log title', await page.locator('#log-session').textContent(), 'shop-api · general-purpose')
  expectEqual('no "null" in the detail', (await page.locator('#detail').textContent()).includes('null'), false)

  await advance(230)
  expectEqual('focus after a poll', await page.evaluate(() => document.activeElement?.dataset?.back), 'true')

  await page.keyboard.press('Enter')
  expectEqual('focus after going back', await page.evaluate(() => document.activeElement?.dataset?.agent), 'agent-e2e')

  const [shopApi] = buildSessions(230)
  const legacy = {
    ...shopApi,
    id: 'demo-legacy',
    project: 'legacy-session',
    agents: shopApi.agents.map(({ prompt, answer, recent, lastActivityAt, consecutiveErrors, ...rest }) => rest),
  }
  await writeFile(join(sessionsDir, 'demo-legacy.json'), JSON.stringify(legacy))
  await page.goto(`http://127.0.0.1:${PORT}/?lang=es#demo-legacy`)
  await page.waitForSelector('[data-agent="agent-e2e"]')
  await page.click('[data-agent="agent-e2e"]')
  expectEqual('legacy prompt falls back to the description', await page.locator('#detail .agent-text').first().textContent(), 'Run the checkout e2e suite')
  expectEqual('page errors', errors.join('\n'), '')

  await page.close()
  console.log('agent-board demo checks passed')
}

try {
  if (mode === 'stills') {
    await captureStills()
  } else if (mode === 'gif') {
    await captureGif()
  } else {
    await runChecks()
  }
} finally {
  await browser.close()
  server.kill()
  await rm(workDir, { recursive: true, force: true })
}

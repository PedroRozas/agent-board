import type { AgentStatus, On, RenderSurface } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

import type { SessionSnapshot } from '../types'

const HOME = '/home/test'
const SESSION_FILE = `${HOME}/.claude/agent-board/sessions/session-1.json`
const START_MS = 1_800_000_000_000
const PROCESS_OK = { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false }
const PANE_PROPS = {
  title: 'Agentes',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 40 },
  view: {},
}

type World = {
  files: Map<string, { text: string; mtimeMs: number }>
  agents: { id: string; status: AgentStatus }[]
  surfaces: RenderSurface[]
  isDashboardRunning: boolean
  commands: string[][]
  platform: string
  browserExitCode: number
  cwd: string
  failingCommand: { name: string; mode: 'throw' | 'exit' } | null
  logs: string[]
}

const SPANISH = { options: { language: 'es' } }
const BROWSER_COMMANDS: ReadonlySet<string> = new Set(['open', 'xdg-open', 'rundll32'])

const launchedDashboard = (world: World): string[] | undefined =>
  world.commands.find(argv => (argv[argv.length - 1] ?? '').includes('dashboard/server.mjs'))

const openedBrowser = (world: World): string[] | undefined =>
  world.commands.find(argv => BROWSER_COMMANDS.has(argv[0] ?? ''))

const COMMAND_CONTEXT = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: false, columns: 100 } }

const installWorld = (on: On, env: Readonly<Record<string, string>> = {}, platform = 'Darwin') => {
  const clock = mock.clock(on, { now: START_MS })
  const world: World = {
    files: new Map(),
    agents: [],
    surfaces: ['terminal'],
    isDashboardRunning: false,
    commands: [],
    platform,
    browserExitCode: 0,
    cwd: '/work/my-app',
    failingCommand: null,
    logs: [],
  }
  mock.env(on, { HOME, ...env })

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.surfaces', () => ({ value: world.surfaces }))
  on('session.id', () => ({ value: 'session-1' }))
  on('session.cwd', () => ({ value: world.cwd }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.usage', () => ({ value: {
    startedAt: START_MS,
    context: { window: 200_000, percent: 34 },
    rateLimits: [{ kind: 'five_hour', percentUsed: 42, resetsAt: new Date(START_MS + 3_600_000).toISOString() }],
    cost: { usd: 1.5 },
  } }))
  on('agent.list', () => ({
    value: world.agents.map(agent => ({ id: agent.id, status: agent.status, description: 'Implement task', type: 'executor-sonnet' })),
  }))
  on('ui.log', ($, e) => {
    world.logs.push(e.text)

    return { value: undefined }
  })
  on('process.run', ($, e) => {
    world.commands.push([...e.argv])

    if (world.failingCommand !== null && e.argv[0] === world.failingCommand.name) {
      if (world.failingCommand.mode === 'throw') {
        throw new Error(`${e.argv[0]} is not available`)
      }

      return { value: { ...PROCESS_OK, exitCode: 1, stderr: 'Operation not permitted\n' } }
    }

    if ((e.argv[e.argv.length - 1] ?? '').includes('dashboard/server.mjs')) {
      world.isDashboardRunning = true
    }

    if (e.argv[0] === 'uname') {
      return { value: { ...PROCESS_OK, stdout: `${world.platform}\n` } }
    }

    if (BROWSER_COMMANDS.has(e.argv[0] ?? '')) {
      return { value: { ...PROCESS_OK, exitCode: world.browserExitCode } }
    }

    return e.argv[0] === 'git' ? { value: { ...PROCESS_OK, stdout: 'feat/board\n' } } : { value: PROCESS_OK }
  })
  on('http.fetch', () => ({
    value: world.isDashboardRunning
      ? { ok: true, status: 200, headers: {}, text: '{"app":"agent-board"}' }
      : { ok: false, status: 0, headers: {}, text: '' },
  }))
  on('fs.write', ($, e) => {
    world.files.set(e.path, { text: e.text, mtimeMs: clock.now() })

    return { value: undefined }
  })
  on('fs.exists', ($, e) => ({ value: [...world.files.keys()].some(path => path.startsWith(e.path)) }))
  on('fs.list', ($, e) => ({
    value: [...world.files.entries()]
      .filter(([path]) => path.startsWith(`${e.path}/`))
      .map(([path, file]) => ({
        name: path.slice(e.path.length + 1),
        kind: 'file' as const,
        size: file.text.length,
        mtimeMs: file.mtimeMs,
        isLink: false,
      })),
  }))
  on('fs.read', ($, e) => {
    const file = world.files.get(e.path)

    if (file === undefined) {
      throw new Error(`missing ${e.path}`)
    }

    return { value: file.text }
  })
  on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))

  return { clock, world }
}

const readPublished = (world: World): SessionSnapshot => {
  const file = world.files.get(SESSION_FILE)

  if (file === undefined) {
    throw new Error('session file was not published')
  }

  return JSON.parse(file.text) as SessionSnapshot
}

describe('agent-board', () => {
  test('publishes the session with branch, context and plan usage', SPANISH, async ($, on) => {
    const { clock, world } = installWorld(on)
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)

    const published = readPublished(world)

    expect(published.project).toBe('my-app')
    expect(published.branch).toBe('feat/board')
    expect(published.contextPercent).toBe(34)
    expect(published.costUsd).toBe(1.5)
    expect(published.rateLimits[0]?.percentUsed).toBe(42)
  })

  test('records tool activity of the main loop', SPANISH, async ($, on) => {
    const { clock, world } = installWorld(on)
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'git status --short' })
    await clock.advance(3000)

    const [entry] = readPublished(world).recent

    expect(entry?.tool).toBe('Bash')
    expect(entry?.summary).toBe('git status --short')
    expect(entry?.agent).toBe('principal')
  })

  test('tracks a spawned subagent until it leaves the agent list', SPANISH, async ($, on) => {
    const { clock, world } = installWorld(on)
    on('agent.spawn', () => ({ model: 'claude-sonnet-5-5', agentId: 'agent-1' }))
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
    world.agents = [{ id: 'agent-1', status: 'running' }]
    await $.agent.spawn({
      tool_use_id: 'tool-1',
      prompt: 'Implement task 3',
      description: 'Implement task 3',
      subagentType: 'executor-sonnet',
      provider: { plugin: 'engine', tier: 'core' },
      parentModel: 'claude-opus-5-5',
      background: false,
      fork: false,
    })
    await clock.advance(3000)

    expect(readPublished(world).agents[0]?.status).toBe('running')

    world.agents = []
    await clock.advance(3000)

    expect(readPublished(world).agents[0]?.status).toBe('completed')
  })

  test('without a drawing surface /agentes answers the board as text', SPANISH, async ($, on) => {
    const { clock, world } = installWorld(on)
    world.surfaces = []
    await $.session.start({ cwd: '/work/my-app', surface: null, isInteractive: false })
    await $.tool.call({ tool: 'Bash', command: 'git status --short' })
    await clock.advance(3000)

    const list = await $.command.run({ command: 'agentes', args: 'texto', ...COMMAND_CONTEXT })
    const detail = await $.command.run({ command: 'agentes', args: '1', ...COMMAND_CONTEXT })
    const missing = await $.command.run({ command: 'agentes', args: '9', ...COMMAND_CONTEXT })

    expect(list.text).toContain('1. my-app (feat/board) · esta sesión')
    expect(list.text).toContain('ventana 5 h 42%')
    expect(detail.text).toContain('principal · Bash: git status --short')
    expect(missing.text).toContain('No hay una sesión 9')
  })

  test('/agentes without arguments starts the dashboard and opens the browser', SPANISH, async ($, on) => {
    const { world } = installWorld(on)
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

    const opened = await $.command.run({ command: 'agentes', args: '', ...COMMAND_CONTEXT })

    expect(opened.text).toContain('Dashboard abierto en http://127.0.0.1:4317/?lang=es')
    expect(launchedDashboard(world)?.[0]).toBe('/bin/sh')
    expect(launchedDashboard(world)?.[2]).toContain("server.mjs' 4317 ")
    expect(openedBrowser(world)).toEqual(['open', 'http://127.0.0.1:4317/?lang=es'])
  })

  test('/agentes panel opens the pane and without a surface answers as text', SPANISH, async ($, on) => {
    const { clock, world } = installWorld(on)
    on('ui.open', () => ({ value: { isPlaced: true } }))
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)

    const panel = await $.command.run({ command: 'agentes', args: 'panel', ...COMMAND_CONTEXT })
    world.surfaces = []
    const text = await $.command.run({ command: 'agentes', args: 'panel', ...COMMAND_CONTEXT })

    expect(panel.text).toBe('Panel de agentes abierto.')
    expect(text.text).toContain('1. my-app (feat/board) · esta sesión')
    expect(world.commands.some(argv => argv[0] === 'open')).toBe(false)
  })

  test('/agentes web reuses a dashboard that is already running', SPANISH, async ($, on) => {
    const { world } = installWorld(on)
    world.isDashboardRunning = true
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

    await $.command.run({ command: 'agentes', args: 'web', ...COMMAND_CONTEXT })

    expect(launchedDashboard(world)).toBeUndefined()
    expect(openedBrowser(world)?.[0]).toBe('open')
  })

  test('plan windows merge across sessions so a missing window never hides the other', SPANISH, async ($, on) => {
    const { clock, world } = installWorld(on)
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)
    const weekReset = new Date(START_MS + 86_400_000).toISOString()
    const otherSession = {
      ...readPublished(world),
      id: 'session-2',
      rateLimits: [{ kind: 'seven_day', percentUsed: 17, resetsAt: weekReset }],
    }
    world.files.set(`${HOME}/.claude/agent-board/sessions/session-2.json`, {
      text: JSON.stringify({ ...otherSession, updatedAt: START_MS + 10_000 }),
      mtimeMs: clock.now(),
    })
    await clock.advance(3000)

    const board = await $.command.run({ command: 'agentes', args: 'texto', ...COMMAND_CONTEXT })

    expect(board.text).toContain('ventana 5 h 42%')
    expect(board.text).toContain('semana 17%')
  })

  test('the pane lists sessions and opens the detail of the one pressed', SPANISH, async ($, on) => {
    const { clock } = installWorld(on)
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)

    for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
      const ui = await $.ui.mount({ plugin: 'agent-board', surface, component: 'Pane', requestId: 'agent-board', props: PANE_PROPS })

      expect(await ui.find({ text: /ventana 5 h 42%/ })).toBeDefined()
      await ui.press({ key: 'open-session-1' })
      expect(await ui.find({ text: /Uso de tokens/ })).toBeDefined()
      await ui.press({ key: 'back' })
      expect(await ui.find({ text: /Sesiones activas \(1\)/ })).toBeDefined()
      await ui.unmount()
    }
  })

  test('in English the board answers /agent-board with English labels', async ($, on) => {
    const { clock } = installWorld(on)
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
    await $.tool.call({ tool: 'Bash', command: 'git status --short' })
    await clock.advance(3000)

    const list = await $.command.run({ command: 'agent-board', args: 'text', ...COMMAND_CONTEXT })
    const detail = await $.command.run({ command: 'agent-board', args: '1', ...COMMAND_CONTEXT })

    expect(list.text).toContain('Active sessions (1)')
    expect(list.text).toContain('1. my-app (feat/board) · this session')
    expect(list.text).toContain('5-hour window 42%')
    expect(detail.text).toContain('main · Bash: git status --short')
  })

  test('the port option moves the dashboard and the browser to that port', { options: { port: 5123 } }, async ($, on) => {
    const { world } = installWorld(on, { SHELL: '/bin/zsh' })
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

    const opened = await $.command.run({ command: 'agent-board', args: 'web', ...COMMAND_CONTEXT })

    expect(opened.text).toBe('Dashboard opened at http://127.0.0.1:5123/?lang=en')
    expect(launchedDashboard(world)?.[0]).toBe('/bin/zsh')
    expect(launchedDashboard(world)?.[2]).toContain("server.mjs' 5123 ")
    expect(openedBrowser(world)).toEqual(['open', 'http://127.0.0.1:5123/?lang=en'])
  })

  test('on Linux with a display the dashboard opens with xdg-open', async ($, on) => {
    const { world } = installWorld(on, { DISPLAY: ':0' }, 'Linux')
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

    await $.command.run({ command: 'agent-board', args: '', ...COMMAND_CONTEXT })

    expect(openedBrowser(world)).toEqual(['xdg-open', 'http://127.0.0.1:4317/?lang=en'])
  })

  for (const [name, env, platform] of [
    ['Linux without a display', {}, 'Linux'],
    ['a remote session over ssh', { SSH_CONNECTION: '10.0.0.2 51000 10.0.0.1 22' }, 'Darwin'],
  ] as const) {
    test(`in ${name} the dashboard runs and the board answers as text`, async ($, on) => {
      const { clock, world } = installWorld(on, env, platform)
      await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
      await clock.advance(3000)

      const answer = await $.command.run({ command: 'agent-board', args: '', ...COMMAND_CONTEXT })

      expect(launchedDashboard(world)).toBeDefined()
      expect(openedBrowser(world)).toBeUndefined()
      expect(answer.text).toContain('this session has no browser')
      expect(answer.text).toContain('ssh -L 4317:127.0.0.1:4317')
      expect(answer.text).toContain('Active sessions (1)')
    })
  }

  test('a browser command that fails falls back to the text board', async ($, on) => {
    const { world } = installWorld(on)
    world.browserExitCode = 1
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

    const answer = await $.command.run({ command: 'agent-board', args: 'web', ...COMMAND_CONTEXT })

    expect(openedBrowser(world)?.[0]).toBe('open')
    expect(answer.text).toContain('this session has no browser')
  })

  test('on Windows the dashboard starts with PowerShell, opens with rundll32 and files are removed with PowerShell', async ($, on) => {
    const { clock, world } = installWorld(on, { OS: 'Windows_NT', HOME: '', USERPROFILE: HOME }, 'MINGW64_NT')
    world.cwd = 'C:\\Users\\dev\\my-app'
    await $.session.start({ cwd: 'C:\\Users\\dev\\my-app', surface: 'terminal', isInteractive: true })
    await clock.advance(3000)

    const opened = await $.command.run({ command: 'agent-board', args: 'web', ...COMMAND_CONTEXT })
    const launch = launchedDashboard(world)
    await $.session.end({ reason: 'prompt_input_exit', sessionId: 'session-1', resume: { id: 'session-1' } })
    const removal = world.commands.find(argv => (argv[4] ?? '').startsWith('Remove-Item'))

    expect(readPublished(world).project).toBe('my-app')
    expect(opened.text).toBe('Dashboard opened at http://127.0.0.1:4317/?lang=en')
    expect(launch?.[0]).toBe('powershell')
    expect(launch?.[4]).toContain('Start-Process -FilePath node')
    expect(launch?.[4]).toContain("'4317' -WindowStyle Hidden")
    expect(openedBrowser(world)).toEqual(['rundll32', 'url.dll,FileProtocolHandler', 'http://127.0.0.1:4317/?lang=en'])
    expect(removal?.[4]).toContain(`'${SESSION_FILE}'`)
    expect(world.commands.some(argv => argv[0] === 'uname' || argv[0] === 'rm')).toBe(false)
  })

  test('keeps the board directories private on macOS and Linux', async ($, on) => {
    const { world } = installWorld(on)
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

    expect(world.commands).toContainEqual(['mkdir', '-p', '-m', '700', `${HOME}/.claude/agent-board/sessions`])
    expect(world.commands).toContainEqual(['chmod', '700', `${HOME}/.claude/agent-board`, `${HOME}/.claude/agent-board/sessions`])
  })

  test('leaves directory permissions to Windows', async ($, on) => {
    const { world } = installWorld(on, { OS: 'Windows_NT', HOME: '', USERPROFILE: HOME }, 'MINGW64_NT')
    await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })

    expect(world.commands.some(argv => argv[0] === 'chmod' || argv[0] === 'mkdir')).toBe(false)
  })

  for (const name of ['mkdir', 'chmod'] as const) {
    for (const mode of ['throw', 'exit'] as const) {
      test(`when ${name} fails (${mode}) it logs the reason and the session keeps publishing`, async ($, on) => {
        const { clock, world } = installWorld(on)
        world.failingCommand = { name, mode }
        await $.session.start({ cwd: '/work/my-app', surface: 'terminal', isInteractive: true })
        await clock.advance(3000)

        expect(world.logs.some(line => line.startsWith(`agent-board: could not make ${HOME}/.claude/agent-board private`))).toBe(true)
        expect(readPublished(world).project).toBe('my-app')
      })
    }
  }
})

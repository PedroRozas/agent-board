import type { EngineInterface, Register } from 'claude-code'

import type { Board, SessionSnapshot } from '../types'
import { renderBoardText, renderSessionText } from './board-text'
import { DELETE_AFTER_MS, HIDDEN_AFTER_MS, sortSessions } from './format'
import {
  addAgent,
  addUsage,
  applyUsageReport,
  completeTurn,
  createSnapshot,
  finishTool,
  isSessionSnapshot,
  normalizeSnapshot,
  startTool,
  startTurn,
  syncAgentStatuses,
} from './snapshot'
import { messagesFor, resolveLanguage, type Language, type Messages } from './i18n'
import {
  browserCommand,
  dashboardLaunchCommand,
  lastPathSegment,
  platformFromUname,
  removeFilesCommand,
  resolvePort,
  type HostFacts,
  type Platform,
} from './platform'
import { summarizeTool } from './tool-summary'
import { renderBoardList, renderSessionDetail } from './views'

const PANE_ID = 'agent-board'
const TICK_MS = 3000
const SESSIONS_DIR_SUFFIX = '/.claude/agent-board/sessions'
const EMPTY_BOARD: Board = { sessions: [], refreshedAt: 0 }
const DASHBOARD_HOST = '127.0.0.1'
const DASHBOARD_START_ATTEMPTS = 12
const DASHBOARD_START_POLL_MS = 250
const FALLBACK_SHELL = '/bin/sh'
const WEB_ARGUMENT = 'web'
const PANEL_ARGUMENT = 'panel'
const TEXT_ARGUMENTS: ReadonlySet<string> = new Set(['texto', 'text'])

type Dashboard = { port: number; baseUrl: string; pageUrl: string }

const dashboardFor = (port: number, language: Language): Dashboard => {
  const baseUrl = `http://${DASHBOARD_HOST}:${port}`

  return { port, baseUrl, pageUrl: `${baseUrl}/?lang=${language}` }
}

const WINDOWS_OS = 'Windows_NT'

const SNAPSHOT_REF = { plugin: 'agent-board', key: 'snapshot' } as const
const BOARD_REF = { plugin: 'agent-board', key: 'board' } as const
const SELECTED_REF = { plugin: 'agent-board', key: 'selectedId' } as const

const isSet = (value: string | undefined): value is string => value !== undefined && value !== ''

async function sessionsDirectory($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  const userProfile = await $.env.get('USERPROFILE')

  if (!isSet(home) && !isSet(userProfile)) {
    throw new Error('agent-board: ni HOME ni USERPROFILE están definidos')
  }

  return `${isSet(home) ? home : userProfile}${SESSIONS_DIR_SUFFIX}`
}

async function readSnapshot($: EngineInterface): Promise<SessionSnapshot | null> {
  const { value = null } = await $.state.get(SNAPSHOT_REF)

  return value
}

async function updateSnapshot($: EngineInterface, change: (snapshot: SessionSnapshot) => SessionSnapshot): Promise<void> {
  for (;;) {
    const { value = null, version } = await $.state.get(SNAPSHOT_REF)

    if (value === null) {
      return
    }

    const changed = change(value)

    if (changed === value) {
      return
    }

    const { isSet } = await $.state.set(SNAPSHOT_REF, changed, { ifVersion: version })

    if (isSet) {
      return
    }
  }
}

async function readBranch($: EngineInterface, cwd: string): Promise<string | null> {
  try {
    const { exitCode, stdout } = await $.process.run(['git', '-C', cwd, 'branch', '--show-current'], {
      timeoutMs: 2000,
    })
    const branch = stdout.trim()

    return exitCode === 0 && branch !== '' ? branch : null
  } catch (error) {
    $.ui.log(`agent-board: no se pudo leer la rama (${String(error)})`)

    return null
  }
}

async function publishSnapshot($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await updateSnapshot($, snapshot => ({ ...snapshot, updatedAt: now }))
  const snapshot = await readSnapshot($)

  if (snapshot !== null) {
    await $.fs.write(`${await sessionsDirectory($)}/${snapshot.id}.json`, JSON.stringify(snapshot))
  }
}

async function isWindows($: EngineInterface): Promise<boolean> {
  return (await $.env.get('OS')) === WINDOWS_OS
}

async function readPlatform($: EngineInterface): Promise<Platform> {
  if (await isWindows($)) {
    return 'windows'
  }

  try {
    const { exitCode, stdout } = await $.process.run(['uname', '-s'], { timeoutMs: 2000 })

    return exitCode === 0 ? platformFromUname(stdout.trim()) : 'other'
  } catch (error) {
    $.ui.log(`agent-board: no se pudo detectar la plataforma (${String(error)})`)

    return 'other'
  }
}

async function removeFiles($: EngineInterface, paths: readonly string[]): Promise<void> {
  if (paths.length > 0) {
    const platform = (await isWindows($)) ? 'windows' : 'other'
    await $.process.run(removeFilesCommand(platform, paths), { timeoutMs: 5000 })
  }
}

async function readSessionFile($: EngineInterface, path: string): Promise<SessionSnapshot | null> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(path))

    return isSessionSnapshot(parsed) ? normalizeSnapshot(parsed) : null
  } catch (error) {
    $.ui.log(`agent-board: se ignoró ${path} (${String(error)})`)

    return null
  }
}

async function refreshBoard($: EngineInterface): Promise<void> {
  const directory = await sessionsDirectory($)
  const now = await $.clock.now()

  if (!(await $.fs.exists(directory))) {
    await $.state.set(BOARD_REF, { sessions: [], refreshedAt: now })

    return
  }

  const files = (await $.fs.list(directory)).filter(entry => entry.kind === 'file' && entry.name.endsWith('.json'))
  await removeFiles(
    $,
    files.filter(entry => now - entry.mtimeMs > DELETE_AFTER_MS).map(entry => `${directory}/${entry.name}`),
  )

  const recentFiles = files.filter(entry => now - entry.mtimeMs <= HIDDEN_AFTER_MS)
  const snapshots = await Promise.all(recentFiles.map(entry => readSessionFile($, `${directory}/${entry.name}`)))
  const sessions = snapshots.filter((snapshot): snapshot is SessionSnapshot => snapshot !== null)

  await $.state.set(BOARD_REF, { sessions: sortSessions(sessions), refreshedAt: now })
}

async function syncAgents($: EngineInterface): Promise<void> {
  const agents = await $.agent.list()
  const now = await $.clock.now()
  await updateSnapshot($, snapshot =>
    syncAgentStatuses(
      snapshot,
      agents.map(agent => ({ id: agent.id, status: agent.status })),
      now,
    ),
  )
}

async function syncUsage($: EngineInterface): Promise<void> {
  const usage = await $.session.usage()
  await updateSnapshot($, snapshot =>
    applyUsageReport(snapshot, {
      contextPercent: usage.context.percent ?? null,
      costUsd: usage.cost?.usd ?? null,
      rateLimits: usage.rateLimits.map(window => ({
        kind: window.kind,
        percentUsed: window.percentUsed,
        resetsAt: window.resetsAt ?? null,
      })),
    }),
  )
}

async function tick($: EngineInterface): Promise<void> {
  await syncAgents($)
  await syncUsage($)
  await publishSnapshot($)
  await refreshBoard($)
}

function runTick($: EngineInterface): void {
  tick($).catch((error: unknown) => {
    $.ui.log(`agent-board: falló la actualización periódica (${String(error)})`)
  })
}

async function startSession($: EngineInterface): Promise<void> {
  const id = await $.session.id()
  const existing = await readSnapshot($)

  if (existing !== null && existing.id === id) {
    await $.state.set(SNAPSHOT_REF, normalizeSnapshot(existing))

    return
  }

  const cwd = await $.session.cwd()
  await $.state.set(
    SNAPSHOT_REF,
    createSnapshot({
      id,
      project: lastPathSegment(cwd),
      cwd,
      branch: await readBranch($, cwd),
      model: await $.session.model(),
      startedAt: await $.clock.now(),
    }),
  )
}

async function describeBoardAsText($: EngineInterface, args: string, messages: Messages): Promise<string> {
  const { value: board = EMPTY_BOARD } = await $.state.get(BOARD_REF)
  const ownId = (await readSnapshot($))?.id ?? null
  const position = Number.parseInt(args.trim(), 10)

  if (Number.isNaN(position)) {
    return renderBoardText(board.sessions, board.refreshedAt, ownId, messages)
  }

  const session = board.sessions[position - 1]

  return session === undefined
    ? messages.missingSession(position)
    : renderSessionText(session, board.refreshedAt, ownId, messages)
}

async function isDashboardRunning($: EngineInterface, dashboard: Dashboard): Promise<boolean> {
  try {
    const response = await $.http.fetch(`${dashboard.baseUrl}/api/health`)

    return response.ok && response.text.includes('agent-board')
  } catch (error) {
    return false
  }
}

async function startDashboard($: EngineInterface, dashboard: Dashboard): Promise<boolean> {
  const shell = (await $.env.get('SHELL')) ?? FALLBACK_SHELL
  const serverPath = `${$.plugin.root}/dashboard/server.mjs`
  await $.process.run(dashboardLaunchCommand(await readPlatform($), shell, serverPath, dashboard.port), {
    timeoutMs: 10_000,
  })

  for (let attempt = 0; attempt < DASHBOARD_START_ATTEMPTS; attempt += 1) {
    if (await isDashboardRunning($, dashboard)) {
      return true
    }

    await $.clock.sleep(DASHBOARD_START_POLL_MS)
  }

  return false
}

async function readHostFacts($: EngineInterface): Promise<HostFacts> {
  const [platform, sshConnection, sshTty, display, waylandDisplay] = await Promise.all([
    readPlatform($),
    $.env.get('SSH_CONNECTION'),
    $.env.get('SSH_TTY'),
    $.env.get('DISPLAY'),
    $.env.get('WAYLAND_DISPLAY'),
  ])

  return {
    platform,
    hasDisplay: isSet(display) || isSet(waylandDisplay),
    isRemote: isSet(sshConnection) || isSet(sshTty),
  }
}

async function openInBrowser($: EngineInterface, url: string): Promise<boolean> {
  const command = browserCommand(await readHostFacts($), url)

  if (command === null) {
    return false
  }

  const { exitCode } = await $.process.run(command, { timeoutMs: 5000 })

  return exitCode === 0
}

async function openDashboard($: EngineInterface, dashboard: Dashboard, messages: Messages): Promise<string> {
  const isRunning = (await isDashboardRunning($, dashboard)) || (await startDashboard($, dashboard))

  if (!isRunning) {
    return messages.dashboardFailed(dashboard.baseUrl, dashboard.port)
  }

  if (await openInBrowser($, dashboard.pageUrl)) {
    return messages.dashboardOpened(dashboard.pageUrl)
  }

  return `${messages.dashboardWithoutBrowser(dashboard.pageUrl, dashboard.port)}\n\n${await describeBoardAsText($, '', messages)}`
}

async function selectSession($: EngineInterface, sessionId: string | null): Promise<void> {
  await $.state.set(SELECTED_REF, sessionId)
}

async function runCommand(
  $: EngineInterface,
  args: string,
  dashboard: Dashboard,
  messages: Messages,
): Promise<{ text: string }> {
  const argument = args.trim().toLowerCase()
  await refreshBoard($)

  if (argument === '' || argument === WEB_ARGUMENT) {
    return { text: await openDashboard($, dashboard, messages) }
  }

  const isTextArgument = TEXT_ARGUMENTS.has(argument) || argument === PANEL_ARGUMENT
  const hasSurface = (await $.session.surfaces()).length > 0

  if (argument !== PANEL_ARGUMENT || !hasSurface) {
    return { text: await describeBoardAsText($, isTextArgument ? '' : argument, messages) }
  }

  await selectSession($, null)
  const opened = await $.ui.open({ id: PANE_ID, title: messages.paneTitle })

  return { text: opened.isPlaced ? messages.paneOpened : messages.paneDoesNotFit }
}

export const register: Register = (on, options) => {
  const language = resolveLanguage(options.language)
  const messages = messagesFor(language)
  const dashboard = dashboardFor(resolvePort(options.port), language)

  on('session.start', async ($, e, next) => {
    await startSession($)

    if (language === 'es') {
      await $.command.register({
        name: 'agentes',
        description: messages.commandDescription,
        argumentHint: messages.argumentHint,
      })
    } else {
      await $.command.register({
        name: 'agent-board',
        description: messages.commandDescription,
        argumentHint: messages.argumentHint,
      })
    }

    $.clock.every(TICK_MS, () => runTick($))
    runTick($)

    return next(e)
  })

  on('session.end', async ($, e, next) => {
    const snapshot = await readSnapshot($)

    if (snapshot !== null) {
      await removeFiles($, [`${await sessionsDirectory($)}/${snapshot.id}.json`])
    }

    return next(e)
  })

  on('command.run', { command: 'agentes' }, ($, e) => runCommand($, e.args, dashboard, messages))

  on('command.run', { command: 'agent-board' }, ($, e) => runCommand($, e.args, dashboard, messages))

  on('turn.start', async ($, e, next) => {
    const now = await $.clock.now()
    const snapshot = await readSnapshot($)
    const branch = snapshot === null ? null : await readBranch($, snapshot.cwd)
    await updateSnapshot($, current => ({ ...startTurn(current, e.text, now), branch }))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const usage = e.usage

    if (usage !== undefined) {
      await updateSnapshot($, snapshot => addUsage(snapshot, usage.model, usage))
    }

    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await updateSnapshot($, snapshot => completeTurn(snapshot, now))
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const agentId = spawned.deny === undefined ? spawned.agentId : undefined

    if (agentId !== undefined && spawned.deny === undefined) {
      const now = await $.clock.now()
      await updateSnapshot($, snapshot =>
        addAgent(snapshot, {
          id: agentId,
          type: e.subagentType,
          description: e.description,
          model: spawned.model,
          status: 'running',
          startedAt: now,
          endedAt: null,
          currentTool: null,
          toolCount: 0,
        }),
      )
    }

    return spawned
  })

  on('tool.call', async ($, e, next) => {
    const startedAt = await $.clock.now()
    const tool = String(e.tool)
    const args: Readonly<Record<string, unknown>> = e
    const summary = summarizeTool(tool, args)
    const activityId = e.tool_use_id ?? `${tool}-${startedAt}`
    await updateSnapshot($, snapshot => startTool(snapshot, e.agentId, { id: activityId, tool, summary, startedAt }))

    const ran = await next(e)
    const agentLabel =
      e.agentId === undefined
        ? messages.mainAgent
        : ((await readSnapshot($))?.agents.find(agent => agent.id === e.agentId)?.type ?? messages.subagent)
    await updateSnapshot($, snapshot =>
      finishTool(snapshot, e.agentId, activityId, {
        at: startedAt,
        agent: agentLabel,
        tool,
        summary,
        isError: ran.deny !== undefined || ran.isError === true,
      }),
    )

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { value: board = EMPTY_BOARD } = await $.state.get(BOARD_REF)
    const { value: selectedId = null } = await $.state.get(SELECTED_REF)
    const ownId = (await readSnapshot($))?.id ?? null
    const selected = board.sessions.find(session => session.id === selectedId)

    if (selected !== undefined) {
      return renderSessionDetail({
        elements,
        messages,
        session: selected,
        now: board.refreshedAt,
        ownId,
        onBack: () => {
          void selectSession($, null)
        },
      })
    }

    return renderBoardList({
      elements,
      messages,
      sessions: board.sessions,
      now: board.refreshedAt,
      ownId,
      onSelect: sessionId => {
        void selectSession($, sessionId)
      },
    })
  })
}

import type { EngineInterface, Register } from 'claude-code'

import type { Board, SessionSnapshot } from '../types'
import { renderAgentText, renderBoardText, renderSessionText } from './board-text'
import { DELETE_AFTER_MS, HIDDEN_AFTER_MS, sortSessions } from './format'
import {
  addAgent,
  addUsage,
  applyUsageReport,
  completeTurn,
  createAgent,
  createSnapshot,
  finishTool,
  isSessionSnapshot,
  normalizeSnapshot,
  recordAgentAnswer,
  startTool,
  startTurn,
  syncAgentStatuses,
} from './snapshot'
import { messagesFor, resolveLanguage, type Language, type Messages } from './i18n'
import {
  browserCommand,
  dashboardLaunchCommand,
  lastPathSegment,
  moveFileCommand,
  platformFromUname,
  removeFilesCommand,
  resolvePort,
  type HostFacts,
  type Platform,
} from './platform'
import { summarizeTool } from './tool-summary'
import { renderAgentDetail, renderBoardList, renderSessionDetail } from './views'

const PANE_ID = 'agent-board'
const TICK_MS = 3000
const BOARD_DIR_SUFFIX = '/.claude/agent-board'
const SESSIONS_DIR_NAME = 'sessions'
const SNAPSHOT_SUFFIX = '.json'
const TEMPORARY_SNAPSHOT_SUFFIX = '.json.tmp'
const PRIVATE_DIRECTORY_MODE = '700'
const EMPTY_BOARD: Board = { sessions: [], refreshedAt: 0 }
const DASHBOARD_HOST = '127.0.0.1'
const DASHBOARD_START_ATTEMPTS = 12
const DASHBOARD_START_POLL_MS = 250
const FALLBACK_SHELL = '/bin/sh'
const WEB_ARGUMENT = 'web'
const PANEL_ARGUMENT = 'panel'
const TEXT_ARGUMENTS: ReadonlySet<string> = new Set(['texto', 'text'])
const POSITION_ARGUMENT = /^(\d+)(?:\.(\d+))?$/

type Dashboard = { port: number; baseUrl: string; pageUrl: string }

const dashboardFor = (port: number, language: Language): Dashboard => {
  const baseUrl = `http://${DASHBOARD_HOST}:${port}`

  return { port, baseUrl, pageUrl: `${baseUrl}/?lang=${language}` }
}

const WINDOWS_OS = 'Windows_NT'

const SNAPSHOT_REF = { plugin: 'agent-board', key: 'snapshot' } as const
const BOARD_REF = { plugin: 'agent-board', key: 'board' } as const
const SELECTED_REF = { plugin: 'agent-board', key: 'selectedId' } as const
const SELECTED_AGENT_REF = { plugin: 'agent-board', key: 'selectedAgentId' } as const
const UNPARSABLE_FILES_REF = { plugin: 'agent-board', key: 'unparsableFiles' } as const

type SessionFileRead =
  | { kind: 'snapshot'; name: string; snapshot: SessionSnapshot | null }
  | { kind: 'unparsable'; name: string; reason: string }

type UnparsableSessionFile = Extract<SessionFileRead, { kind: 'unparsable' }>

const isSet = (value: string | undefined): value is string => value !== undefined && value !== ''

async function boardDirectory($: EngineInterface): Promise<string> {
  const home = await $.env.get('HOME')
  const userProfile = await $.env.get('USERPROFILE')

  if (!isSet(home) && !isSet(userProfile)) {
    throw new Error('agent-board: neither HOME nor USERPROFILE is set')
  }

  return `${isSet(home) ? home : userProfile}${BOARD_DIR_SUFFIX}`
}

async function sessionsDirectory($: EngineInterface): Promise<string> {
  return `${await boardDirectory($)}/${SESSIONS_DIR_NAME}`
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
    $.ui.log(`agent-board: could not read the git branch (${String(error)})`)

    return null
  }
}

async function publishSnapshot($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await updateSnapshot($, snapshot => ({ ...snapshot, updatedAt: now }))
  const snapshot = await readSnapshot($)

  if (snapshot === null) {
    return
  }

  const directory = await sessionsDirectory($)
  const temporaryPath = `${directory}/.${snapshot.id}${TEMPORARY_SNAPSHOT_SUFFIX}`
  const path = `${directory}/${snapshot.id}${SNAPSHOT_SUFFIX}`
  await $.fs.write(temporaryPath, JSON.stringify(snapshot))
  const failure = await moveFile($, temporaryPath, path)

  if (failure !== null) {
    $.ui.log(`agent-board: could not publish ${path} (${failure})`)
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
    $.ui.log(`agent-board: could not detect the platform (${String(error)})`)

    return 'other'
  }
}

async function runPrivateDirectoryCommands($: EngineInterface, board: string, sessions: string): Promise<string | null> {
  const commands = [
    ['mkdir', '-p', '-m', PRIVATE_DIRECTORY_MODE, sessions],
    ['chmod', PRIVATE_DIRECTORY_MODE, board, sessions],
  ]

  try {
    for (const command of commands) {
      const { exitCode, stderr } = await $.process.run(command, { timeoutMs: 2000 })

      if (exitCode !== 0) {
        return `${command[0]} exited with ${exitCode}: ${stderr.trim()}`
      }
    }

    return null
  } catch (error) {
    return String(error)
  }
}

async function securePrivateDirectories($: EngineInterface): Promise<void> {
  if (await isWindows($)) {
    return
  }

  const board = await boardDirectory($)
  const sessions = await sessionsDirectory($)

  const failure = await runPrivateDirectoryCommands($, board, sessions)

  if (failure !== null) {
    $.ui.log(`agent-board: could not make ${board} private (${failure})`)
  }
}

async function fileCommandPlatform($: EngineInterface): Promise<Platform> {
  return (await isWindows($)) ? 'windows' : 'other'
}

async function moveFile($: EngineInterface, from: string, to: string): Promise<string | null> {
  const command = moveFileCommand(await fileCommandPlatform($), from, to)

  try {
    const { exitCode, stderr } = await $.process.run(command, { timeoutMs: 5000 })

    return exitCode === 0 ? null : `${command[0]} exited with ${exitCode}: ${stderr.trim()}`
  } catch (error) {
    return String(error)
  }
}

async function removeFiles($: EngineInterface, paths: readonly string[]): Promise<void> {
  if (paths.length > 0) {
    await $.process.run(removeFilesCommand(await fileCommandPlatform($), paths), { timeoutMs: 5000 })
  }
}

const isBoardFile = (name: string): boolean => name.endsWith(SNAPSHOT_SUFFIX) || name.endsWith(TEMPORARY_SNAPSHOT_SUFFIX)

const sessionIdOf = (name: string): string => name.slice(0, -SNAPSHOT_SUFFIX.length)

const isUnparsable = (read: SessionFileRead): read is UnparsableSessionFile => read.kind === 'unparsable'

async function readSessionFile($: EngineInterface, directory: string, name: string): Promise<SessionFileRead> {
  try {
    const parsed: unknown = JSON.parse(await $.fs.read(`${directory}/${name}`))

    return { kind: 'snapshot', name, snapshot: isSessionSnapshot(parsed) ? normalizeSnapshot(parsed) : null }
  } catch (error) {
    if (error instanceof SyntaxError) {
      return { kind: 'unparsable', name, reason: String(error) }
    }

    $.ui.log(`agent-board: skipped ${directory}/${name} (${String(error)})`)

    return { kind: 'snapshot', name, snapshot: null }
  }
}

async function resolveSessions(
  $: EngineInterface,
  directory: string,
  reads: readonly SessionFileRead[],
): Promise<SessionSnapshot[]> {
  const { value: board = EMPTY_BOARD } = await $.state.get(BOARD_REF)
  const { value: previouslyUnparsable = [] } = await $.state.get(UNPARSABLE_FILES_REF)
  const unparsable = reads.filter(isUnparsable)

  for (const read of unparsable.filter(read => previouslyUnparsable.includes(read.name))) {
    $.ui.log(`agent-board: skipped ${directory}/${read.name} (${read.reason})`)
  }

  await $.state.set(UNPARSABLE_FILES_REF, unparsable.map(read => read.name))

  return reads
    .map(read =>
      read.kind === 'snapshot'
        ? read.snapshot
        : (board.sessions.find(session => session.id === sessionIdOf(read.name)) ?? null),
    )
    .filter((snapshot): snapshot is SessionSnapshot => snapshot !== null)
}

async function refreshBoard($: EngineInterface): Promise<void> {
  const directory = await sessionsDirectory($)
  const now = await $.clock.now()

  if (!(await $.fs.exists(directory))) {
    await $.state.set(BOARD_REF, { sessions: [], refreshedAt: now })

    return
  }

  const files = (await $.fs.list(directory)).filter(entry => entry.kind === 'file' && isBoardFile(entry.name))
  await removeFiles(
    $,
    files.filter(entry => now - entry.mtimeMs > DELETE_AFTER_MS).map(entry => `${directory}/${entry.name}`),
  )

  const recentFiles = files.filter(entry => entry.name.endsWith(SNAPSHOT_SUFFIX) && now - entry.mtimeMs <= HIDDEN_AFTER_MS)
  const reads = await Promise.all(recentFiles.map(entry => readSessionFile($, directory, entry.name)))
  const sessions = await resolveSessions($, directory, reads)

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
    $.ui.log(`agent-board: periodic refresh failed (${String(error)})`)
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
  const match = POSITION_ARGUMENT.exec(args.trim())

  if (match === null) {
    return renderBoardText(board.sessions, board.refreshedAt, ownId, messages)
  }

  const sessionPosition = Number(match[1])
  const session = board.sessions[sessionPosition - 1]

  if (session === undefined) {
    return messages.missingSession(sessionPosition)
  }

  if (match[2] === undefined) {
    return renderSessionText(session, sessionPosition, board.refreshedAt, ownId, messages)
  }

  const agentPosition = Number(match[2])
  const agent = session.agents[agentPosition - 1]

  return agent === undefined
    ? messages.missingAgent(sessionPosition, agentPosition)
    : renderAgentText(session, agent, board.refreshedAt, ownId, messages)
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
  await $.state.set(SELECTED_AGENT_REF, null)
  await $.state.set(SELECTED_REF, sessionId)
}

async function selectAgent($: EngineInterface, agentId: string | null): Promise<void> {
  await $.state.set(SELECTED_AGENT_REF, agentId)
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
    await securePrivateDirectories($)
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
    if (e.agentId !== undefined) {
      return next(e)
    }

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

    const now = await $.clock.now()
    const agentId = e.agentId

    if (agentId === undefined) {
      await updateSnapshot($, snapshot => completeTurn(snapshot, now))
    } else if (e.answer !== '') {
      await updateSnapshot($, snapshot => recordAgentAnswer(snapshot, agentId, e.answer, now))
    }

    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const agentId = spawned.deny === undefined ? spawned.agentId : undefined

    if (agentId !== undefined && spawned.deny === undefined) {
      const now = await $.clock.now()
      await updateSnapshot($, snapshot =>
        addAgent(
          snapshot,
          createAgent({
            id: agentId,
            type: e.subagentType,
            description: e.description,
            model: spawned.model,
            prompt: e.prompt,
            startedAt: now,
          }),
        ),
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
    const finishedAt = await $.clock.now()
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
      }, finishedAt),
    )

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE_ID }, async ($, e) => {
    const elements = $.ui.resolve(e)
    const { value: board = EMPTY_BOARD } = await $.state.get(BOARD_REF)
    const { value: selectedId = null } = await $.state.get(SELECTED_REF)
    const { value: selectedAgentId = null } = await $.state.get(SELECTED_AGENT_REF)
    const ownId = (await readSnapshot($))?.id ?? null
    const selected = board.sessions.find(session => session.id === selectedId)
    const selectedAgent = selected?.agents.find(agent => agent.id === selectedAgentId)

    if (selected !== undefined && selectedAgent !== undefined) {
      return renderAgentDetail({
        elements,
        messages,
        session: selected,
        agent: selectedAgent,
        now: board.refreshedAt,
        ownId,
        onBack: () => {
          void selectAgent($, null)
        },
      })
    }

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
        onSelectAgent: agentId => {
          void selectAgent($, agentId)
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

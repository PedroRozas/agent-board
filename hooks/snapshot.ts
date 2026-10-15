import type { ModelUsage } from 'claude-code'

import type { ActivityEntry, AgentSnapshot, RateLimitWindow, SessionSnapshot, TokenUsage, ToolActivity } from '../types'

const RECENT_LIMIT = 30
const FINISHED_AGENT_LIMIT = 10
const PROMPT_LIMIT = 200
const TURN_HISTORY_MS = 60 * 60_000
const TURN_HISTORY_LIMIT = 40
const ACTIVE_AGENT_STATUSES: ReadonlySet<string> = new Set(['pending', 'running', 'waiting'])
const EMPTY_USAGE: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

export type SessionIdentity = Pick<SessionSnapshot, 'id' | 'project' | 'cwd' | 'branch' | 'model' | 'startedAt'>

export type AgentStatusEntry = { id: string; status: string }

export const isActiveAgent = (agent: AgentSnapshot): boolean => ACTIVE_AGENT_STATUSES.has(agent.status)

export const createSnapshot = (identity: SessionIdentity): SessionSnapshot => ({
  ...identity,
  updatedAt: identity.startedAt,
  isWorking: false,
  turnStartedAt: null,
  turnHistory: [],
  prompt: '',
  currentTool: null,
  agents: [],
  usageByModel: {},
  contextPercent: null,
  costUsd: null,
  rateLimits: [],
  turns: 0,
  recent: [],
})

export const startTurn = (snapshot: SessionSnapshot, prompt: string, at: number): SessionSnapshot => ({
  ...snapshot,
  isWorking: true,
  turnStartedAt: at,
  prompt: prompt.slice(0, PROMPT_LIMIT),
  currentTool: null,
})

export const completeTurn = (snapshot: SessionSnapshot, at: number): SessionSnapshot => {
  const finishedTurn = snapshot.turnStartedAt === null ? [] : [{ startedAt: snapshot.turnStartedAt, endedAt: at }]

  return {
    ...snapshot,
    isWorking: false,
    turnStartedAt: null,
    turnHistory: [...snapshot.turnHistory, ...finishedTurn]
      .filter(turn => at - turn.endedAt <= TURN_HISTORY_MS)
      .slice(-TURN_HISTORY_LIMIT),
    currentTool: null,
    turns: snapshot.turns + 1,
  }
}

export const addUsage = (snapshot: SessionSnapshot, model: string, usage: ModelUsage): SessionSnapshot => {
  const current = snapshot.usageByModel[model] ?? EMPTY_USAGE

  return {
    ...snapshot,
    usageByModel: {
      ...snapshot.usageByModel,
      [model]: {
        input: current.input + usage.input_tokens,
        output: current.output + usage.output_tokens,
        cacheRead: current.cacheRead + usage.cache_read_input_tokens,
        cacheWrite: current.cacheWrite + usage.cache_creation_input_tokens,
      },
    },
  }
}

export type UsageReport = Pick<SessionSnapshot, 'contextPercent' | 'costUsd' | 'rateLimits'>

const sameRateLimits = (a: readonly RateLimitWindow[], b: readonly RateLimitWindow[]): boolean =>
  a.length === b.length &&
  a.every((window, index) => {
    const other = b[index]

    return (
      other !== undefined &&
      window.kind === other.kind &&
      window.percentUsed === other.percentUsed &&
      window.resetsAt === other.resetsAt
    )
  })

export const applyUsageReport = (snapshot: SessionSnapshot, report: UsageReport): SessionSnapshot =>
  snapshot.contextPercent === report.contextPercent &&
  snapshot.costUsd === report.costUsd &&
  sameRateLimits(snapshot.rateLimits, report.rateLimits)
    ? snapshot
    : { ...snapshot, ...report }

const updateAgent = (
  snapshot: SessionSnapshot,
  agentId: string,
  change: (agent: AgentSnapshot) => AgentSnapshot,
): SessionSnapshot => ({
  ...snapshot,
  agents: snapshot.agents.map(agent => (agent.id === agentId ? change(agent) : agent)),
})

export const startTool = (
  snapshot: SessionSnapshot,
  agentId: string | undefined,
  activity: ToolActivity,
): SessionSnapshot =>
  agentId === undefined
    ? { ...snapshot, currentTool: activity }
    : updateAgent(snapshot, agentId, agent => ({ ...agent, currentTool: activity, toolCount: agent.toolCount + 1 }))

const clearToolIfCurrent = (current: ToolActivity | null, activityId: string): ToolActivity | null =>
  current !== null && current.id === activityId ? null : current

export const finishTool = (
  snapshot: SessionSnapshot,
  agentId: string | undefined,
  activityId: string,
  entry: ActivityEntry,
): SessionSnapshot => {
  const cleared =
    agentId === undefined
      ? { ...snapshot, currentTool: clearToolIfCurrent(snapshot.currentTool, activityId) }
      : updateAgent(snapshot, agentId, agent => ({
          ...agent,
          currentTool: clearToolIfCurrent(agent.currentTool, activityId),
        }))

  return { ...cleared, recent: [entry, ...cleared.recent].slice(0, RECENT_LIMIT) }
}

export const addAgent = (snapshot: SessionSnapshot, agent: AgentSnapshot): SessionSnapshot => ({
  ...snapshot,
  agents: [agent, ...snapshot.agents.filter(existing => existing.id !== agent.id)],
})

const resolveStatus = (agent: AgentSnapshot, listed: ReadonlyMap<string, string>): string =>
  listed.get(agent.id) ?? (isActiveAgent(agent) ? 'completed' : agent.status)

export const syncAgentStatuses = (
  snapshot: SessionSnapshot,
  entries: readonly AgentStatusEntry[],
  now: number,
): SessionSnapshot => {
  const listed = new Map(entries.map(entry => [entry.id, entry.status]))
  const synced = snapshot.agents.map(agent => {
    const status = resolveStatus(agent, listed)

    return status === agent.status
      ? agent
      : ACTIVE_AGENT_STATUSES.has(status)
        ? { ...agent, status, endedAt: null }
        : { ...agent, status, currentTool: null, endedAt: agent.endedAt ?? now }
  })
  const active = synced.filter(isActiveAgent)
  const finished = synced.filter(agent => !isActiveAgent(agent)).slice(0, FINISHED_AGENT_LIMIT)
  const agents = [...active, ...finished]
  const isUnchanged = agents.length === snapshot.agents.length && agents.every((agent, index) => agent === snapshot.agents[index])

  return isUnchanged ? snapshot : { ...snapshot, agents }
}

export const normalizeSnapshot = (snapshot: SessionSnapshot): SessionSnapshot => ({
  ...createSnapshot(snapshot),
  ...snapshot,
  contextPercent: snapshot.contextPercent ?? null,
  costUsd: snapshot.costUsd ?? null,
  rateLimits: Array.isArray(snapshot.rateLimits) ? snapshot.rateLimits : [],
  turnHistory: Array.isArray(snapshot.turnHistory) ? snapshot.turnHistory : [],
  agents: snapshot.agents.map(agent => ({ ...agent, endedAt: agent.endedAt ?? null })),
})

export const isSessionSnapshot = (value: unknown): value is SessionSnapshot => {
  if (typeof value !== 'object' || value === null) {
    return false
  }

  const candidate = value as Partial<Record<keyof SessionSnapshot, unknown>>

  return (
    typeof candidate.id === 'string' &&
    typeof candidate.project === 'string' &&
    typeof candidate.updatedAt === 'number' &&
    Array.isArray(candidate.agents) &&
    Array.isArray(candidate.recent) &&
    typeof candidate.usageByModel === 'object'
  )
}

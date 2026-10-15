import type { AgentSnapshot, SessionSnapshot, TokenUsage } from '../types'
import { formatDuration, formatTokens, sessionHealth, shortModel } from './format'
import type { Messages } from './i18n'
import { isActiveAgent } from './snapshot'

export const sessionTitle = (session: SessionSnapshot, ownId: string | null, messages: Messages): string => {
  const branch = session.branch === null ? '' : ` (${session.branch})`
  const own = session.id === ownId ? ` · ${messages.thisSession}` : ''

  return `${session.project}${branch}${own}`
}

export const statusText = (session: SessionSnapshot, now: number, messages: Messages): string => {
  const health = sessionHealth(session, now)

  if (health === 'stale') {
    return messages.since(messages.health.stale, formatDuration(now - session.updatedAt))
  }

  if (health === 'working' && session.turnStartedAt !== null) {
    return messages.since(messages.health.working, formatDuration(now - session.turnStartedAt))
  }

  return messages.health[health]
}

export const activityText = (session: SessionSnapshot): string => {
  const runningAgent = session.agents.find(agent => isActiveAgent(agent) && agent.currentTool !== null)
  const tool = session.currentTool ?? runningAgent?.currentTool ?? null

  return tool === null ? '' : ` · ${tool.tool}: ${tool.summary}`
}

export const agentText = (agent: AgentSnapshot, now: number, messages: Messages): string => {
  const status = messages.agentStatus[agent.status] ?? agent.status
  const tool = agent.currentTool === null ? '' : ` · ${agent.currentTool.tool}: ${agent.currentTool.summary}`
  const elapsed = isActiveAgent(agent) ? ` · ${formatDuration(now - agent.startedAt)}` : ''

  return `${status} · ${agent.type} · ${agent.description} · ${shortModel(agent.model)} · ${messages.toolCount(agent.toolCount)}${elapsed}${tool}`
}

export const usageText = (usage: TokenUsage, messages: Messages): string =>
  [
    `${messages.usage.input} ${formatTokens(usage.input)}`,
    `${messages.usage.output} ${formatTokens(usage.output)}`,
    `${messages.usage.cacheRead} ${formatTokens(usage.cacheRead)}`,
    `${messages.usage.cacheWrite} ${formatTokens(usage.cacheWrite)}`,
  ].join(' · ')

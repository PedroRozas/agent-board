import type { SessionSnapshot } from '../types'
import { formatClock, formatRateLimit, formatSessionCost, formatTokens, latestRateLimits, shortModel, totalUsage } from './format'
import type { Messages } from './i18n'
import { activityText, agentText, sessionTitle, statusText, usageText } from './session-lines'
import { isActiveAgent } from './snapshot'

const RECENT_SHOWN = 12

export const renderBoardText = (
  sessions: readonly SessionSnapshot[],
  now: number,
  ownId: string | null,
  messages: Messages,
): string => {
  const rateLimits = latestRateLimits(sessions, now)
  const planLine =
    rateLimits.length === 0
      ? []
      : [`${messages.plan}: ${rateLimits.map(window => formatRateLimit(window, now, messages)).join(' · ')}`, '']
  const sessionLines = sessions.map((session, index) => {
    const activeAgents = session.agents.filter(isActiveAgent).length
    const output = formatTokens(totalUsage(session.usageByModel).output)

    return [
      `${index + 1}. ${sessionTitle(session, ownId, messages)} — ${statusText(session, now, messages)}${activityText(session)}`,
      `   ${shortModel(session.model)} · ${formatSessionCost(session, messages)} · ${messages.activeAgents(activeAgents)} · ${messages.outputTokens(output)}`,
    ].join('\n')
  })

  return [
    ...planLine,
    messages.activeSessions(sessions.length),
    ...(sessions.length === 0 ? [messages.noSessions] : sessionLines),
    '',
    messages.detailHint,
  ].join('\n')
}

export const renderSessionText = (
  session: SessionSnapshot,
  now: number,
  ownId: string | null,
  messages: Messages,
): string => {
  const usageLines = Object.entries(session.usageByModel).map(
    ([model, usage]) => `  ${shortModel(model)}: ${usageText(usage, messages)}`,
  )
  const agentLines = session.agents.map(agent => `  ${agentText(agent, now, messages)}`)
  const recentLines = session.recent
    .slice(0, RECENT_SHOWN)
    .map(entry => `  ${formatClock(entry.at)} ${entry.isError ? '✗ ' : ''}${entry.agent} · ${entry.tool}: ${entry.summary}`)

  return [
    sessionTitle(session, ownId, messages),
    `${shortModel(session.model)} · ${session.cwd}`,
    `${statusText(session, now, messages)}${activityText(session)}`,
    formatSessionCost(session, messages),
    ...(session.prompt === '' ? [] : [`${messages.request}: ${session.prompt}`]),
    '',
    messages.agentsHeader(session.agents.filter(isActiveAgent).length),
    ...(agentLines.length === 0 ? [`  ${messages.noSubagents}`] : agentLines),
    '',
    messages.tokenUsageHeader(session.turns),
    ...(usageLines.length === 0 ? [`  ${messages.noTurns}`] : usageLines),
    '',
    messages.recentActivity,
    ...(recentLines.length === 0 ? [`  ${messages.noActivity}`] : recentLines),
  ].join('\n')
}

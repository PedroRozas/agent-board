import type { Elements, RenderElement } from 'claude-code'

import type { SessionSnapshot } from '../types'
import {
  HEALTH_COLORS,
  formatClock,
  formatRateLimit,
  formatSessionCost,
  formatTokens,
  latestRateLimits,
  sessionHealth,
  shortModel,
  totalUsage,
} from './format'
import type { Messages } from './i18n'
import { activityText, agentText, sessionTitle, statusText, usageText } from './session-lines'
import { isActiveAgent } from './snapshot'

export type BoardElements = Pick<Elements['terminal'], 'Box' | 'Text' | 'Button'>

const RECENT_SHOWN = 12

export type BoardListProps = {
  elements: BoardElements
  messages: Messages
  sessions: readonly SessionSnapshot[]
  now: number
  ownId: string | null
  onSelect: (sessionId: string) => void
}

export const renderBoardList = ({ elements, messages, sessions, now, ownId, onSelect }: BoardListProps): RenderElement => {
  const { Box, Text, Button } = elements
  const rateLimits = latestRateLimits(sessions, now)

  return (
    <Box flexDirection="column">
      {rateLimits.length > 0 && (
        <Text wrap="truncate-end">
          {messages.plan}: {rateLimits.map(window => formatRateLimit(window, now, messages)).join(' · ')}
        </Text>
      )}
      <Text bold>{messages.activeSessions(sessions.length)}</Text>
      {sessions.length === 0 && <Text dimColor>{messages.noSessions}</Text>}
      {sessions.map(session => {
        const health = sessionHealth(session, now)
        const activeAgents = session.agents.filter(isActiveAgent).length
        const usage = totalUsage(session.usageByModel)

        return (
          <Box key={`session-${session.id}`} flexDirection="column" marginTop={1}>
            <Button
              key={`open-${session.id}`}
              label={sessionTitle(session, ownId, messages)}
              onPress={() => onSelect(session.id)}
            />
            <Text color={HEALTH_COLORS[health]} wrap="truncate-end">
              {statusText(session, now, messages)}
              {activityText(session)}
            </Text>
            <Text dimColor wrap="truncate-end">
              {shortModel(session.model)} · {formatSessionCost(session, messages)} · {messages.activeAgents(activeAgents)} ·{' '}
              {messages.outputTokens(formatTokens(usage.output))}
            </Text>
          </Box>
        )
      })}
    </Box>
  )
}

export type SessionDetailProps = {
  elements: BoardElements
  messages: Messages
  session: SessionSnapshot
  now: number
  ownId: string | null
  onBack: () => void
}

export const renderSessionDetail = ({
  elements,
  messages,
  session,
  now,
  ownId,
  onBack,
}: SessionDetailProps): RenderElement => {
  const { Box, Text, Button } = elements
  const health = sessionHealth(session, now)
  const usageRows = Object.entries(session.usageByModel)

  return (
    <Box flexDirection="column">
      <Button key="back" label={messages.back} onPress={onBack} />
      <Box flexDirection="column" marginTop={1}>
        <Text bold wrap="truncate-end">
          {sessionTitle(session, ownId, messages)}
        </Text>
        <Text dimColor wrap="truncate-end">
          {shortModel(session.model)} · {session.cwd}
        </Text>
        <Text wrap="truncate-end">{formatSessionCost(session, messages)}</Text>
        <Text color={HEALTH_COLORS[health]} wrap="truncate-end">
          {statusText(session, now, messages)}
          {activityText(session)}
        </Text>
        {session.prompt !== '' && (
          <Text dimColor wrap="truncate-end">
            {messages.request}: {session.prompt}
          </Text>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>{messages.agentsHeader(session.agents.filter(isActiveAgent).length)}</Text>
        {session.agents.length === 0 && <Text dimColor>{messages.noSubagents}</Text>}
        {session.agents.map(agent => (
          <Text key={`agent-${agent.id}`} dimColor={!isActiveAgent(agent)} wrap="truncate-end">
            {agentText(agent, now, messages)}
          </Text>
        ))}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>{messages.tokenUsageHeader(session.turns)}</Text>
        {usageRows.length === 0 && <Text dimColor>{messages.noTurns}</Text>}
        {usageRows.map(([model, usage]) => (
          <Text key={`usage-${model}`} wrap="truncate-end">
            {shortModel(model)}: {usageText(usage, messages)}
          </Text>
        ))}
        {usageRows.length > 1 && (
          <Text bold wrap="truncate-end">
            {messages.total}: {usageText(totalUsage(session.usageByModel), messages)}
          </Text>
        )}
      </Box>

      <Box flexDirection="column" marginTop={1}>
        <Text bold>{messages.recentActivity}</Text>
        {session.recent.length === 0 && <Text dimColor>{messages.noActivity}</Text>}
        {session.recent.slice(0, RECENT_SHOWN).map((entry, index) => (
          <Text key={`recent-${index}`} color={entry.isError ? 'error' : 'text'} wrap="truncate-end">
            {formatClock(entry.at)} {entry.agent} · {entry.tool}: {entry.summary}
          </Text>
        ))}
      </Box>
    </Box>
  )
}

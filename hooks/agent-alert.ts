import type { AgentSnapshot } from '../types'

export const STUCK_AFTER_MS = 3 * 60_000
export const FAILING_AFTER_ERRORS = 3

export type AgentAlert =
  | { kind: 'slowTool'; tool: string; elapsedMs: number }
  | { kind: 'quiet'; elapsedMs: number }
  | { kind: 'failing'; errors: number }

export const agentAlert = (agent: AgentSnapshot, now: number): AgentAlert | null => {
  if (agent.status !== 'running') {
    return null
  }

  if (agent.consecutiveErrors >= FAILING_AFTER_ERRORS) {
    return { kind: 'failing', errors: agent.consecutiveErrors }
  }

  if (agent.currentTool !== null) {
    const elapsedMs = now - agent.currentTool.startedAt

    return elapsedMs >= STUCK_AFTER_MS ? { kind: 'slowTool', tool: agent.currentTool.tool, elapsedMs } : null
  }

  const quietMs = now - agent.lastActivityAt

  return quietMs >= STUCK_AFTER_MS ? { kind: 'quiet', elapsedMs: quietMs } : null
}

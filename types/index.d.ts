export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number }

export type ToolActivity = { id: string; tool: string; summary: string; startedAt: number }

export type RateLimitWindow = { kind: string; percentUsed: number; resetsAt: string | null }

export type TurnSpan = { startedAt: number; endedAt: number }

export type ActivityEntry = { at: number; agent: string; tool: string; summary: string; isError: boolean }

export type AgentSnapshot = {
  id: string
  type: string
  description: string
  model: string
  status: string
  startedAt: number
  endedAt: number | null
  currentTool: ToolActivity | null
  toolCount: number
  prompt: string
  answer: string | null
  recent: ActivityEntry[]
  lastActivityAt: number
  consecutiveErrors: number
}

export type SessionSnapshot = {
  id: string
  project: string
  cwd: string
  branch: string | null
  model: string
  startedAt: number
  updatedAt: number
  isWorking: boolean
  turnStartedAt: number | null
  turnHistory: TurnSpan[]
  prompt: string
  currentTool: ToolActivity | null
  agents: AgentSnapshot[]
  usageByModel: Record<string, TokenUsage>
  contextPercent: number | null
  costUsd: number | null
  rateLimits: RateLimitWindow[]
  turns: number
  recent: ActivityEntry[]
}

export type Board = { sessions: SessionSnapshot[]; refreshedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'agent-board': { snapshot: SessionSnapshot | null; board: Board; selectedId: string | null; selectedAgentId: string | null }
  }
}

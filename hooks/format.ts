import type { RateLimitWindow, SessionSnapshot, TokenUsage } from '../types'
import type { Messages } from './i18n'

export const STALE_AFTER_MS = 20_000
export const HIDDEN_AFTER_MS = 10 * 60_000
export const DELETE_AFTER_MS = 24 * 60 * 60_000

export type SessionHealth = 'working' | 'idle' | 'stale'

export const sessionHealth = (session: SessionSnapshot, now: number): SessionHealth => {
  if (now - session.updatedAt > STALE_AFTER_MS) {
    return 'stale'
  }

  return session.isWorking ? 'working' : 'idle'
}

export const HEALTH_COLORS: Readonly<Record<SessionHealth, 'success' | 'subtle' | 'warning'>> = {
  working: 'success',
  idle: 'subtle',
  stale: 'warning',
}

export const formatDuration = (ms: number): string => {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h ${minutes}m`
  }

  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`
}

export const formatTokens = (count: number): string => {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}M`
  }

  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

export const formatClock = (at: number): string => new Date(at).toTimeString().slice(0, 8)

export const totalUsage = (usageByModel: Readonly<Record<string, TokenUsage>>): TokenUsage =>
  Object.values(usageByModel).reduce<TokenUsage>(
    (sum, usage) => ({
      input: sum.input + usage.input,
      output: sum.output + usage.output,
      cacheRead: sum.cacheRead + usage.cacheRead,
      cacheWrite: sum.cacheWrite + usage.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  )

const formatReset = (resetsAt: string | null, now: number, messages: Messages): string => {
  if (resetsAt === null) {
    return ''
  }

  const resetAt = Date.parse(resetsAt)

  return Number.isNaN(resetAt) ? '' : messages.resetsIn(formatDuration(resetAt - now))
}

export const formatRateLimit = (window: RateLimitWindow, now: number, messages: Messages): string =>
  `${messages.rateLimits[window.kind] ?? window.kind} ${window.percentUsed}%${formatReset(window.resetsAt, now, messages)}`

export const formatSessionCost = (session: SessionSnapshot, messages: Messages): string => {
  const context = messages.context(session.contextPercent)
  const cost = session.costUsd === null ? '' : ` · US$ ${session.costUsd.toFixed(2)}`

  return `${context}${cost}`
}

const RATE_LIMIT_ORDER: readonly string[] = ['five_hour', 'seven_day']

const resetTime = (window: RateLimitWindow): number =>
  window.resetsAt === null ? Number.NEGATIVE_INFINITY : Date.parse(window.resetsAt)

const isNewerWindow = (candidate: RateLimitWindow, current: RateLimitWindow): boolean =>
  resetTime(candidate) > resetTime(current) ||
  (resetTime(candidate) === resetTime(current) && candidate.percentUsed > current.percentUsed)

const kindOrder = (kind: string): number => {
  const index = RATE_LIMIT_ORDER.indexOf(kind)

  return index === -1 ? RATE_LIMIT_ORDER.length : index
}

export const latestRateLimits = (sessions: readonly SessionSnapshot[], now: number): RateLimitWindow[] => {
  const byKind = new Map<string, RateLimitWindow>()

  for (const window of sessions.flatMap(session => session.rateLimits)) {
    const current = byKind.get(window.kind)
    const isExpired = window.resetsAt !== null && resetTime(window) <= now

    if (!isExpired && (current === undefined || isNewerWindow(window, current))) {
      byKind.set(window.kind, window)
    }
  }

  return [...byKind.values()].sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind))
}

export const shortModel = (model: string): string => model.replace(/^claude-/, '')

export const sortSessions = (sessions: readonly SessionSnapshot[]): SessionSnapshot[] =>
  [...sessions].sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))

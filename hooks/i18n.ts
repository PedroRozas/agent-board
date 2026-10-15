import type { SessionHealth } from './format'

export type Language = 'es' | 'en'

export type UsageLabels = { input: string; output: string; cacheRead: string; cacheWrite: string }

export type Messages = {
  command: string
  commandDescription: string
  argumentHint: string
  paneTitle: string
  mainAgent: string
  subagent: string
  health: Readonly<Record<SessionHealth, string>>
  agentStatus: Readonly<Record<string, string>>
  rateLimits: Readonly<Record<string, string>>
  since: (label: string, duration: string) => string
  resetsIn: (duration: string) => string
  context: (percent: number | null) => string
  thisSession: string
  plan: string
  activeSessions: (count: number) => string
  noSessions: string
  activeAgents: (count: number) => string
  outputTokens: (tokens: string) => string
  detailHint: string
  missingSession: (position: number) => string
  toolCount: (count: number) => string
  request: string
  agentsHeader: (active: number) => string
  noSubagents: string
  tokenUsageHeader: (turns: number) => string
  noTurns: string
  usage: UsageLabels
  total: string
  recentActivity: string
  noActivity: string
  back: string
  paneOpened: string
  paneDoesNotFit: string
  dashboardOpened: (url: string) => string
  dashboardFailed: (url: string, port: number) => string
  dashboardWithoutBrowser: (url: string, port: number) => string
}

const plural = (count: number, singular: string, many: string): string => `${count} ${count === 1 ? singular : many}`

const SPANISH: Messages = {
  command: 'agentes',
  commandDescription: 'Muestra las sesiones activas, sus agentes y su uso',
  argumentHint: '[web | panel | texto | número de sesión]',
  paneTitle: 'Agentes',
  mainAgent: 'principal',
  subagent: 'subagente',
  health: { working: 'trabajando', idle: 'en espera', stale: 'sin señal' },
  agentStatus: {
    pending: 'en cola',
    running: 'trabajando',
    waiting: 'esperando',
    idle: 'en espera',
    completed: 'terminó',
    failed: 'falló',
    killed: 'detenido',
  },
  rateLimits: { five_hour: 'ventana 5 h', seven_day: 'semana' },
  since: (label, duration) => `${label} hace ${duration}`,
  resetsIn: duration => ` (reinicia en ${duration})`,
  context: percent => (percent === null ? 'contexto —' : `contexto ${Math.round(percent)}%`),
  thisSession: 'esta sesión',
  plan: 'Plan',
  activeSessions: count => `Sesiones activas (${count})`,
  noSessions: 'No hay sesiones con agent-board activo.',
  activeAgents: count => `${count} agentes activos`,
  outputTokens: tokens => `salida ${tokens}`,
  detailHint: 'Detalle de una sesión: /agentes <número>',
  missingSession: position => `No hay una sesión ${position}. Usa /agentes texto para ver la lista.`,
  toolCount: count => plural(count, 'herramienta', 'herramientas'),
  request: 'Pedido',
  agentsHeader: active => `Agentes (${active} activos)`,
  noSubagents: 'Sin subagentes en esta sesión.',
  tokenUsageHeader: turns => `Uso de tokens (${turns} turnos)`,
  noTurns: 'Sin turnos completados.',
  usage: { input: 'entrada', output: 'salida', cacheRead: 'caché leída', cacheWrite: 'caché escrita' },
  total: 'Total',
  recentActivity: 'Actividad reciente',
  noActivity: 'Sin actividad todavía.',
  back: 'Volver',
  paneOpened: 'Panel de agentes abierto.',
  paneDoesNotFit: 'El panel no cabe; ensancha la ventana.',
  dashboardOpened: url => `Dashboard abierto en ${url}`,
  dashboardFailed: (url, port) =>
    `No se pudo iniciar el dashboard en ${url}. Revisa que node esté instalado y el puerto ${port} libre.`,
  dashboardWithoutBrowser: (url, port) =>
    `El dashboard corre en ${url}, pero esta sesión no tiene navegador. Si es remota, conéctate con ssh -L ${port}:127.0.0.1:${port} <servidor> y ábrelo en tu equipo.`,
}

const ENGLISH: Messages = {
  command: 'agent-board',
  commandDescription: 'Shows active sessions, their agents and their usage',
  argumentHint: '[web | panel | text | session number]',
  paneTitle: 'Agents',
  mainAgent: 'main',
  subagent: 'subagent',
  health: { working: 'working', idle: 'idle', stale: 'no signal' },
  agentStatus: {
    pending: 'queued',
    running: 'working',
    waiting: 'waiting',
    idle: 'idle',
    completed: 'done',
    failed: 'failed',
    killed: 'stopped',
  },
  rateLimits: { five_hour: '5-hour window', seven_day: 'week' },
  since: (label, duration) => `${label} for ${duration}`,
  resetsIn: duration => ` (resets in ${duration})`,
  context: percent => (percent === null ? 'context —' : `context ${Math.round(percent)}%`),
  thisSession: 'this session',
  plan: 'Plan',
  activeSessions: count => `Active sessions (${count})`,
  noSessions: 'No sessions are running agent-board.',
  activeAgents: count => plural(count, 'active agent', 'active agents'),
  outputTokens: tokens => `output ${tokens}`,
  detailHint: 'Session detail: /agent-board <number>',
  missingSession: position => `There is no session ${position}. Use /agent-board text to see the list.`,
  toolCount: count => plural(count, 'tool', 'tools'),
  request: 'Request',
  agentsHeader: active => `Agents (${active} active)`,
  noSubagents: 'No subagents in this session.',
  tokenUsageHeader: turns => `Token usage (${plural(turns, 'turn', 'turns')})`,
  noTurns: 'No completed turns yet.',
  usage: { input: 'input', output: 'output', cacheRead: 'cache read', cacheWrite: 'cache write' },
  total: 'Total',
  recentActivity: 'Recent activity',
  noActivity: 'No activity yet.',
  back: 'Back',
  paneOpened: 'Agent board opened.',
  paneDoesNotFit: 'The pane does not fit; widen the window.',
  dashboardOpened: url => `Dashboard opened at ${url}`,
  dashboardFailed: (url, port) =>
    `Could not start the dashboard at ${url}. Check that node is installed and port ${port} is free.`,
  dashboardWithoutBrowser: (url, port) =>
    `The dashboard is running at ${url}, but this session has no browser. If it is remote, connect with ssh -L ${port}:127.0.0.1:${port} <server> and open it on your machine.`,
}

const MESSAGES: Readonly<Record<Language, Messages>> = { es: SPANISH, en: ENGLISH }

export const resolveLanguage = (value: unknown): Language => (value === 'es' ? 'es' : 'en')

export const messagesFor = (language: Language): Messages => MESSAGES[language]

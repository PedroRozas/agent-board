export type Platform = 'macos' | 'linux' | 'windows' | 'other'

export type HostFacts = { platform: Platform; hasDisplay: boolean; isRemote: boolean }

export const DEFAULT_PORT = 4317

const MIN_PORT = 1024
const MAX_PORT = 65_535
const POWERSHELL = ['powershell', '-NoProfile', '-NonInteractive', '-Command'] as const

export const resolvePort = (value: unknown): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= MIN_PORT && value <= MAX_PORT ? value : DEFAULT_PORT

export const platformFromUname = (uname: string): Platform => {
  if (uname === 'Darwin') {
    return 'macos'
  }

  return uname === 'Linux' ? 'linux' : 'other'
}

export const lastPathSegment = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const powershellQuote = (value: string): string => `'${value.replaceAll("'", "''")}'`

export const browserCommand = (facts: HostFacts, url: string): string[] | null => {
  if (facts.isRemote) {
    return null
  }

  switch (facts.platform) {
    case 'macos':
      return ['open', url]
    case 'windows':
      return ['rundll32', 'url.dll,FileProtocolHandler', url]
    case 'linux':
      return facts.hasDisplay ? ['xdg-open', url] : null
    case 'other':
      return null
  }
}

export const dashboardLaunchCommand = (platform: Platform, shell: string, serverPath: string, port: number): string[] =>
  platform === 'windows'
    ? [
        ...POWERSHELL,
        `Start-Process -FilePath node -ArgumentList ${powershellQuote(`"${serverPath}"`)}, '${port}' -WindowStyle Hidden`,
      ]
    : [shell, '-lc', `nohup node ${shellQuote(serverPath)} ${port} >/dev/null 2>&1 &`]

export const removeFilesCommand = (platform: Platform, paths: readonly string[]): string[] =>
  platform === 'windows'
    ? [
        ...POWERSHELL,
        `Remove-Item -LiteralPath ${paths.map(powershellQuote).join(', ')} -Force -ErrorAction SilentlyContinue`,
      ]
    : ['rm', '-f', ...paths]

export const moveFileCommand = (platform: Platform, from: string, to: string): string[] =>
  platform === 'windows'
    ? [
        ...POWERSHELL,
        `Move-Item -LiteralPath ${powershellQuote(from)} -Destination ${powershellQuote(to)} -Force -ErrorAction Stop`,
      ]
    : ['mv', '-f', from, to]

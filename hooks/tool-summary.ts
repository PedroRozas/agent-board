import { lastPathSegment } from './platform'

const SUMMARY_LIMIT = 90

const readString = (args: Readonly<Record<string, unknown>>, key: string): string | null => {
  const value = args[key]

  return typeof value === 'string' && value.length > 0 ? value : null
}

const singleLine = (text: string): string => text.replace(/\s+/g, ' ').trim().slice(0, SUMMARY_LIMIT)

export const summarizeTool = (tool: string, args: Readonly<Record<string, unknown>>): string => {
  const filePath = readString(args, 'file_path') ?? readString(args, 'notebook_path')

  if (filePath !== null) {
    return lastPathSegment(filePath)
  }

  const detail =
    readString(args, 'command') ??
    readString(args, 'description') ??
    readString(args, 'pattern') ??
    readString(args, 'skill') ??
    readString(args, 'url') ??
    readString(args, 'query') ??
    readString(args, 'prompt')

  return detail === null ? tool : singleLine(detail)
}

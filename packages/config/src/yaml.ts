import { ConfigError } from './errors.js'

export interface ParsedYaml {
  value: Record<string, unknown>
  /** Dot-path ("endpoints.deepseek.baseURL") -> 1-based source line. */
  lines: Map<string, number>
}

interface YamlLine {
  no: number
  indent: number
  text: string
}

const KEY_PATTERN = /^[A-Za-z0-9_.-]+$/

/**
 * Phase 0 YAML subset: nested block maps, block sequences of inline values,
 * flow collections `[...]` / `{...}`, single/double-quoted and plain scalars,
 * booleans, numbers, one-line `#` comments. Anything else fails loud with a
 * line number. Full YAML is a Phase 2 decision.
 */
export function parseYaml(text: string, source: string): ParsedYaml {
  const lines = preprocess(text, source)
  const pathLines = new Map<string, number>()
  if (lines.length === 0) return { value: {}, lines: pathLines }
  const state = { cursor: 0, lines, source, pathLines }
  const value = parseBlock(state, lines[0]!.indent, '')
  if (state.cursor < lines.length) {
    fail(source, lines[state.cursor]!.no, `unexpected content: ${lines[state.cursor]!.text}`)
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    fail(source, lines[0]!.no, 'top level must be a mapping')
  }
  return { value: value as Record<string, unknown>, lines: pathLines }
}

function preprocess(text: string, source: string): YamlLine[] {
  const out: YamlLine[] = []
  const rawLines = text.split('\n')
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!.replace(/\r$/, '')
    if (raw.startsWith('---') || raw.startsWith('...') || raw.startsWith('%YAML')) {
      fail(source, i + 1, 'multiple documents are not supported (Phase 0 subset)')
    }
    if (/^\s*\t/.test(raw) || /^ \t/.test(raw)) {
      fail(source, i + 1, 'tabs are not allowed for indentation')
    }
    const content = stripComment(raw).trimEnd()
    if (content.trim() === '') continue
    const indent = content.length - content.trimStart().length
    out.push({ no: i + 1, indent, text: content.trim() })
  }
  return out
}

function stripComment(raw: string): string {
  let quote: string | undefined
  let depth = 0
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === '#' && depth === 0 && (i === 0 || raw[i - 1] === ' ' || raw[i - 1] === '\t')) {
      return raw.slice(0, i)
    }
  }
  return raw
}

interface ParseState {
  cursor: number
  lines: YamlLine[]
  source: string
  pathLines: Map<string, number>
}

function parseBlock(state: ParseState, indent: number, path: string): unknown {
  const line = state.lines[state.cursor]!
  if (line.text === '-' || line.text.startsWith('- ')) {
    return parseSequence(state, indent, path)
  }
  return parseMap(state, indent, path)
}

function parseMap(state: ParseState, indent: number, path: string): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  const { lines, source } = state
  while (state.cursor < lines.length) {
    const line = lines[state.cursor]!
    if (line.indent < indent) break
    if (line.indent > indent) fail(source, line.no, `unexpected indentation: ${line.text}`)
    if (line.text === '-' || line.text.startsWith('- ')) break
    const splitAt = findKeyColon(line.text)
    if (splitAt < 0) fail(source, line.no, `expected "key: value", got: ${line.text}`)
    const key = line.text.slice(0, splitAt).trim()
    if (!KEY_PATTERN.test(key)) fail(source, line.no, `unsupported key syntax: ${key}`)
    const rest = line.text.slice(splitAt + 1).trim()
    const childPath = path + key
    state.pathLines.set(childPath, line.no)
    state.cursor++
    if (rest !== '') {
      if (rest === '|' || rest === '>') fail(source, line.no, `block scalars (${rest}) are not supported (Phase 0 subset)`)
      result[key] = parseInline(state, rest, line.no)
      continue
    }
    const next = lines[state.cursor]
    if (next && next.indent > indent) {
      result[key] = parseBlock(state, next.indent, childPath + '.')
    } else if (next && next.indent === indent && (next.text === '-' || next.text.startsWith('- '))) {
      // Block sequences may sit at the same indentation as their parent key.
      result[key] = parseSequence(state, indent, childPath + '.')
    } else {
      result[key] = {}
    }
  }
  return result
}

function parseSequence(state: ParseState, indent: number, path: string): unknown[] {
  const result: unknown[] = []
  const { lines, source } = state
  while (state.cursor < lines.length) {
    const line = lines[state.cursor]!
    if (line.indent < indent) break
    if (line.indent > indent) fail(source, line.no, `unexpected indentation: ${line.text}`)
    if (line.text !== '-' && !line.text.startsWith('- ')) break
    const itemText = line.text === '-' ? '' : line.text.slice(2).trim()
    state.cursor++
    if (itemText === '') {
      const next = lines[state.cursor]
      if (next && next.indent > indent) {
        result.push(parseBlock(state, next.indent, path))
      } else {
        result.push(null)
      }
      continue
    }
    if (findKeyColon(itemText) >= 0 && !startsWithCollectionOrQuote(itemText)) {
      fail(source, line.no, 'block mappings inside sequences are not supported (Phase 0 subset); use inline {..}')
    }
    state.pathLines.set(`${path}${result.length}`, line.no)
    result.push(parseInline(state, itemText, line.no))
  }
  return result
}

function startsWithCollectionOrQuote(text: string): boolean {
  const first = text[0]
  return first === '[' || first === '{' || first === "'" || first === '"'
}

function parseInline(state: ParseState, text: string, lineNo: number): unknown {
  const { source } = state
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) fail(source, lineNo, `unbalanced "[" in: ${text}`)
    const inner = text.slice(1, -1).trim()
    if (inner === '') return []
    return splitTopLevel(state, inner, ',', lineNo).map((part) => parseInline(state, part.trim(), lineNo))
  }
  if (text.startsWith('{')) {
    if (!text.endsWith('}')) fail(source, lineNo, `unbalanced "{" in: ${text}`)
    const inner = text.slice(1, -1).trim()
    const map: Record<string, unknown> = {}
    if (inner === '') return map
    for (const part of splitTopLevel(state, inner, ',', lineNo)) {
      const segment = part.trim()
      const at = findKeyColon(segment)
      if (at <= 0) fail(source, lineNo, `expected "key: value" inside {..}, got: ${segment}`)
      const key = segment.slice(0, at).trim()
      if (!KEY_PATTERN.test(key)) fail(source, lineNo, `unsupported key syntax: ${key}`)
      map[key] = parseInline(state, segment.slice(at + 1).trim(), lineNo)
    }
    return map
  }
  if (text.startsWith('"')) {
    try {
      return JSON.parse(text) as unknown
    } catch {
      fail(source, lineNo, `invalid double-quoted string: ${text}`)
    }
  }
  if (text.startsWith("'")) {
    if (text.length < 2 || !text.endsWith("'")) fail(source, lineNo, `unbalanced single quote: ${text}`)
    return text.slice(1, -1).replace(/''/g, "'")
  }
  if (text === 'true') return true
  if (text === 'false') return false
  if (text === 'null' || text === '~') return null
  if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(text)) return Number(text)
  if (/^[&*|>@`%!]/.test(text)) fail(source, lineNo, `unsupported YAML syntax near: ${text}`)
  if (findKeyColon(text) >= 0) fail(source, lineNo, `plain scalar contains ": " — quote it: ${text}`)
  return text
}

function splitTopLevel(state: ParseState, text: string, separator: string, lineNo: number): string[] {
  const parts: string[] = []
  let quote: string | undefined
  let depth = 0
  let current = ''
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    if (ch === separator && depth === 0) {
      parts.push(current)
      current = ''
      continue
    }
    current += ch
  }
  if (quote || depth !== 0) fail(state.source, lineNo, `unbalanced quotes or brackets in: ${text}`)
  if (current.trim() !== '') parts.push(current)
  return parts
}

/** Index of the key/value separating ':' (end of string or followed by a space), or -1. */
function findKeyColon(text: string): number {
  let quote: string | undefined
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quote) {
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === "'" || ch === '"') quote = ch
    else if (ch === '[' || ch === '{') depth++
    else if (ch === ']' || ch === '}') depth--
    else if (ch === ':' && depth === 0 && (i + 1 === text.length || text[i + 1] === ' ')) return i
  }
  return -1
}

function fail(source: string, line: number, message: string): never {
  throw new ConfigError('CONFIG_PARSE', message, { path: source, line })
}

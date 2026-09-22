import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

/** Total rendered baseline budget (dsh `context.agent-instructions.maxBytes`). */
export const INSTRUCTION_BUDGET_BYTES = 65_536

/** Per-file read cap: anything larger is skipped outright (dsh `maxSourceBytes`). */
export const MAX_INSTRUCTION_SOURCE_BYTES = 1_048_576

const INSTRUCTION_CANDIDATES = ['AGENTS.md', 'CLAUDE.md'] as const

const AGENT_INSTRUCTIONS_INTRO =
  'The following workspace instructions may be relevant to your work. ' +
  'Use them as guidance when applicable. More specific instructions take precedence over broader ones. ' +
  'They do not override system, developer, or direct user instructions.'
const COMPACT_AGENT_INSTRUCTIONS_INTRO =
  'Workspace instructions were omitted or truncated to fit the configured byte budget.'

export interface TruncatedInstruction {
  file: string
  from: number
  to: number
}

export interface LoadedAgentInstructions {
  /** Complete `<system-reminder>` framing; empty when nothing was loaded. */
  content: string
  /** Display paths dropped whole to fit the budget. */
  omitted: string[]
  /** Set when even the most specific file alone had to be truncated. */
  truncated: TruncatedInstruction | undefined
}

interface InstructionFile {
  absolutePath: string
  displayPath: string
}

interface LoadedInstructionFile extends InstructionFile {
  content: string
}

function bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

function instructionContentSha1(content: string): string {
  return createHash('sha1').update(content).digest('hex')
}

/** Cut UTF-8 at a byte boundary that never splits a code point. */
function truncateUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, 'utf8')
  if (buffer.length <= maxBytes) return value
  let end = Math.max(0, Math.trunc(maxBytes))
  while (end > 0 && (buffer.readUInt8(end) & 0xc0) === 0x80) end -= 1
  return buffer.subarray(0, end).toString('utf8')
}

/** dsh: a `</system-reminder>` inside file content must not close the frame. */
function escapeFrameBody(body: string): string {
  return body.replaceAll('</system-reminder>', '<\\/system-reminder>')
}

/** Inclusive root→cwd directory chain, broadest first. */
function ancestorChain(root: string, cwd: string): string[] {
  const chain: string[] = []
  let current = resolve(cwd)
  const resolvedRoot = resolve(root)
  while (current !== resolvedRoot) {
    chain.push(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  chain.push(resolvedRoot)
  return chain.reverse()
}

function discoverInstructionFiles(projectRoot: string, cwd: string): InstructionFile[] {
  const files: InstructionFile[] = []
  const seen = new Set<string>()
  const add = (file: InstructionFile): void => {
    if (seen.has(file.absolutePath)) return
    seen.add(file.absolutePath)
    files.push(file)
  }

  const userGlobal = join(homedir(), '.shuttle', 'AGENTS.md')
  if (isRegularFile(userGlobal)) {
    add({ absolutePath: userGlobal, displayPath: join('~', '.shuttle', 'AGENTS.md') })
  }

  for (const dir of ancestorChain(projectRoot, cwd)) {
    for (const candidate of INSTRUCTION_CANDIDATES) {
      const path = join(dir, candidate)
      if (isRegularFile(path)) {
        add({ absolutePath: path, displayPath: relative(projectRoot, path) })
      }
    }
  }
  return files
}

function isRegularFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** dsh `readBounded`: over-sized files never enter the baseline. */
function readBounded(file: InstructionFile): string | undefined {
  try {
    if (statSync(file.absolutePath).size > MAX_INSTRUCTION_SOURCE_BYTES) return undefined
    return readFileSync(file.absolutePath, 'utf8')
  } catch {
    return undefined
  }
}

/** Same content in one directory collapses to its first occurrence (dsh per-dir dedup). */
function dedupeByDirectory(files: LoadedInstructionFile[]): LoadedInstructionFile[] {
  const keptDigestsByDir = new Map<string, Set<string>>()
  const kept: LoadedInstructionFile[] = []
  for (const file of files) {
    const dir = dirname(file.displayPath)
    let digests = keptDigestsByDir.get(dir)
    if (!digests) {
      digests = new Set()
      keptDigestsByDir.set(dir, digests)
    }
    const digest = instructionContentSha1(file.content.trim())
    if (digests.has(digest)) continue
    digests.add(digest)
    kept.push(file)
  }
  return kept
}

function sectionText(file: LoadedInstructionFile): string {
  return `Instructions from: ${file.displayPath}\n\n${file.content}`
}

function markerText(maxBytes: number, omitted: string[], truncated: TruncatedInstruction | undefined): string {
  if (omitted.length === 0 && !truncated) return ''
  const parts: string[] = []
  if (omitted.length > 0) parts.push(`omitted ${omitted.join(', ')}`)
  if (truncated) parts.push(`truncated ${truncated.file} from ${truncated.from} to ${truncated.to} bytes`)
  return `Workspace instruction budget ${maxBytes} bytes: ${parts.join('; ')}`
}

function buildInstructionText(
  files: LoadedInstructionFile[],
  maxBytes: number,
  omitted: string[],
  truncated: TruncatedInstruction | undefined,
  intro: string,
): string {
  const marker = markerText(maxBytes, omitted, truncated)
  const body = [marker, intro, ...files.map(sectionText)].filter((block) => block.length > 0)
  return ['<system-reminder>', escapeFrameBody(body.join('\n\n')), '</system-reminder>'].join('\n')
}

function withTruncatedContent(file: LoadedInstructionFile, includedBytes: number): LoadedInstructionFile {
  return { ...file, content: truncateUtf8(file.content, includedBytes) }
}

/** Binary-search the most specific file's content so the framed text fits. */
function truncateToFit(
  file: LoadedInstructionFile,
  maxBytes: number,
  omitted: string[],
  intro: string,
): LoadedInstructionFile {
  const originalBytes = bytes(file.content)
  let low = 0
  let high = originalBytes
  let best = withTruncatedContent(file, 0)
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const candidate = withTruncatedContent(file, mid)
    const text = buildInstructionText(
      [candidate],
      maxBytes,
      omitted,
      { file: file.displayPath, from: originalBytes, to: bytes(candidate.content) },
      intro,
    )
    if (bytes(text) <= maxBytes) {
      best = candidate
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return best
}

/**
 * dsh `renderAgentInstructions` for the baseline chain: render everything;
 * when over budget drop the broadest files whole; when only the most specific
 * file remains, binary-truncate it. The budget notice is part of the content
 * (the visible notification) and is also reported structurally.
 */
export function loadAgentInstructions(projectRoot: string, cwd: string): LoadedAgentInstructions {
  const loaded: LoadedInstructionFile[] = []
  for (const file of discoverInstructionFiles(projectRoot, cwd)) {
    const content = readBounded(file)
    if (content !== undefined) loaded.push({ ...file, content })
  }
  const files = dedupeByDirectory(loaded)
  if (files.length === 0) return { content: '', omitted: [], truncated: undefined }

  const full = buildInstructionText(files, INSTRUCTION_BUDGET_BYTES, [], undefined, AGENT_INSTRUCTIONS_INTRO)
  if (bytes(full) <= INSTRUCTION_BUDGET_BYTES) {
    return { content: full, omitted: [], truncated: undefined }
  }

  for (let start = 1; start < files.length; start += 1) {
    const included = files.slice(start)
    const omitted = files.slice(0, start).map((file) => file.displayPath)
    const text = buildInstructionText(included, INSTRUCTION_BUDGET_BYTES, omitted, undefined, AGENT_INSTRUCTIONS_INTRO)
    if (bytes(text) <= INSTRUCTION_BUDGET_BYTES) {
      return { content: text, omitted, truncated: undefined }
    }
  }

  const mostSpecific = files[files.length - 1]!
  const omitted = files.slice(0, -1).map((file) => file.displayPath)
  const originalBytes = bytes(mostSpecific.content)
  for (const intro of [AGENT_INSTRUCTIONS_INTRO, COMPACT_AGENT_INSTRUCTIONS_INTRO]) {
    const truncatedFile = truncateToFit(mostSpecific, INSTRUCTION_BUDGET_BYTES, omitted, intro)
    const includedBytes = bytes(truncatedFile.content)
    const truncated: TruncatedInstruction = { file: mostSpecific.displayPath, from: originalBytes, to: includedBytes }
    const text = buildInstructionText([truncatedFile], INSTRUCTION_BUDGET_BYTES, omitted, truncated, intro)
    if (bytes(text) <= INSTRUCTION_BUDGET_BYTES) {
      return { content: text, omitted, truncated }
    }
  }

  // Marker alone exceeds the budget: ship the notice truncated to the byte cap.
  const truncated: TruncatedInstruction = { file: mostSpecific.displayPath, from: originalBytes, to: 0 }
  const notice = escapeFrameBody(markerText(INSTRUCTION_BUDGET_BYTES, omitted, truncated))
  const framed = ['<system-reminder>', notice, '</system-reminder>'].join('\n')
  const content = bytes(framed) <= INSTRUCTION_BUDGET_BYTES ? framed : truncateUtf8(framed, INSTRUCTION_BUDGET_BYTES)
  return { content, omitted, truncated }
}

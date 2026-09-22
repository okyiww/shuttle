import type { IncomingMessage, ServerResponse } from 'node:http'
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SessionEvent } from '@shuttle/session'
import { findProjectRoot, isSkillName, parseFrontmatter, shuttleDir } from '@shuttle/memory'
import { resolveChatTarget } from './chat.js'
import { HttpError, readJsonBody, sendError, sendJson } from './http-utils.js'
import { isValidSessionId, readSessionEvents } from './session-index.js'
import type { ApiState } from './state.js'

const ENTRY_MAX_CHARS = 2_000
const TRANSCRIPT_BUDGET_CHARS = 30_000
const DISTILL_MAX_TOKENS = 2_048

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

/** user/assistant content + tool call name/args + result summary, one line each. */
function buildTranscript(events: SessionEvent[], header?: string): { text: string; used: boolean } {
  const lines: string[] = []
  if (header) lines.push(header)
  let total = 0
  let wrote = false
  const push = (line: string): void => {
    const cost = line.length + 1
    if (total + cost > TRANSCRIPT_BUDGET_CHARS) return
    total += cost
    lines.push(line)
    wrote = true
  }
  for (const event of events) {
    if (event.type === 'user/message') {
      push(`[user] ${clip(event.message.content, ENTRY_MAX_CHARS)}`)
    } else if (event.type === 'assistant/message') {
      push(`[assistant] ${clip(event.message.content, ENTRY_MAX_CHARS)}`)
      if (event.message.role === 'assistant') {
        for (const call of event.message.toolCalls ?? []) {
          push(`[tool-call] ${call.name}(${clip(call.arguments, 500)})`)
        }
      }
    } else if (event.type === 'tool/result') {
      push(`[tool-result] ${clip(event.content, ENTRY_MAX_CHARS)}`)
    }
  }
  if (total >= TRANSCRIPT_BUDGET_CHARS) push('(transcript truncated by budget)')
  return { text: lines.join('\n'), used: wrote }
}

const SKILL_DISTILL_PROMPT = [
  '你是会话经验沉淀助手。阅读以下会话记录，提炼出一个可复用的 skill（任务操作手册）。',
  '直接输出最终 markdown，不要任何多余解释、前后缀或代码块围栏。',
  '',
  '输出格式（严格遵守）：',
  '--- 开头的 YAML frontmatter，只含两个标量字段：',
  'name: <kebab-case 名字，小写字母数字和连字符>',
  'description: <一句话说明什么时候用这个 skill>',
  '---',
  '',
  '正文必须依次包含以下小节：',
  '## 适用场景',
  '## 从 0 到 1 的步骤',
  '## 踩坑与规避',
  '## 关联资源',
].join('\n')

const NOTE_DISTILL_PROMPT = [
  '你是会话经验沉淀助手。阅读以下会话记录，提炼出一份实现笔记（agent note）。',
  '直接输出最终 markdown，不要任何多余解释、前后缀或代码块围栏。',
  '',
  '输出格式（严格遵守）：',
  '第一行：# Agent Note: <标题>',
  '空一行后：Status: implemented — 从会话沉淀',
  '',
  '正文必须依次包含以下小节：',
  '## Problem',
  '## Decision',
  '## Alternatives considered',
  '## Consequences',
  '## 关键过程',
].join('\n')

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
  return slug
}

function suggestedSkillPath(markdown: string): string {
  const name = parseFrontmatter(markdown)?.data.name
  if (name && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    return `.shuttle/skills/${name}/SKILL.md`
  }
  return `.shuttle/skills/distilled-${today()}.md`
}

function suggestedNotePath(markdown: string): string {
  const title = /^#\s*Agent Note:\s*(.+)$/m.exec(markdown)?.[1]?.trim()
  const slug = title ? slugify(title) : ''
  return `.shuttle/notes/implemented/process/${today()}-${slug || 'session-note'}.md`
}

interface DistillBody {
  target?: string
  /** 多会话沉淀：至少 1 个会话 id；缺省时用路径上的 :id。 */
  sessionIds?: unknown
}

async function distillCore(state: ApiState, ids: string[], targetKind: 'note' | 'skill', res: ServerResponse): Promise<void> {
  const parts: string[] = []
  for (let i = 0; i < ids.length; i++) {
    const detail = readSessionEvents(ids[i]!)
    if (!detail) {
      sendError(res, 404, `session not found: ${ids[i]}`)
      return
    }
    const header = ids.length > 1 ? `===== 会话 ${i + 1}（${ids[i]!.slice(0, 8)}） =====` : undefined
    const { text, used } = buildTranscript(detail.events, header)
    if (used) parts.push(text)
  }
  const transcript = parts.join('\n\n')
  if (transcript.trim() === '') {
    sendError(res, 400, 'sessions have no distillable content')
    return
  }
  const target = resolveChatTarget(state.loaded.config, {})
  let markdown = ''
  try {
    for await (const chunk of state.llm.stream({
      provider: target.endpointName,
      model: target.model,
      messages: [
        { role: 'system', content: targetKind === 'skill' ? SKILL_DISTILL_PROMPT : NOTE_DISTILL_PROMPT },
        { role: 'user', content: `会话记录：\n\n${transcript}` },
      ],
      maxTokens: DISTILL_MAX_TOKENS,
      purpose: 'distill',
    })) {
      if (chunk.type === 'text-delta') markdown += chunk.delta
    }
  } catch (error) {
    sendError(res, 502, error instanceof Error ? error.message : String(error))
    return
  }
  markdown = markdown.trim()
  if (markdown === '') {
    sendError(res, 502, 'model returned empty markdown')
    return
  }
  sendJson(res, 200, {
    suggestedPath: targetKind === 'skill' ? suggestedSkillPath(markdown) : suggestedNotePath(markdown),
    markdown,
  })
}

function parseTarget(raw: unknown): 'note' | 'skill' | undefined {
  return raw === 'note' || raw === 'skill' ? raw : undefined
}

/**
 * POST /api/sessions/:id/distill — single-session distill (kept for compat;
 * the frontend uses the collection route below).
 */
export async function handleDistill(
  req: IncomingMessage,
  res: ServerResponse,
  state: ApiState,
  id: string,
): Promise<void> {
  if (!isValidSessionId(id)) {
    sendError(res, 400, `invalid session id: ${id}`)
    return
  }
  const raw = (await readJsonBody(req)) as DistillBody
  const targetKind = parseTarget(raw.target)
  if (!targetKind) {
    sendError(res, 400, `target must be 'note' | 'skill'`)
    return
  }
  await distillCore(state, [id], targetKind, res)
}

/**
 * POST /api/sessions/distill — distill one OR many sessions: body
 * `{ target, sessionIds: string[] }`. Multi-session transcripts are merged
 * with separators so the model sees them as one continuous analysis material.
 */
export async function handleSessionsDistill(
  req: IncomingMessage,
  res: ServerResponse,
  state: ApiState,
): Promise<void> {
  const raw = (await readJsonBody(req)) as DistillBody
  const targetKind = parseTarget(raw.target)
  if (!targetKind) {
    sendError(res, 400, `target must be 'note' | 'skill'`)
    return
  }
  if (!Array.isArray(raw.sessionIds) || raw.sessionIds.length === 0) {
    sendError(res, 400, 'sessionIds must be a non-empty array')
    return
  }
  if (raw.sessionIds.length > 10) {
    sendError(res, 400, 'at most 10 sessions per distill')
    return
  }
  const ids: string[] = []
  for (const id of raw.sessionIds) {
    if (typeof id !== 'string' || !isValidSessionId(id)) {
      sendError(res, 400, `invalid session id: ${String(id)}`)
      return
    }
    ids.push(id)
  }
  await distillCore(state, ids, targetKind, res)
}

interface MemoryWriteBody {
  path?: string
  content?: string
}

/** Export for tests / direct reuse: resolve-and-validate a memory write path. */
export function resolveMemoryWritePath(projectRoot: string, rawPath: unknown): string {
  if (typeof rawPath !== 'string' || rawPath.trim() === '') {
    throw new HttpError(400, 'path must be a non-empty string')
  }
  if (isAbsolute(rawPath)) {
    throw new HttpError(400, 'absolute paths are not allowed')
  }
  const root = resolve(shuttleDir(projectRoot))
  const resolved = resolve(projectRoot, rawPath)
  if (resolved !== root && !resolved.startsWith(root + sep)) {
    throw new HttpError(400, `path must stay within .shuttle (got: ${rawPath})`)
  }
  if (!resolved.endsWith('.md')) {
    throw new HttpError(400, 'path must end with .md')
  }
  return resolved
}

/**
 * POST /api/memory/write — persist an edited distill draft. The path must
 * resolve inside `<projectRoot>/.shuttle` (no `..` escapes, no absolute
 * paths, `.md` only); parent directories are created.
 */
export async function handleMemoryWrite(
  req: IncomingMessage,
  res: ServerResponse,
  cwd: string,
): Promise<void> {
  const raw = (await readJsonBody(req)) as MemoryWriteBody
  if (typeof raw.content !== 'string') {
    sendError(res, 400, 'content must be a string')
    return
  }
  let file: string
  try {
    file = resolveMemoryWritePath(findProjectRoot(cwd), raw.path)
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message)
      return
    }
    throw error
  }
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, raw.content, 'utf8')
  sendJson(res, 200, { ok: true, path: raw.path })
}

/** GET /api/skills — catalog for the Memory tab (project + user-global). */
export function handleListSkills(res: ServerResponse, state: ApiState): void {
  sendJson(res, 200, state.skills.catalog())
}

/** GET /api/skills/:name — full SKILL.md content for viewing. */
export function handleSkillContent(res: ServerResponse, state: ApiState, name: string): void {
  if (!isSkillName(name)) {
    sendError(res, 400, `invalid skill name: ${name}`)
    return
  }
  const content = state.skills.get(name)
  if (content === undefined) {
    sendError(res, 404, `skill not found: ${name}`)
    return
  }
  sendJson(res, 200, { name, content })
}

export interface NoteSummary {
  /** Project-relative posix path, e.g. `.shuttle/notes/implemented/process/x.md`. */
  path: string
  title: string
  /** First path segment under notes/ (proposed / implemented / rejected / …). */
  lifecycle: string
  updatedAt: string
}

function scanNotes(projectRoot: string): NoteSummary[] {
  const notesRoot = join(shuttleDir(projectRoot), 'notes')
  const out: NoteSummary[] = []
  const walk = (dir: string): void => {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.md')) continue
      let content: string
      try {
        content = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      out.push({
        path: relative(projectRoot, full).split(sep).join('/'),
        title: /^#\s+(.+)$/m.exec(content)?.[1]?.trim() ?? entry.name,
        lifecycle: relative(notesRoot, full).split(sep)[0] ?? '',
        updatedAt: statSync(full).mtime.toISOString(),
      })
    }
  }
  walk(notesRoot)
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** GET /api/notes — every note under `.shuttle/notes`, newest first. */
export function handleListNotes(res: ServerResponse, cwd: string): void {
  sendJson(res, 200, scanNotes(findProjectRoot(cwd)))
}

/** GET /api/memory/read?path=… — validated read for note viewing. */
export function handleMemoryRead(req: IncomingMessage, res: ServerResponse, cwd: string): void {
  const rawPath = new URL(req.url ?? '', 'http://localhost').searchParams.get('path')
  let file: string
  try {
    file = resolveMemoryWritePath(findProjectRoot(cwd), rawPath)
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message)
      return
    }
    throw error
  }
  if (!existsSync(file)) {
    sendError(res, 404, `not found: ${String(rawPath)}`)
    return
  }
  sendJson(res, 200, { path: rawPath, content: readFileSync(file, 'utf8') })
}

/** DELETE /api/memory?path=… — delete a note file (validated like writes). */
export function handleMemoryDelete(req: IncomingMessage, res: ServerResponse, cwd: string): void {
  const rawPath = new URL(req.url ?? '', 'http://localhost').searchParams.get('path')
  let file: string
  try {
    file = resolveMemoryWritePath(findProjectRoot(cwd), rawPath)
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message)
      return
    }
    throw error
  }
  if (!existsSync(file)) {
    sendError(res, 404, `not found: ${String(rawPath)}`)
    return
  }
  rmSync(file, { force: true })
  sendJson(res, 200, { ok: true, path: rawPath })
}

interface SkillWriteBody {
  content?: string
  /** Set when renaming: the previously loaded skill name, cleaned up after write. */
  previousName?: string
}

/**
 * PUT /api/skills — upsert a skill by the frontmatter `name` inside the content
 * (project-level `.shuttle/skills/<name>/SKILL.md` when new). `previousName`
 * removes the old file after a rename.
 */
export async function handleSkillWrite(
  req: IncomingMessage,
  res: ServerResponse,
  state: ApiState,
): Promise<void> {
  const raw = (await readJsonBody(req)) as SkillWriteBody
  if (typeof raw.content !== 'string' || raw.content.trim() === '') {
    sendError(res, 400, 'content must be a non-empty string')
    return
  }
  const name = parseFrontmatter(raw.content)?.data.name
  if (!name || !isSkillName(name)) {
    sendError(res, 400, 'frontmatter needs a valid kebab-case `name`')
    return
  }
  const existing = state.skills.resolveFile(name)
  const file = existing?.path ?? state.skills.defaultPath(name)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, raw.content, 'utf8')
  if (raw.previousName && raw.previousName !== name && isSkillName(raw.previousName)) {
    const previous = state.skills.resolveFile(raw.previousName)
    if (previous) rmSync(previous.bundle ? dirname(previous.path) : previous.path, { recursive: true, force: true })
  }
  sendJson(res, 200, { ok: true, name })
}

/** DELETE /api/skills/:name — remove a skill (bundle dir or flat file). */
export function handleSkillDelete(res: ServerResponse, state: ApiState, name: string): void {
  if (!isSkillName(name)) {
    sendError(res, 400, `invalid skill name: ${name}`)
    return
  }
  const resolved = state.skills.resolveFile(name)
  if (!resolved) {
    sendError(res, 404, `skill not found: ${name}`)
    return
  }
  rmSync(resolved.bundle ? dirname(resolved.path) : resolved.path, { recursive: true, force: true })
  sendJson(res, 200, { ok: true, name })
}

const PROMOTE_PROMPT = [
  '你是经验提炼助手。把下面的 Agent Note（决策/经验记录）重构成一个模型可直接加载执行的 SKILL.md。',
  '直接输出最终 markdown，不要任何多余解释、前后缀或代码块围栏。',
  '',
  '输出格式（严格遵守）：',
  '--- 开头的 YAML frontmatter，只含两个标量字段：',
  'name: <kebab-case 名字，小写字母数字和连字符>',
  'description: <一句话说明什么时候用这个 skill>',
  '---',
  '',
  '正文必须依次包含以下小节：',
  '## 适用场景',
  '## 从 0 到 1 的步骤',
  '## 踩坑与规避',
  '## 关联资源',
].join('\n')

/**
 * POST /api/memory/promote {path} — restructure a note into a SKILL.md draft
 * via the default endpoint's LLM. Nothing is persisted; the frontend opens
 * the result as a new skill draft for editing/saving.
 */
export async function handleMemoryPromote(
  req: IncomingMessage,
  res: ServerResponse,
  state: ApiState,
  cwd: string,
): Promise<void> {
  const raw = (await readJsonBody(req)) as { path?: string }
  let file: string
  try {
    file = resolveMemoryWritePath(findProjectRoot(cwd), raw.path)
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.status, error.message)
      return
    }
    throw error
  }
  if (!existsSync(file)) {
    sendError(res, 404, `not found: ${String(raw.path)}`)
    return
  }
  const note = readFileSync(file, 'utf8')
  const target = resolveChatTarget(state.loaded.config, {})
  let markdown = ''
  try {
    for await (const chunk of state.llm.stream({
      provider: target.endpointName,
      model: target.model,
      messages: [
        { role: 'system', content: PROMOTE_PROMPT },
        { role: 'user', content: `Agent Note 内容：\n\n${clip(note, TRANSCRIPT_BUDGET_CHARS)}` },
      ],
      maxTokens: DISTILL_MAX_TOKENS,
      purpose: 'distill',
    })) {
      if (chunk.type === 'text-delta') markdown += chunk.delta
    }
  } catch (error) {
    sendError(res, 502, error instanceof Error ? error.message : String(error))
    return
  }
  markdown = markdown.trim()
  if (markdown === '') {
    sendError(res, 502, 'model returned empty markdown')
    return
  }
  sendJson(res, 200, { markdown })
}

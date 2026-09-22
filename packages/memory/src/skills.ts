import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { shuttleDir } from './paths.js'

/** dsh `isSkillName`: lowercase kebab-case. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export function isSkillName(name: string): boolean {
  return SKILL_NAME_PATTERN.test(name)
}

/** `workflow` = 手写的方法论/流程模板（稳定、精心维护）；`experience` = 从对话沉淀的经验（多、会增长）。 */
export type SkillCategory = 'workflow' | 'experience'

export interface SkillSummary {
  name: string
  description: string
  category: SkillCategory
  /** Project `.shuttle/skills` vs user-global `~/.shuttle/skills`. */
  source: 'project' | 'user'
  /** SHA-1 of the full file content (frontmatter included). */
  digest: string
}

interface SkillEntry extends SkillSummary {
  content: string
  /** Absolute path of the backing SKILL.md file. */
  path: string
  /** True for the `<name>/SKILL.md` bundle form (delete removes the dir). */
  bundle: boolean
  /** Lower rank wins on name collisions (project root beats user-global). */
  rank: number
}

interface SkillRoot {
  path: string
  rank: number
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex')
}

/** Hand-rolled frontmatter: `---` fences around `key: value` scalar lines only. */
export function parseFrontmatter(raw: string): { data: Record<string, string>; body: string } | undefined {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const data: Record<string, string> = {}
  let lineStart = firstLineEnd + 1
  for (;;) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    const line = raw.slice(lineStart, lineEnd).replace(/\r$/, '')
    if (line === '---') {
      return { data, body: raw.slice(nextNewline < 0 ? raw.length : nextNewline + 1) }
    }
    if (line.trim() !== '' && !line.trimStart().startsWith('#')) {
      const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
      if (match && match[1]) data[match[1]] = (match[2] ?? '').trim()
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
}

interface SkillFile {
  path: string
  content: string
  bundle: boolean
}

/** One-level scan: `<name>/SKILL.md` bundles and flat `<name>.md` files. */
function scanRoot(root: SkillRoot): SkillFile[] {
  if (!existsSync(root.path)) return []
  let dirents
  try {
    dirents = readdirSync(root.path, { withFileTypes: true })
  } catch {
    return []
  }
  const files: SkillFile[] = []
  for (const dirent of dirents.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = join(root.path, dirent.name)
    if (dirent.isDirectory()) {
      const skillFile = join(path, 'SKILL.md')
      if (isFile(skillFile)) {
        const raw = readSkillFile(skillFile, true)
        if (raw) files.push(raw)
      }
    } else if (dirent.isFile() && dirent.name.endsWith('.md')) {
      const raw = readSkillFile(path, false)
      if (raw) files.push(raw)
    }
  }
  return files
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function readSkillFile(path: string, bundle: boolean): SkillFile | undefined {
  try {
    return { path, content: readFileSync(path, 'utf8'), bundle }
  } catch {
    return undefined
  }
}

function parseSkill(raw: SkillFile, root: SkillRoot): SkillEntry | undefined {
  const parsed = parseFrontmatter(raw.content)
  if (!parsed) {
    console.warn(`skill file ${raw.path} ignored: missing YAML frontmatter`)
    return undefined
  }
  const name = parsed.data.name
  const description = parsed.data.description
  if (!name || !description) {
    console.warn(`skill file ${raw.path} ignored: frontmatter requires name and description`)
    return undefined
  }
  if (!isSkillName(name)) {
    console.warn(`skill file ${raw.path} ignored: invalid skill name "${name}"`)
    return undefined
  }
  const category: SkillCategory = parsed.data.category === 'experience' ? 'experience' : 'workflow'
  return { name, description, category, content: raw.content, digest: sha1(raw.content), source: root.rank === 0 ? 'project' : 'user', path: raw.path, bundle: raw.bundle, rank: root.rank }
}

/**
 * Project `.shuttle/skills` (rank 0) + user-global `~/.shuttle/skills`
 * (rank 1). Same-name skills: the nearer root wins. Every call re-scans the
 * roots — file counts are tiny and `writeMemory` invalidates nothing.
 */
export class SkillLoader {
  constructor(readonly projectRoot: string) {}

  private resolveRoots(): SkillRoot[] {
    return [
      { path: join(shuttleDir(this.projectRoot), 'skills'), rank: 0 },
      { path: join(homedir(), '.shuttle', 'skills'), rank: 1 },
    ]
  }

  private scan(): SkillEntry[] {
    const byName = new Map<string, SkillEntry>()
    for (const root of this.resolveRoots()) {
      for (const raw of scanRoot(root)) {
        const entry = parseSkill(raw, root)
        if (!entry) continue
        const existing = byName.get(entry.name)
        if (!existing || entry.rank < existing.rank) byName.set(entry.name, entry)
      }
    }
    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Catalog summaries for the `<available_skills>` injection. */
  catalog(): SkillSummary[] {
    return this.scan().map(({ name, description, category, source, digest }) => ({ name, description, category, source, digest }))
  }

  /** Full SKILL.md content (frontmatter included), for the `skill` tool result. */
  get(name: string): string | undefined {
    if (!isSkillName(name)) return undefined
    return this.scan().find((entry) => entry.name === name)?.content
  }

  /** Backing file of a skill, for edit/delete. */
  resolveFile(name: string): { path: string; bundle: boolean } | undefined {
    if (!isSkillName(name)) return undefined
    const entry = this.scan().find((e) => e.name === name)
    return entry ? { path: entry.path, bundle: entry.bundle } : undefined
  }

  /** Default location for a new project-level skill bundle. */
  defaultPath(name: string): string {
    return join(shuttleDir(this.projectRoot), 'skills', name, 'SKILL.md')
  }
}

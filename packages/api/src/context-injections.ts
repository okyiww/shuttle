import { createHash } from 'node:crypto'
import { findProjectRoot, loadAgentInstructions } from '@shuttle/memory'
import type { SkillSummary } from '@shuttle/memory'
import type { SessionStore } from '@shuttle/session'
import type { ApiState } from './state.js'

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex')

/** dsh `escapeText`: provider text must not break the pseudo-XML frame. */
function escapeText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
}

const CATALOG_DESCRIPTION_MAX_LENGTH = 500

function renderCatalog(skills: SkillSummary[]): string {
  const describe = (skill: SkillSummary): string => {
    const description =
      skill.description.length > CATALOG_DESCRIPTION_MAX_LENGTH
        ? `${skill.description.slice(0, CATALOG_DESCRIPTION_MAX_LENGTH)}…`
        : skill.description
    return `- \`${skill.name}\`: ${escapeText(description)}`
  }
  const workflow = skills.filter((skill) => skill.category === 'workflow')
  const experience = skills.filter((skill) => skill.category === 'experience')
  const groups: string[] = []
  if (workflow.length > 0) {
    groups.push('Workflow templates (curated methodology — follow these when applicable):', ...workflow.map(describe))
  }
  if (experience.length > 0) {
    groups.push('Distilled experience (from real sessions — treat as reference):', ...experience.map(describe))
  }
  return [
    '<system-reminder>',
    'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
    '',
    '<available_skills>',
    ...groups,
    '</available_skills>',
    '',
    "If the user names a skill, or the task clearly matches a skill's description, call the `skill` tool with the exact skill name before taking task actions. Load all applicable skills, then follow their full instructions. This catalog contains summaries only; do not infer or follow a skill's instructions until it has been loaded.",
    '</system-reminder>',
  ].join('\n')
}

/**
 * Append-only durable injections (dsh two-stage skill consumption + baseline
 * instructions): append only when the rendered content digest differs from the
 * latest same-tag injection already in the log — so only the first turn (or
 * the first turn after a file change) pays the injection. deriveMessages
 * surfaces only the newest entry per tag.
 */
export function ensureContextInjections(session: SessionStore, state: ApiState, cwd: string): void {
  const instructions = loadAgentInstructions(findProjectRoot(cwd), cwd)
  if (instructions.content !== '') {
    inject(session, 'agent-instructions', instructions.content)
  }
  const catalog = state.skills.catalog()
  if (catalog.length > 0) {
    inject(session, 'skills-catalog', renderCatalog(catalog))
  }
}

function inject(session: SessionStore, tag: 'agent-instructions' | 'skills-catalog', content: string): void {
  const digest = sha1(content)
  const last = session
    .readAll()
    .filter((event) => event.type === 'context/injection' && event.tag === tag)
    .at(-1)
  if (last && last.type === 'context/injection' && last.digest === digest) return
  session.append({ type: 'context/injection', tag, digest, content })
}

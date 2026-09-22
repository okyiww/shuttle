import { useCallback, useEffect, useState } from 'react'
import { api } from '../api'

interface SkillItem {
  name: string
  description: string
  source: 'project' | 'user'
}

interface NoteItem {
  path: string
  title: string
  lifecycle: string
}

interface Selection {
  kind: 'skill' | 'note'
  /** skill: name；note: 项目相对路径。 */
  key: string
  title: string
  draft: string
  isNew: boolean
}

const NEW_SKILL = [
  '---',
  'name: new-skill',
  'description: 一句话说明什么时候用这个 skill',
  '---',
  '',
  '## 适用场景',
  '',
  '',
  '## 从 0 到 1 的步骤',
  '',
  '',
  '## 踩坑与规避',
  '',
  '',
  '## 关联资源',
  '',
].join('\n')

const NEW_NOTE = [
  '# Agent Note: 标题',
  '',
  'Status: proposed — 背景一句话',
  '',
  '## Problem',
  '',
  '',
  '## Proposal',
  '',
  '',
  '## Alternatives considered',
  '',
  '',
  '## Acceptance criteria',
  '',
].join('\n')

export function Memory() {
  const [skills, setSkills] = useState<SkillItem[]>([])
  const [notes, setNotes] = useState<NoteItem[]>([])
  const [selected, setSelected] = useState<Selection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [savedTick, setSavedTick] = useState<string | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [skillList, noteList] = await Promise.all([api.listSkills(), api.listNotes()])
      setSkills(skillList)
      setNotes(noteList)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const openSkill = useCallback(async (name: string) => {
    setConfirmingDelete(false)
    setSavedTick(null)
    try {
      const detail = await api.skillContent(name)
      setSelected({ kind: 'skill', key: name, title: name, draft: detail.content, isNew: false })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const openNote = useCallback(async (note: NoteItem) => {
    setConfirmingDelete(false)
    setSavedTick(null)
    try {
      const detail = await api.readMemory(note.path)
      setSelected({ kind: 'note', key: note.path, title: note.title, draft: detail.content, isNew: false })
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  const openNew = useCallback((kind: 'skill' | 'note') => {
    setConfirmingDelete(false)
    setSavedTick(null)
    setSelected(
      kind === 'skill'
        ? { kind, key: '', title: '新技能', draft: NEW_SKILL, isNew: true }
        : { kind, key: '', title: '新笔记', draft: NEW_NOTE, isNew: true },
    )
    setError(null)
  }, [])

  const save = useCallback(async () => {
    if (!selected) return
    setSavedTick(null)
    try {
      if (selected.kind === 'skill') {
        const result = await api.saveSkill(selected.draft, selected.isNew ? undefined : selected.key)
        setSelected({ ...selected, key: result.name, title: result.name, isNew: false })
      } else {
        const path = selected.key || `.shuttle/notes/proposed/process/${new Date().toISOString().slice(0, 10)}-new-note.md`
        await api.writeMemory(path, selected.draft)
        setSelected({ ...selected, key: path, isNew: false })
      }
      setSavedTick('已保存')
      setError(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [selected, refresh])

  const remove = useCallback(async () => {
    if (!selected || selected.isNew) return
    if (!confirmingDelete) {
      setConfirmingDelete(true)
      return
    }
    setConfirmingDelete(false)
    try {
      if (selected.kind === 'skill') await api.deleteSkill(selected.key)
      else await api.deleteMemory(selected.key)
      setSelected(null)
      setError(null)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [selected, confirmingDelete, refresh])

  // 笔记 → 技能：LLM 重构成 SKILL.md 草稿，作为新技能打开继续编辑
  const promote = useCallback(async () => {
    if (!selected || selected.kind !== 'note' || selected.isNew) return
    setSavedTick('提炼中…')
    try {
      const result = await api.promoteMemory(selected.key)
      setSelected({ kind: 'skill', key: '', title: '新技能', draft: result.markdown, isNew: true })
      setSavedTick(null)
      setError(null)
    } catch (err) {
      setSavedTick(null)
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [selected])

  return (
    <div className="memory">
      <aside className="memory-nav">
        <div className="memory-head">
          <h3>技能</h3>
          <span className="dim">
            {skills.length}
            <button className="ghost memory-new" onClick={() => openNew('skill')} title="新建技能">
              ＋
            </button>
          </span>
        </div>
        {skills.map((skill) => (
          <div
            key={skill.name}
            className={`memory-item ${selected?.kind === 'skill' && selected.key === skill.name ? 'active' : ''}`}
            onClick={() => void openSkill(skill.name)}
          >
            <div className="title">
              {skill.name}
              <span className="badge">{skill.source === 'project' ? '项目' : '个人'}</span>
            </div>
            <div className="dim">{skill.description}</div>
          </div>
        ))}
        <div className="memory-head">
          <h3>笔记</h3>
          <span className="dim">
            {notes.length}
            <button className="ghost memory-new" onClick={() => openNew('note')} title="新建笔记">
              ＋
            </button>
          </span>
        </div>
        {notes.map((note) => (
          <div
            key={note.path}
            className={`memory-item ${selected?.kind === 'note' && selected.key === note.path ? 'active' : ''}`}
            onClick={() => void openNote(note)}
          >
            <div className="title">
              {note.title}
              {note.lifecycle && <span className="badge">{note.lifecycle}</span>}
            </div>
            <div className="dim">{note.path}</div>
          </div>
        ))}
        {skills.length === 0 && notes.length === 0 && (
          <div className="empty-hint">
            还没有沉淀过经验。聊天侧栏点「沉淀经验」把对话存成 skill 或笔记，或直接点上方 ＋ 手写。
          </div>
        )}
        {error && <div className="error-banner">{error}</div>}
      </aside>
      <section className="memory-content">
        {selected ? (
          <div className="memory-editor">
            <div className="memory-toolbar">
              <span className="memory-editor-title">
                {selected.kind === 'skill' ? '技能' : '笔记'} · {selected.title}
                {savedTick && <span className="memory-saved">{savedTick}</span>}
              </span>
              {selected.kind === 'note' && !selected.isNew && (
                <button className="ghost" onClick={() => void promote()} title="用 LLM 把这份笔记重构成 SKILL.md 草稿">
                  转为技能
                </button>
              )}
              <button className="primary" onClick={() => void save()}>
                保存
              </button>
              <button className={confirmingDelete ? 'danger' : 'ghost'} onClick={() => void remove()}>
                {confirmingDelete ? '确认删除？' : '删除'}
              </button>
            </div>
            <textarea
              className="markdown-edit memory-textarea"
              value={selected.draft}
              onChange={(e) => {
                setSavedTick(null)
                setSelected({ ...selected, draft: e.target.value })
              }}
            />
            <div className="dim memory-editor-hint">
              {selected.kind === 'skill'
                ? 'frontmatter 的 name 就是文件名；改 name 保存会移动文件。这些文件都在项目 .shuttle/ 目录里，也可在编辑器中直接修改。'
                : '笔记是档案：记录决策背景、复盘结论，不占模型上下文。写好之后点「转为技能」提炼成模型每次对话自动加载的操作手册。'}
            </div>
          </div>
        ) : (
          <div className="empty-hint">
            选择左侧的技能或笔记进行编辑；skill 会被注入到每次对话的模型上下文，笔记沉淀决策与经验
          </div>
        )}
      </section>
    </div>
  )
}

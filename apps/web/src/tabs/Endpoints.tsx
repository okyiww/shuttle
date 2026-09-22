import { useMemo, useState } from 'react'
import type { CompatView, ConfigResponse, EndpointConfigView } from '../api'
import { api } from '../api'

interface Draft {
  name: string
  api: 'openai-completions' | 'anthropic-messages' | 'ollama'
  baseURL: string
  /** Password input. Empty = keep; a lone '' sent only via the clear path. Masked sentinel = keep. */
  apiKey: string
  apiKeyMask: string
  apiKeyEnv: string
  modelsText: string
  systemRole: '' | 'system' | 'developer'
  maxTokensField: '' | 'max_tokens' | 'max_completion_tokens'
  thinkingFormat: '' | 'none' | 'deepseek'
}

interface TestState {
  status: 'testing' | 'ok' | 'fail'
  text: string
}

const DEFAULT_OLLAMA_BASE_URL = 'http://localhost:11434'

function draftFrom(name: string, endpoint: EndpointConfigView | undefined): Draft {
  const base = {
    name,
    api: (endpoint?.api ?? 'openai-completions') as Draft['api'],
    baseURL: endpoint?.baseURL ?? '',
    apiKeyEnv: endpoint?.apiKeyEnv ?? '',
    modelsText: (endpoint?.models ?? []).map((m) => (m.contextWindow ? `${m.id}:${m.contextWindow}` : m.id)).join(', '),
    systemRole: (endpoint?.compat?.systemRole ?? '') as Draft['systemRole'],
    maxTokensField: (endpoint?.compat?.maxTokensField ?? '') as Draft['maxTokensField'],
    thinkingFormat: (endpoint?.compat?.thinkingFormat ?? '') as Draft['thinkingFormat'],
  }
  if (!endpoint) {
    return { ...base, apiKey: '', apiKeyMask: '' }
  }
  // Prefill with the mask as a sentinel: untouched mask → keep; cleared → delete.
  return { ...base, apiKey: endpoint.apiKey ?? '', apiKeyMask: endpoint.apiKey ?? '' }
}

function draftToBody(draft: Draft): EndpointConfigView {
  const models = draft.modelsText
    .split(',')
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => {
      const [id, window] = token.split(':')
      const contextWindow = window ? Number(window) : undefined
      return contextWindow && Number.isInteger(contextWindow) ? { id: id!, contextWindow } : { id: token }
    })
  const compat: CompatView = {}
  if (draft.systemRole) compat.systemRole = draft.systemRole
  if (draft.maxTokensField) compat.maxTokensField = draft.maxTokensField
  if (draft.thinkingFormat) compat.thinkingFormat = draft.thinkingFormat
  const apiKey =
    draft.apiKey === draft.apiKeyMask ? undefined : draft.apiKey === '' && draft.apiKeyMask !== '' ? '' : draft.apiKey || undefined
  // ollama is a local, keyless service: never persist key material for it.
  const isOllama = draft.api === 'ollama'
  return {
    api: draft.api,
    baseURL: draft.baseURL.trim(),
    ...(apiKey !== undefined && !isOllama ? { apiKey } : {}),
    ...(draft.apiKeyEnv.trim() && !isOllama ? { apiKeyEnv: draft.apiKeyEnv.trim() } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(Object.keys(compat).length > 0 ? { compat } : {}),
  }
}

export function Endpoints({
  config,
  configError,
  onChanged,
}: {
  config: ConfigResponse | null
  configError: string | null
  onChanged: () => Promise<void>
}) {
  const [editing, setEditing] = useState<Draft | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [tests, setTests] = useState<Record<string, TestState>>({})
  const [showKey, setShowKey] = useState(false)

  const endpoints = useMemo(() => Object.entries(config?.config.endpoints ?? {}), [config])
  const defaultEndpoint = config?.config.agent?.endpoint

  const openEditor = (name?: string) => {
    setFormError(null)
    setEditing(draftFrom(name ?? '', name ? config?.config.endpoints?.[name] : undefined))
  }

  const updateEditing = (patch: Partial<Draft>) => {
    if (!editing) return
    setFormError(null)
    setEditing({ ...editing, ...patch })
  }

  const submit = async () => {
    if (!editing) return
    if (!/^[A-Za-z0-9_.-]+$/.test(editing.name)) {
      setFormError('name 只能包含字母、数字、_ . -')
      return
    }
    if (!editing.baseURL.trim() && editing.api !== 'ollama') {
      setFormError('baseURL 必填')
      return
    }
    try {
      await api.putEndpoint(editing.name, draftToBody(editing))
      await onChanged()
      setEditing(null)
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    }
  }

  const runTest = async (name: string) => {
    setTests((prev) => ({ ...prev, [name]: { status: 'testing', text: '测试中…' } }))
    try {
      const result = await api.testEndpoint(name)
      setTests((prev) => ({
        ...prev,
        [name]: result.ok
          ? { status: 'ok', text: `✓ ${result.latencyMs}ms` }
          : { status: 'fail', text: `✗ ${result.error ?? 'unknown error'}` },
      }))
    } catch (error) {
      setTests((prev) => ({
        ...prev,
        [name]: { status: 'fail', text: `✗ ${error instanceof Error ? error.message : String(error)}` },
      }))
    }
  }

  const setDefault = async (name: string) => {
    const first = config?.config.endpoints?.[name]?.models?.[0]?.id
    await api.setDefault(name, first)
    await onChanged()
  }

  const remove = async (name: string) => {
    if (name === defaultEndpoint && !window.confirm(`「${name}」是当前默认 endpoint，确定删除？`)) return
    if (name !== defaultEndpoint && !window.confirm(`确定删除 endpoint「${name}」？（只影响用户层）`)) return
    try {
      await api.deleteEndpoint(name)
      await onChanged()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h2>Endpoints</h2>
          <div className="subtitle">模型接入只是数据：新增/修改都写入用户层，热生效。</div>
        </div>
        <button className="primary" onClick={() => openEditor()}>
          ＋ 新增 endpoint
        </button>
      </div>
      {configError && <div className="error-banner">{configError}</div>}
      {formError && <div className="error-banner">{formError}</div>}
      <div className="endpoint-grid">
        {endpoints.map(([name, endpoint]) => {
          const test = tests[name]
          return (
            <div className="endpoint-card" key={name}>
              <div className="card-head">
                <span className="name">{name}</span>
                <span className="badge api">{endpoint.api}</span>
                {name === defaultEndpoint && <span className="badge default">默认</span>}
              </div>
              <div className="baseurl">{endpoint.baseURL}</div>
              <div className="meta">
                {endpoint.models?.length ? `${endpoint.models.length} 个 model` : '未配置 model'} · key 环境变量{' '}
                <code>{endpoint.apiKeyEnv || '未配置'}</code>
              </div>
              {endpoint.apiKey && <div className="meta key-mask">已存 key {endpoint.apiKey}</div>}
              <div className="card-actions">
                <button className="ghost" onClick={() => void runTest(name)} disabled={test?.status === 'testing'}>
                  {test?.status === 'testing' ? '测试中…' : '测试连接'}
                </button>
                {name !== defaultEndpoint && (
                  <button className="ghost" onClick={() => void setDefault(name)}>
                    设为默认
                  </button>
                )}
                <button className="ghost" onClick={() => openEditor(name)}>
                  编辑
                </button>
                <button className="ghost danger" onClick={() => void remove(name)}>
                  删除
                </button>
              </div>
              {test && test.status !== 'testing' && (
                <div className={`test-result ${test.status}`}>{test.text}</div>
              )}
            </div>
          )
        })}
        {endpoints.length === 0 && <div className="empty-hint">还没有 endpoint —— 点右上角新增一个网关。</div>}
      </div>

      {editing && (
        <div className="modal-mask" onClick={() => setEditing(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{config?.config.endpoints?.[editing.name] ? `编辑 ${editing.name}` : '新增 endpoint'}</h3>
            <div className="form-row">
              <label>name（保存后不可改；同名即整体替换）</label>
              <input
                value={editing.name}
                onChange={(e) => updateEditing({ name: e.target.value })}
                disabled={Boolean(config?.config.endpoints?.[editing.name])}
                placeholder="deepseek"
              />
            </div>
            <div className="form-grid">
              <div className="form-row">
                <label>api</label>
                <select
                  value={editing.api}
                  onChange={(e) => {
                    const api = e.target.value as Draft['api']
                    updateEditing({
                      api,
                      ...(api === 'ollama' && !editing.baseURL.trim() ? { baseURL: DEFAULT_OLLAMA_BASE_URL } : {}),
                    })
                  }}
                >
                  <option value="openai-completions">openai-completions</option>
                  <option value="anthropic-messages">anthropic-messages</option>
                  <option value="ollama">ollama (本地)</option>
                </select>
              </div>
              {editing.api !== 'ollama' && (
                <div className="form-row">
                  <label>apiKeyEnv（可选；环境变量回退，团队共享用）</label>
                  <input
                    value={editing.apiKeyEnv}
                    onChange={(e) => updateEditing({ apiKeyEnv: e.target.value })}
                    placeholder="DEEPSEEK_API_KEY"
                  />
                </div>
              )}
            </div>
            {editing.api !== 'ollama' && (
              <div className="form-row">
                <label>API Key</label>
                <div className="password-row">
                  <input
                    type={showKey ? 'text' : 'password'}
                    value={editing.apiKey}
                    onChange={(e) => updateEditing({ apiKey: e.target.value })}
                    placeholder={editing.apiKeyMask || 'sk-...'}
                    autoComplete="off"
                  />
                  <button type="button" className="ghost" onClick={() => setShowKey((prev) => !prev)}>
                    {showKey ? '🙈' : '👁'}
                  </button>
                </div>
                <div className="field-hint">
                  {editing.apiKeyMask
                    ? `当前已存 ${editing.apiKeyMask} —— 留空保持不变；删除请清空保存。`
                    : '未设置 —— 将使用环境变量'}
                  {editing.apiKeyEnv ? ` ${editing.apiKeyEnv}` : ''}
                </div>
              </div>
            )}
            <div className="form-row">
              <label>baseURL</label>
              <input
                value={editing.baseURL}
                onChange={(e) => updateEditing({ baseURL: e.target.value })}
                placeholder="https://api.deepseek.com/v1"
              />
            </div>
            <div className="form-row">
              <label>models（逗号分隔，可写 id 或 id:contextWindow）</label>
              <input
                value={editing.modelsText}
                onChange={(e) => updateEditing({ modelsText: e.target.value })}
                placeholder="deepseek-chat:64000, deepseek-reasoner"
              />
            </div>
            <details className="compat">
              <summary>compat 高级选项（修正网关差异）</summary>
              <div className="form-grid" style={{ marginTop: 10 }}>
                <div className="form-row">
                  <label>systemRole</label>
                  <select
                    value={editing.systemRole}
                    onChange={(e) => updateEditing({ systemRole: e.target.value as Draft['systemRole'] })}
                  >
                    <option value="">（默认 system）</option>
                    <option value="system">system</option>
                    <option value="developer">developer</option>
                  </select>
                </div>
                <div className="form-row">
                  <label>maxTokensField</label>
                  <select
                    value={editing.maxTokensField}
                    onChange={(e) => updateEditing({ maxTokensField: e.target.value as Draft['maxTokensField'] })}
                  >
                    <option value="">（默认 max_tokens）</option>
                    <option value="max_tokens">max_tokens</option>
                    <option value="max_completion_tokens">max_completion_tokens</option>
                  </select>
                </div>
                <div className="form-row">
                  <label>thinkingFormat</label>
                  <select
                    value={editing.thinkingFormat}
                    onChange={(e) => updateEditing({ thinkingFormat: e.target.value as Draft['thinkingFormat'] })}
                  >
                    <option value="">（默认 none）</option>
                    <option value="none">none</option>
                    <option value="deepseek">deepseek</option>
                  </select>
                </div>
              </div>
            </details>
            <div className="modal-actions">
              <button className="ghost" onClick={() => setEditing(null)}>
                取消
              </button>
              <button className="primary" onClick={() => void submit()}>
                保存到用户层
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

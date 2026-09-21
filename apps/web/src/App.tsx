import { useCallback, useEffect, useState } from 'react'
import type { ConfigResponse } from './api'
import { api } from './api'
import { Chat } from './tabs/Chat'
import { ConfigView } from './tabs/ConfigView'
import { Endpoints } from './tabs/Endpoints'
import { Mcp } from './tabs/Mcp'

type Tab = 'chat' | 'endpoints' | 'mcp' | 'config'

export function App() {
  const [tab, setTab] = useState<Tab>('chat')
  const [config, setConfig] = useState<ConfigResponse | null>(null)
  const [configError, setConfigError] = useState<string | null>(null)

  const refreshConfig = useCallback(async () => {
    try {
      setConfig(await api.getConfig())
      setConfigError(null)
    } catch (error) {
      setConfigError(error instanceof Error ? error.message : String(error))
    }
  }, [])

  useEffect(() => {
    void refreshConfig()
  }, [refreshConfig])

  return (
    <div className="app">
      <header className="app-header">
        <span className="brand">Shuttle</span>
        <nav className="tabs">
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            聊天
          </button>
          <button className={tab === 'endpoints' ? 'active' : ''} onClick={() => setTab('endpoints')}>
            Endpoints
          </button>
          <button className={tab === 'mcp' ? 'active' : ''} onClick={() => setTab('mcp')}>
            MCP
          </button>
          <button className={tab === 'config' ? 'active' : ''} onClick={() => setTab('config')}>
            配置
          </button>
        </nav>
      </header>
      <main className="app-main">
        {tab === 'chat' && <Chat config={config} configError={configError} />}
        {tab === 'endpoints' && (
          <Endpoints config={config} configError={configError} onChanged={refreshConfig} />
        )}
        {tab === 'mcp' && <Mcp onConfigChanged={refreshConfig} />}
        {tab === 'config' && <ConfigView config={config} configError={configError} />}
      </main>
    </div>
  )
}

import { useCallback, useEffect, useState } from 'react'
import type { ConfigResponse } from './api'
import { api } from './api'
import { navigate, useRoute, VALID_TABS } from './router'
import { Chat } from './tabs/Chat'
import { ConfigView } from './tabs/ConfigView'
import { Endpoints } from './tabs/Endpoints'
import { Mcp } from './tabs/Mcp'
import { Memory } from './tabs/Memory'

type Tab = (typeof VALID_TABS)[number]

export function App() {
  const route = useRoute()
  const tab: Tab = (VALID_TABS as readonly string[]).includes(route.tab) ? (route.tab as Tab) : 'chat'
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
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => navigate('chat')}>
            聊天
          </button>
          <button className={tab === 'memory' ? 'active' : ''} onClick={() => navigate('memory')}>
            经验
          </button>
          <button className={tab === 'endpoints' ? 'active' : ''} onClick={() => navigate('endpoints')}>
            Endpoints
          </button>
          <button className={tab === 'mcp' ? 'active' : ''} onClick={() => navigate('mcp')}>
            MCP
          </button>
          <button className={tab === 'config' ? 'active' : ''} onClick={() => navigate('config')}>
            配置
          </button>
        </nav>
      </header>
      <main className="app-main">
        {tab === 'chat' && <Chat config={config} configError={configError} />}
        {tab === 'memory' && <Memory />}
        {tab === 'endpoints' && (
          <Endpoints config={config} configError={configError} onChanged={refreshConfig} />
        )}
        {tab === 'mcp' && <Mcp onConfigChanged={refreshConfig} />}
        {tab === 'config' && <ConfigView config={config} configError={configError} />}
      </main>
    </div>
  )
}

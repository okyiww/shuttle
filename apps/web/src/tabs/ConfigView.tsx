import type { ConfigResponse } from '../api'

export function ConfigView({ config, configError }: { config: ConfigResponse | null; configError: string | null }) {
  if (configError) {
    return (
      <div className="page">
        <h2>配置</h2>
        <div className="error-banner">{configError}</div>
      </div>
    )
  }
  if (!config) {
    return (
      <div className="page">
        <h2>配置</h2>
        <div className="empty-hint">加载中…</div>
      </div>
    )
  }
  return (
    <div className="page">
      <h2>配置</h2>
      <div className="note">用户层由网页写入（热生效）；项目层只读，是团队共享的默认基底。</div>
      <div className="layer-list">
        {config.layers.map((layer) => (
          <div className="layer-item" key={layer.path}>
            <span className={`badge ${layer.writable ? 'default' : ''}`}>{layer.writable ? '可写' : '只读'}</span>
            <span>{layer.path}</span>
          </div>
        ))}
        {config.layers.length === 0 && <div className="layer-item">没有找到配置文件（两层都不存在）</div>}
      </div>
      <h2 style={{ fontSize: 15 }}>合并结果</h2>
      <pre className="yaml-view">{config.yaml.trim() === '' ? '（空配置）' : config.yaml}</pre>
    </div>
  )
}

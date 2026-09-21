export function printUsage(): void {
  console.log(`shuttle — agent harness (web-first)

usage:
  shuttle web [--port 4080] [--no-open]                        start the web UI (BFF + built SPA)
  shuttle run "<prompt>" [--endpoint <name>] [--model <id>] [--yes]   headless turn (tools + guard; --yes auto-approves)
  shuttle config --dump                                        show layered config and merge result
  shuttle --help                                               show this help

headless guard policy: guard=ask tools are auto-DENIED unless --yes is given —
the CLI never approves on your behalf.

config layers (later wins):
  ./shuttle.config.yml      project defaults (read-only base)
  ~/.shuttle/config.yml     user overrides (writable layer, hot-reloaded)

dev: pnpm dev   (api on :4080 with cors + vite on :5173 proxying /api)
`)
}

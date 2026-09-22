import { useSyncExternalStore } from 'react'

export interface Route {
  tab: string
  params: URLSearchParams
}

export const VALID_TABS = ['chat', 'memory', 'endpoints', 'mcp', 'config'] as const

function parseHash(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/chat'
  const [path, query] = raw.split('?')
  const tab = (path ?? '').replace(/^\//, '') || 'chat'
  return { tab, params: new URLSearchParams(query ?? '') }
}

let current: Route = parseHash()
const listeners = new Set<() => void>()

function emit(): void {
  current = parseHash()
  for (const listener of listeners) listener()
}

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', emit)
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Current route; re-renders subscribers on hash changes (push or replace). */
export function useRoute(): Route {
  return useSyncExternalStore(subscribe, () => current)
}

/**
 * Navigate. Tab switches push a history entry (browser back works across
 * tabs); in-tab param syncs (e.g. the active chat session) replace, so
 * clicking around does not spam history.
 */
export function navigate(tab: string, params?: Record<string, string>, options?: { replace?: boolean }): void {
  const query = params && Object.keys(params).length > 0 ? `?${new URLSearchParams(params).toString()}` : ''
  const url = `#/${tab}${query}`
  if (options?.replace) {
    history.replaceState(null, '', url)
    emit() // replaceState does not fire hashchange
  } else {
    location.hash = url // fires hashchange → emit
  }
}

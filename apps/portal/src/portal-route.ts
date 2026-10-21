const portalPages = new Set(['assistant', 'devices', 'discovery', 'network-intelligence', 'bus', 'systems', 'energy', 'weather', 'executions', 'logs']);

export function pageFromPath(pathname: string): string {
  const page = pathname.split('/').filter(Boolean)[0] || 'assistant';
  return portalPages.has(page) ? page : 'assistant';
}

export function pathForPage(page: string): string {
  return page === 'assistant' ? '/' : `/${page}/`;
}

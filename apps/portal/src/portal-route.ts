const portalPages = new Set(['assistant', 'home', 'mobile', 'display', 'devices', 'discovery', 'bus', 'systems', 'energy', 'weather', 'executions', 'logs']);

export function pageFromPath(pathname: string): string {
  const page = pathname.split('/').filter(Boolean)[0] || 'assistant';
  return portalPages.has(page) ? page : 'assistant';
}

export function pathForPage(page: string): string {
  return page === 'assistant' ? '/' : `/${page}/`;
}

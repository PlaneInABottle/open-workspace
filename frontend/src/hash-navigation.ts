export type View = 'observe' | 'environments' | 'setup' | 'privacy';

export type ObserveRoute =
  | { tab: 'sessions' }
  | { tab: 'session'; sessionID: string }
  | { tab: 'mistakes' }
  | { tab: 'stuck' }
  | { tab: 'cost' };

export interface Route {
  view: View;
  observe: ObserveRoute;
}

const views = new Set<View>(['observe', 'environments', 'setup', 'privacy']);

const observeTabs = new Set(['sessions', 'mistakes', 'stuck', 'cost']);

function observeFromSegments(segments: string[]): ObserveRoute {
  const [first] = segments;
  if (!first) return { tab: 'sessions' };
  if (observeTabs.has(first)) return { tab: first } as ObserveRoute;
  // Anything else under #observe/ is a session id. Format-invalid ids fall
  // back to the picker with a notice in ObserveView; well-formed but unknown
  // ids show a not-found notice in the session detail.
  return { tab: 'session', sessionID: first };
}

export function routeFromHash(hash: string): Route {
  const segments = hash.slice(1).split('/').filter(segment => segment.length > 0);
  const [head, ...rest] = segments;
  if (head && views.has(head as View)) {
    const view = head as View;
    return { view, observe: view === 'observe' ? observeFromSegments(rest) : { tab: 'sessions' } };
  }
  return { view: 'observe', observe: { tab: 'sessions' } };
}

export function hashFor(route: Route): string {
  if (route.view !== 'observe') return `#${route.view}`;
  if (route.observe.tab === 'sessions') return '#observe';
  if (route.observe.tab === 'session') return `#observe/${route.observe.sessionID}`;
  return `#observe/${route.observe.tab}`;
}

export function ensureViewHash(): Route {
  const route = routeFromHash(window.location.hash);
  const canonical = hashFor(route);
  if (window.location.hash !== canonical) {
    window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${canonical}`);
  }
  return route;
}

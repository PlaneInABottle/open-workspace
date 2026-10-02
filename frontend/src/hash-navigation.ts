export type View = 'overview' | 'setup' | 'privacy';

const views = new Set<View>(['overview', 'setup', 'privacy']);

export function viewFromHash(hash: string): View {
  const candidate = hash.slice(1);
  return views.has(candidate as View) ? candidate as View : 'overview';
}

export function ensureViewHash() {
  if (!views.has(location.hash.slice(1) as View)) {
    history.replaceState(null, '', `${location.pathname}${location.search}#overview`);
  }
  return viewFromHash(location.hash);
}

export function navigateToView(view: View) {
  if (location.hash === `#${view}`) return;
  location.hash = view;
}

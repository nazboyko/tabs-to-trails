import { useEffect, useState } from 'react';

export type Route = { name: 'build' } | { name: 'walk'; id: string } | { name: 'script'; id: string };

export function parseRoute(pathname: string): Route {
  const walk = pathname.match(/^\/walk\/([a-f0-9]{12})(\/script)?\/?$/);
  if (walk) return walk[2] ? { name: 'script', id: walk[1]! } : { name: 'walk', id: walk[1]! };
  return { name: 'build' };
}

const listeners = new Set<() => void>();
let navigated = false;

export function navigate(to: string, replace = false): void {
  if (replace) history.replaceState(null, '', to);
  else history.pushState(null, '', to);
  navigated = true;
  window.scrollTo(0, 0);
  listeners.forEach((fn) => fn());
}

/** True after the first in-app navigation, so focus moves to new screens but not on first load. */
export function hasNavigated(): boolean {
  return navigated;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(location.pathname));
  useEffect(() => {
    const update = () => setRoute(parseRoute(location.pathname));
    const onPop = () => {
      navigated = true;
      update();
    };
    listeners.add(update);
    window.addEventListener('popstate', onPop);
    return () => {
      listeners.delete(update);
      window.removeEventListener('popstate', onPop);
    };
  }, []);
  return route;
}

/** Same-origin links that change the screen without reloading. */
export function onLink(e: React.MouseEvent<HTMLAnchorElement>): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const href = e.currentTarget.getAttribute('href');
  if (!href || !href.startsWith('/') || href.startsWith('/api/')) return;
  e.preventDefault();
  navigate(href);
}

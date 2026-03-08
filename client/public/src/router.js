const listeners = [];
let currentRoute = parseHash();
function parseHash() {
  const hash = window.location.hash.slice(1) || '/';
  const [path, query] = hash.split('?');
  const params = {};
  if (query) for (const pair of query.split('&')) { const [k, v] = pair.split('='); params[decodeURIComponent(k)] = decodeURIComponent(v || ''); }
  return { path, params };
}
export function navigate(path) { window.location.hash = '#' + path; }
export function getRoute() { return currentRoute; }
export function onRouteChange(fn) { listeners.push(fn); return () => { const idx = listeners.indexOf(fn); if (idx >= 0) listeners.splice(idx, 1); }; }
window.addEventListener('hashchange', () => { currentRoute = parseHash(); listeners.forEach(fn => fn(currentRoute)); });

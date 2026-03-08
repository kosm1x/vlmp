let token = localStorage.getItem('vlmp_token');
export function setToken(t) { token = t; if (t) localStorage.setItem('vlmp_token', t); else localStorage.removeItem('vlmp_token'); }
export function getToken() { return token; }
export function isLoggedIn() { return !!token; }
export async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(path, { ...options, headers });
  if (res.status === 401) { setToken(null); window.location.hash = '#/login'; throw new Error('Unauthorized'); }
  if (res.status === 204) return null;
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}
export const get = (path) => api(path);
export const post = (path, body) => api(path, { method: 'POST', body: JSON.stringify(body) });
export const put = (path, body) => api(path, { method: 'PUT', body: JSON.stringify(body) });
export const del = (path) => api(path, { method: 'DELETE' });

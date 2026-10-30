export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json'); body = JSON.stringify(body);
  }
  const response = await fetch(path.startsWith('/api') ? path : `/api${path}`, { ...options, body, headers, credentials: 'include' });
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || data?.message || `Request failed (${response.status})`);
  return data;
}
export function download(path) { window.location.href = path.startsWith('/api') ? path : `/api${path}`; }
export function formatDate(value) { return value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
export function humanStatus(value) { return String(value || 'unknown').replaceAll('_',' ').replace(/\b\w/g, c => c.toUpperCase()); }

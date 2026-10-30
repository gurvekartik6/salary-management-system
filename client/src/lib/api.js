export async function api(path, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.method && !['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase()) && !headers.has('Idempotency-Key')) {
    headers.set('Idempotency-Key', crypto.randomUUID());
  }
  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body !== 'string') {
    headers.set('Content-Type', 'application/json'); body = JSON.stringify(body);
  }
  const url = path.startsWith('/api') ? path : `/api${path}`;
  let response;
  let lastError;
  const retryable = !options.method || ['GET', 'HEAD', 'OPTIONS'].includes(options.method.toUpperCase());
  const attempts = retryable ? 6 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      response = await fetch(url, { ...options, body, headers, credentials: 'include' });
      break;
    } catch (error) {
      lastError = error;
      if (attempt === 5) throw error;
      await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  if (!response) throw lastError || new Error('Request failed');
  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(data?.error || data?.message || `Request failed (${response.status})`);
  return data;
}
export function download(path) { window.location.href = path.startsWith('/api') ? path : `/api${path}`; }
export function formatDate(value) { return value ? new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : '—'; }
export function humanStatus(value) { return String(value || 'unknown').replaceAll('_',' ').replace(/\b\w/g, c => c.toUpperCase()); }

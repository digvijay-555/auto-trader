// ---------------------------------------------------------------------------
// API helpers — server base persistence and fetch wrapper
// ---------------------------------------------------------------------------
import { getToken, clearToken } from './auth';

export const SERVER_BASE_STORAGE_KEY = 'server_base';
export const SERVER_BASE_COOKIE = 'server_base';
export const DEFAULT_SERVER_BASE = '';

export function readCookie(name: string) {
  if (typeof document === 'undefined') return '';
  const prefix = `${name}=`;
  const entry = document.cookie.split('; ').find((item) => item.startsWith(prefix));
  return entry ? decodeURIComponent(entry.slice(prefix.length)) : '';
}

export function normalizeServerBase(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  return trimmed.replace(/\/+$/, '');
}

export function isValidServerBase(value: string) {
  const normalized = normalizeServerBase(value);
  if (!normalized) return true;

  try {
    const parsed = new URL(normalized);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function getStoredServerBase() {
  if (typeof window === 'undefined') return '';

  let saved = window.localStorage.getItem(SERVER_BASE_STORAGE_KEY) ?? '';
  const cookie = readCookie(SERVER_BASE_COOKIE);
  let base = normalizeServerBase(saved || cookie || (import.meta.env.VITE_API_BASE_URL ?? DEFAULT_SERVER_BASE));

  // Purge legacy/stale cloud domain if the user is visiting via IP or localhost or different host
  if (base.includes('axiosiiitl.dev') && !window.location.hostname.includes('axiosiiitl.dev')) {
    console.debug('[API Config] Purging stale axiosiiitl.dev serverBase from storage & cookie');
    window.localStorage.removeItem(SERVER_BASE_STORAGE_KEY);
    if (typeof document !== 'undefined') {
      document.cookie = `${SERVER_BASE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
    }
    base = '';
  }

  // If base matches the current window.location.origin, normalize to '' so requests are same-origin
  if (base) {
    try {
      const parsed = new URL(base);
      if (parsed.origin === window.location.origin) {
        base = '';
      }
    } catch (_) {}
  }

  console.debug('[API Config] Active server base:', base ? base : '(same-origin / relative)');
  return base;
}

export function persistServerBase(value: string) {
  let normalized = normalizeServerBase(value);

  // If user sets serverBase to match current origin, store as empty string
  if (normalized && typeof window !== 'undefined') {
    try {
      const parsed = new URL(normalized);
      if (parsed.origin === window.location.origin) {
        normalized = '';
      }
    } catch (_) {}
  }

  if (typeof window !== 'undefined') {
    if (normalized) window.localStorage.setItem(SERVER_BASE_STORAGE_KEY, normalized);
    else window.localStorage.removeItem(SERVER_BASE_STORAGE_KEY);
  }

  if (typeof document !== 'undefined') {
    document.cookie = normalized
      ? `${SERVER_BASE_COOKIE}=${encodeURIComponent(normalized)}; path=/; max-age=31536000; SameSite=Lax`
      : `${SERVER_BASE_COOKIE}=; path=/; max-age=0; SameSite=Lax`;
  }

  console.debug('[API Config] Persisted server base:', normalized ? normalized : '(same-origin / relative)');
  return normalized;
}

export function apiUrl(serverBase: string, path: string) {
  const normalized = normalizeServerBase(serverBase);
  if (normalized && !isValidServerBase(normalized)) return path;
  return normalized ? `${normalized}${path}` : path;
}

export function headersToObject(headers: Headers): Record<string, string> {
  const obj: Record<string, string> = {};
  headers.forEach((value, key) => {
    obj[key] = value;
  });
  return obj;
}

export function apiFetch(serverBase: string, path: string, init?: RequestInit) {
  const token = getToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const targetUrl = apiUrl(serverBase, path);
  const method = init?.method || 'GET';

  console.debug(`[API Request] ${method} ${targetUrl}`, {
    serverBase: serverBase || '(same-origin)',
    path,
    targetUrl,
    hasAuthToken: Boolean(token),
  });

  return fetch(targetUrl, { ...init, headers })
    .then(res => {
      console.debug(`[API Response] ${res.status} ${res.statusText} from ${targetUrl}`, {
        status: res.status,
        ok: res.ok,
        headers: headersToObject(res.headers),
      });
      if (res.status === 401) {
        console.warn(`[API Auth] 401 Unauthorized from ${path}. Clearing token.`);
        handleUnauthorized();
      }
      return res;
    })
    .catch(err => {
      console.error(`[API Error] Request failed for ${targetUrl}:`, err, {
        origin: typeof window !== 'undefined' ? window.location.origin : undefined,
        method,
        serverBase,
        path,
      });
      throw err;
    });
}

export function handleUnauthorized() {
  clearToken();
  if (typeof window !== 'undefined') {
    window.location.reload();
  }
}

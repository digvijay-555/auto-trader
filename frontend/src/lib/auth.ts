// ---------------------------------------------------------------------------
// JWT-like Token Management & Reactive Auth State
// ---------------------------------------------------------------------------

const TOKEN_KEY = 'at_session_token';

type AuthChangeListener = (hasWrite: boolean) => void;
const listeners = new Set<AuthChangeListener>();

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  if (typeof window === 'undefined') return;
  localStorage.setItem(TOKEN_KEY, token);
  notifyAuthChange();
}

export function clearToken(): void {
  if (typeof window === 'undefined') return;
  localStorage.removeItem(TOKEN_KEY);
  notifyAuthChange();
}

// Quick client-side check if the token exists and hasn't expired.
// (The server still validates this cryptographically on every mutation request)
export function isTokenValid(): boolean {
  const token = getToken();
  if (!token) return false;

  try {
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    // Decode the base64url payload with proper '=' padding
    let payloadBase64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    const pad = payloadBase64.length % 4;
    if (pad) {
      payloadBase64 += '='.repeat(4 - pad);
    }
    const payloadJson = atob(payloadBase64);
    const payload = JSON.parse(payloadJson);

    // exp is in seconds
    const now = Math.floor(Date.now() / 1000);
    return typeof payload.exp === 'number' && now < payload.exp;
  } catch {
    return false;
  }
}

export function hasWriteAccess(): boolean {
  return isTokenValid();
}

export function onAuthChange(listener: AuthChangeListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function notifyAuthChange(): void {
  const valid = hasWriteAccess();
  for (const listener of listeners) {
    try {
      listener(valid);
    } catch (e) {
      console.error(e);
    }
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('at_auth_change', { detail: { hasWrite: valid } }));
  }
}

// Listen for cross-tab token changes
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key === TOKEN_KEY) {
      notifyAuthChange();
    }
  });
}

/**
 * Minimal single-account login gate for the web app.
 *
 * Scope: this is a UI-level gate that sits in front of the whole SPA. It
 * authenticates against the daemon's `POST /api/auth/login` endpoint (the
 * daemon is the single source of truth for the credential check) and keeps a
 * lightweight session marker in browser storage. It is NOT server-side
 * security — the daemon's `/api/*` endpoints remain open, so this only keeps
 * casual users out of the UI, not out of the local HTTP API.
 *
 * Session semantics:
 *  - Default (no "remember me"): the session lives in `sessionStorage`, so a
 *    new browser/app session requires logging in again — matching "opening the
 *    app must ask for login first".
 *  - "Remember me": the session also lives in `localStorage`, so it survives
 *    restarts until the user logs out.
 *
 * Reading always checks both storages so a session written under either mode
 * keeps the user signed in until they explicitly log out.
 */

export interface AuthSession {
  version: number;
  username: string;
  loginAt: number;
}

export const DEFAULT_USERNAME = 'admin';
export const DEFAULT_PASSWORD = 'admin123';

export type LoginResult =
  | { ok: true; username: string }
  | { ok: false; error: 'invalid-credentials' | 'unavailable' };

const AUTH_SESSION_KEY = 'open-design:auth-session';
const AUTH_SESSION_VERSION = 1;

function readSessionFrom(storage: Storage): AuthSession | null {
  try {
    const raw = storage.getItem(AUTH_SESSION_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<AuthSession>;
    if (
      parsed &&
      parsed.version === AUTH_SESSION_VERSION &&
      typeof parsed.username === 'string' &&
      parsed.username.length > 0
    ) {
      return parsed as AuthSession;
    }
  } catch {
    // Corrupt or blocked storage — treat as logged out.
  }
  return null;
}

export function isAuthenticated(): boolean {
  return (
    (typeof sessionStorage !== 'undefined' && readSessionFrom(sessionStorage) !== null) ||
    (typeof localStorage !== 'undefined' && readSessionFrom(localStorage) !== null)
  );
}

/** 获取当前存储在浏览器中的用户名（用于服务端验证） */
export function getStoredUsername(): string | null {
  const session:any =
    (typeof sessionStorage !== 'undefined' && readSessionFrom(sessionStorage)) ||
    (typeof localStorage !== 'undefined' && readSessionFrom(localStorage));
  return session?.username ?? null;
}

/**
 * 异步调用 /api/auth/getUserName 验证服务端登录状态。
 * 如果服务端返回了用户名，说明已登录；否则未登录。
 */
export async function checkAuthStatus(): Promise<
  { ok: true; username: string } | { ok: false }
> {
  const username = getStoredUsername();
  if (!username) {
    return { ok: false };
  }

  try {
    const response = await fetch(
      `/api/auth/valid?username=${encodeURIComponent(username)}`,
    );
    if (!response.ok) {
      return { ok: false };
    }

    const data = (await response.json()) as { ok: boolean; username: string };
    if (data.ok && typeof data.username === 'string' && data.username.length > 0) {
      return { ok: true, username: data.username };
    }
  } catch {
    // 网络错误，视为未登录
  }

  return { ok: false };
}

/**
 * Validate credentials against the daemon (`POST /api/auth/login`) and persist
 * a session on success.
 *
 * Returns `{ ok: true, username }` on success, `{ ok: false, error:
 * 'invalid-credentials' }` when the daemon rejects the credentials, and
 * `{ ok: false, error: 'unavailable' }` when the daemon cannot be reached or
 * the session could not be persisted. The caller shows the appropriate error.
 */
export async function login(username: string, password: string, remember: boolean): Promise<LoginResult> {
  let response: Response;
  try {
    response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: username.trim(), password }),
    });
  } catch {
    return { ok: false, error: 'unavailable' };
  }

  if (response.status === 401) {
    return { ok: false, error: 'invalid-credentials' };
  }
  if (!response.ok) {
    return { ok: false, error: 'unavailable' };
  }

  let payload: { username?: unknown };
  try {
    payload = (await response.json()) as { username?: unknown };
  } catch {
    return { ok: false, error: 'unavailable' };
  }

  const sessionUsername =
    typeof payload.username === 'string' && payload.username.length > 0
      ? payload.username
      : username.trim();

  const session: AuthSession = {
    version: AUTH_SESSION_VERSION,
    username: sessionUsername,
    loginAt: Date.now(),
  };
  const storage = remember ? localStorage : sessionStorage;
  if (typeof storage === 'undefined') return { ok: false, error: 'unavailable' };
  try {
    storage.setItem(AUTH_SESSION_KEY, JSON.stringify(session));
  } catch {
    return { ok: false, error: 'unavailable' };
  }
  return { ok: true, username: sessionUsername };
}

/** Clear the session from every storage the gate could have written to. */
export function logout(): void {
  for (const storage of [sessionStorage, localStorage]) {
    if (typeof storage === 'undefined') continue;
    try {
      storage.removeItem(AUTH_SESSION_KEY);
    } catch {
      // Ignore storage that is unavailable (e.g. privacy mode).
    }
  }
}

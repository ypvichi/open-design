import { timingSafeEqual } from 'node:crypto';
import type { Express } from 'express';
import type { LoginRequest, LoginResponse } from '@open-design/contracts';

/**
 * Web login gate endpoint.
 *
 * The daemon is the single source of truth for the web login credential
 * check. Credentials are validated against one configured account:
 * `OD_WEB_USERNAME` / `OD_WEB_PASSWORD`, defaulting to `admin` / `admin123`.
 * This endpoint intentionally is NOT behind `requireLocalDaemonRequest` — the
 * web app must reach it from the browser before the gate has been passed.
 */

export const DEFAULT_WEB_USERNAME = 'admin';
export const DEFAULT_WEB_PASSWORD = 'admin123';

export interface RegisterAuthRoutesDeps {
  env: NodeJS.ProcessEnv;
  sendApiError: (...args: any[]) => any;
}

function timingSafeStringEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

export function registerAuthRoutes(app: Express, deps: RegisterAuthRoutesDeps): void {
  const { env, sendApiError } = deps;
  const expectedUsername = (env.OD_WEB_USERNAME ?? '').trim() || DEFAULT_WEB_USERNAME;
  const expectedPassword = env.OD_WEB_PASSWORD ?? DEFAULT_WEB_PASSWORD;

  app.post('/api/auth/login', (req, res) => {
    const body = (req.body ?? {}) as Partial<LoginRequest>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'username and password are required');
    }

    const usernameOk = timingSafeStringEquals(username, expectedUsername);
    const passwordOk = timingSafeStringEquals(password, expectedPassword);
    if (!usernameOk || !passwordOk) {
      return sendApiError(res, 401, 'UNAUTHORIZED', 'invalid username or password');
    }

    const response: LoginResponse = { ok: true, username };
    res.json(response);
  });
}

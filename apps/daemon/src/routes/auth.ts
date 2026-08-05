import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Express } from 'express';
import type { LoginRequest, LoginResponse, LogoutResponse, GetUserNameResponse } from '@open-design/contracts';
import { rawRequest, type Cookie } from '../http/http.js';
import * as crypto from 'crypto';

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

// 海康 CAS 公钥
const CAS_RSA_PEM = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQCqc90wxTr7Biug8nciEMrSygRg
Yvo31+shw+gxp0LqVbVCeGklV/Mwx7HXeGbbK9HHHAORE6lDgIb7tgCPZHygA2v
JtBhlhIy2IgHDpsp8Hv0UjwCML8/6KvChE3YChPffs6UUUgwJOQiDWOe/i2dCT4
J2p/AR1kFcd2UFEGaW1QIDAQAB
-----END PUBLIC KEY-----`;

export interface RegisterAuthRoutesDeps {
  env: NodeJS.ProcessEnv;
  sendApiError: (...args: any[]) => any;
  dataDir: string;
}

function timingSafeStringEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** SSO Session 持久化存储结构 */
interface SsoSession {
  cookies: Cookie[];
  username: string;
  loginAt: number;
}

/** 从 cookie jar 中提取 jwtToken（支持 JwtToken 和 jwtToken 两种大小写） */
function extractJwtToken(cookies: Cookie[]): string | undefined {
  return cookies.find(c => c.name === 'JwtToken' || c.name === 'jwtToken')?.value;
}

/** 读取 SSO 配置文件 */
function readSsoConfigFile(dataDir: string): SsoSession | null {
  const filePath = path.join(dataDir, 'config.sso.json');
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as SsoSession;
    if (data && Array.isArray(data.cookies) && typeof data.username === 'string') {
      return data;
    }
  } catch {
    // 文件不存在或格式错误，视为未登录
  }
  return null;
}

/** 写入 SSO 配置文件 */
function writeSsoConfigFile(dataDir: string, session: SsoSession): void {
  const filePath = path.join(dataDir, 'config.sso.json');
  try {
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), 'utf-8');
  } catch {
    // 写入失败时静默处理
  }
}

/** 删除 SSO 配置文件 */
function removeSsoConfigFile(dataDir: string): void {
  const filePath = path.join(dataDir, 'config.sso.json');
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // 删除失败时静默处理
  }
}

export function registerAuthRoutes(app: Express, deps: RegisterAuthRoutesDeps): void {
  const { env, sendApiError, dataDir } = deps;
  const expectedUsername = (env.OD_WEB_USERNAME ?? '').trim() || DEFAULT_WEB_USERNAME;
  const expectedPassword = env.OD_WEB_PASSWORD ?? DEFAULT_WEB_PASSWORD;

  function getSsoCookie(username: string): Cookie[] {
    const session = readSsoConfigFile(dataDir);
    if (!session || session.username !== username) return [];
    return session.cookies;
  }

  function setSsoSession(username: string, cookies: Cookie[]) {
    writeSsoConfigFile(dataDir, {
      cookies,
      username,
      loginAt: Date.now(),
    });
  }

  function clearSsoSession(_username: string) {
    removeSsoConfigFile(dataDir);
  }

  app.post('/api/auth/login', async (req, res) => {
    const body = (req.body ?? {}) as Partial<LoginRequest>;
    const username = typeof body.username === 'string' ? body.username.trim() : '';
    const password = typeof body.password === 'string' ? body.password : '';

    if (!username || !password) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'username and password are required');
    }

    // // 1. 先尝试本地认证（回退方案）
    // const usernameOk = timingSafeStringEquals(username, expectedUsername);
    // const passwordOk = timingSafeStringEquals(password, expectedPassword);
    // if (usernameOk && passwordOk) {
    //   const response: LoginResponse = { ok: true, username };
    //   return res.json(response);
    // }

    // 2. 本地认证失败，尝试海康 SSO 登录
    try {
      const ssoEntryUrl = `http://sso.hikvision.com.cn/domino/login?RedirectTo=${Buffer.from('http://hicoo.hikvision.com.cn/algomarket/algorithmRetrieval').toString('base64')}`;

      // Step 1: GET SSO login page
      const step1 = await rawRequest('GET', ssoEntryUrl, []);
      if (step1.status !== 200) {
        return sendApiError(res, 401, 'UNAUTHORIZED', 'SSO login page unavailable');
      }

      const ltMatch = step1.body.match(/name="lt"\s+value="([^"]+)"/);
      const executionMatch = step1.body.match(/name="execution"\s+value="([^"]+)"/);
      const saltMatch = step1.body.match(/id="salt"\s+value="([^"]+)"/);

      if (!ltMatch || !executionMatch) {
        return sendApiError(res, 401, 'UNAUTHORIZED', 'SSO form fields not found');
      }

      const lt = ltMatch[1]!;
      const execution = executionMatch[1]!;

      // Step 2: POST credentials
      const salt = saltMatch?.[1] ?? '';
      const encPwd = salt
        ? crypto.publicEncrypt(
            { key: CAS_RSA_PEM, padding: crypto.constants.RSA_PKCS1_PADDING },
            Buffer.from(salt + password),
          ).toString('base64')
        : password;

      const today = new Date();
      const mm = String(today.getMonth() + 1).padStart(2, '0');
      const dd = String(today.getDate()).padStart(2, '0');
      const formBody = new URLSearchParams({
        username,
        password: encPwd,
        lt,
        execution,
        _eventId: 'submit',
        ver: '2.0',
        loginForm: 'qrLoginForm',
        localDate: `${today.getFullYear()}-${mm}-${dd}`,
        fingerprint: '',
      }).toString();

      const step2 = await rawRequest('POST', step1.finalUrl, step1.cookies, {
        body: formBody,
        extraHeaders: { Referer: step1.finalUrl, Origin: new URL(step1.finalUrl).origin },
      });

      const hasJwt = step2.cookies.some(c => c.name === 'JwtToken');
      const hasLtpa = step2.cookies.some(c => c.name === 'LtpaToken');

      if (!hasJwt || !hasLtpa) {
        return sendApiError(res, 401, 'UNAUTHORIZED', 'invalid username or password');
      }

      // 将 SSO cookie 存入内存
      setSsoSession(username, step2.cookies);

      const response: any = { ok: true, username,step1,step2 };
      res.json(response);
    } catch (err) {
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'SSO login failed');
    }
  });

  app.post('/api/auth/logout', async (req, res) => {
    try {
      // 尝试从请求体中获取用户名，清除对应的 SSO session
      const body = (req.body ?? {}) as Partial<{ username: string }>;
      if (body.username) {
        clearSsoSession(body.username);
      }

      const ssoLogoutUrl = `http://sso.hikvision.com.cn/domino/dominoLogout?RedirectTo=${Buffer.from('http://hicoo.hikvision.com.cn/algomarket/algorithmRetrieval').toString('base64')}`;
      await rawRequest('GET', ssoLogoutUrl, []);
      const response: LogoutResponse = { ok: true };
      res.json(response);
    } catch (err) {
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'SSO logout failed');
    }
  });

  // GET /api/auth/valid — 验证海康 SSO 登录状态
  // 如果存储的 cookie 中包含 jwtToken（不区分大小写），则直接认为已登录
  app.get('/api/auth/valid', async (req, res) => {
    try {
      // 从查询参数中获取用户名
      const username = typeof req.query.username === 'string' ? req.query.username : '';
      if (!username) {
        const response: GetUserNameResponse = { ok: true, username: '' };
        return res.json(response);
      }

      const cookies = getSsoCookie(username);
      const jwtToken = extractJwtToken(cookies);

      // 如果存储的 cookie 中包含 jwtToken，直接认为已登录
      if (jwtToken) {
        const response: GetUserNameResponse = { ok: true, username };
        return res.json(response);
      }

      // 没有 jwtToken，视为未登录
      const response: GetUserNameResponse = { ok: true, username: '' };
      return res.json(response);
    } catch (err) {
      return sendApiError(res, 500, 'INTERNAL_ERROR', 'auth valid failed');
    }
  });
}

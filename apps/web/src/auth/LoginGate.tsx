import { useLayoutEffect, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';

import { Icon } from '../components/Icon';
import {
  DEFAULT_PASSWORD,
  DEFAULT_USERNAME,
  checkAuthStatus,
  login,
} from './auth';
import styles from './LoginGate.module.css';

interface LoginGateProps {
  children: ReactNode;
}

/**
 * Login gate wrapping the whole SPA.
 *
 * Session state is tri-state so the login screen can never flash on entry:
 *  - `null` (unknown): initial server + first client render. A neutral
 *    full-screen surface is shown (no login card, no app content) until a
 *    layout effect confirms the real session state. The browser-painted
 *    pre-hydration HTML therefore never contains the login overlay.
 *  - `true`: a session exists → app unlocked.
 *  - `false`: no session → app locked behind the login screen.
 *
 * While locked or confirming, the app stays mounted underneath (wrapped in
 * `inert` + `aria-hidden`) so the desktop splash reveal
 * (`data-od-app-mounted`), the theme application and the white-screen
 * detector all keep working. The login screen is an inline fixed overlay on
 * top (kept in-tree — not a portal — so the server-rendered HTML matches
 * hydration) until the built-in account signs in.
 */
export function LoginGate({ children }: LoginGateProps) {
  // Unknown everywhere (server + first client render) so the prerendered HTML
  // never contains the login overlay; sync the real session state in a layout
  // effect before paint — a returning user never sees a login flash, and
  // SSR/prerender never touches browser storage or `document`.
  const [authed, setAuthed] = useState<boolean | null>(null);
  useLayoutEffect(() => {
    checkAuthStatus().then((result) => {
      setAuthed(result.ok);
    });
  }, []);

  if (authed === null) {
    // Session state not confirmed yet: keep the app mounted underneath but
    // cover it with a neutral surface so neither the app nor the login screen
    // flashes before the check completes.
    return (
      <div className={styles.appLocked} inert aria-hidden>
        {children}
        <div className={styles.bootSurface} aria-hidden />
      </div>
    );
  }

  return (
    <>
      <div
        className={authed ? undefined : styles.appLocked}
        inert={!authed}
        aria-hidden={!authed}
      >
        {children}
      </div>
      {!authed ? <LoginScreen onAuthed={() => setAuthed(true)} /> : null}
    </>
  );
}

function LoginScreen({ onAuthed }: { onAuthed: () => void }) {
  // Pre-fill the built-in account so the default credentials are one click
  // away; the user can clear and type their own values if changed later.
  const [username, setUsername] = useState(DEFAULT_USERNAME);
  const [password, setPassword] = useState(DEFAULT_PASSWORD);
  const [remember, setRemember] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const name = username.trim();
    if (!name || !password) {
      setError('请输入用户名和密码');
      return;
    }
    setPending(true);
    try {
      const result = await login(name, password, remember);
      if (result.ok) {
        onAuthed();
      } else if (result.error === 'invalid-credentials') {
        setError('用户名或密码错误');
      } else {
        setError('无法连接本地服务，请稍后重试');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.topLeftLogo}>
        <span className="od-brand-glyph" style={{ width: 80, height: 80, display: 'inline-block' }} />
      </div>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandMark} aria-hidden>
            <Icon name="lock" size={20} />
          </span>
          <h1 className={styles.title}>Open Design</h1>
          <p className={styles.subtitle}>登录以进入工作区</p>
        </div>

        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>用户名</span>
            <input
              className={styles.input}
              type="text"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="用户名"
              autoComplete="username"
              autoFocus
              spellCheck={false}
            />
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>密 码</span>
            <span className={styles.inputWrap}>
              <input
                className={styles.input}
                type={showPassword ? 'text' : 'password'}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="密码"
                autoComplete="current-password"
              />
              <button
                type="button"
                className={styles.passwordToggle}
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? '隐藏密码' : '显示密码'}
                style={{padding:"0"}}
              >
                <Icon name={showPassword ? 'eye-off' : 'eye'} size={16} />
              </button>
            </span>
          </label>

          <label className={styles.remember}>
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            <span>记住登录状态</span>
          </label>

          {error ? <p className={styles.error}>{error}</p> : null}

          <button type="submit" className={styles.submit} disabled={pending}>
            {pending ? '登录中…' : '登录'}
          </button>
        </form></div>
    </div>
  );
}

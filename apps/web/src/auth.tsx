import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';

async function authPost(path: string, body: unknown) {
  const response = await fetch(`/api/auth/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message ?? data.error_description ?? '认证失败');
  return data;
}
export function AuthGate({ children }: { children: ReactNode }) {
  const client = useQueryClient();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const session = useQuery({
    queryKey: ['session'],
    queryFn: async () => {
      const r = await fetch('/api/session');
      if (!r.ok) throw new Error('无法验证登录状态');
      return r.json();
    },
    refetchInterval: 5000,
  });
  if (!session.data)
    return (
      <main className="auth-panel">
        {session.error ? '无法验证登录状态，请刷新重试。' : '正在验证登录状态…'}
      </main>
    );
  if (session.data.mode === 'local') return children;
  const params = new URLSearchParams(window.location.search);
  const oauthQuery = params.has('client_id') ? window.location.search.slice(1) : undefined;
  async function action(fn: () => Promise<void>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : '认证失败');
    } finally {
      setBusy(false);
    }
  }
  if (!session.data.authenticated || window.location.pathname === '/login')
    return (
      <main className="auth-panel">
        <h1>Acornary 登录</h1>
        <p>仅限预置的所有者账号。</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            void action(async () => {
              const result = await authPost('sign-in/email', {
                email: form.get('email'),
                password: form.get('password'),
                ...(oauthQuery ? { oauth_query: oauthQuery } : {}),
              });
              // A redirect comes only from the server's validated OAuth flow, never
              // directly from the untrusted redirect_uri query parameter.
              window.location.assign(result.redirect_uri ?? result.url ?? '/');
            });
          }}
        >
          <label>
            邮箱
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            密码
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
          <button disabled={busy} type="submit">
            登录
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
      </main>
    );
  if (window.location.pathname === '/consent')
    return (
      <main className="auth-panel">
        <h1>授权访问 Acornary</h1>
        <p>以下客户端请求访问同一份家庭库存：</p>
        <code>{params.get('client_id')}</code>
        <p>请求的权限：</p>
        <ul>
          {(params.get('scope') ?? '')
            .split(' ')
            .filter(Boolean)
            .map((scope) => (
              <li key={scope}>
                {scope === 'inventory:read'
                  ? '读取库存、笔记及历史'
                  : scope === 'inventory:write'
                    ? '修改库存与文字笔记'
                    : scope === 'offline_access'
                      ? '保持连接（刷新授权最长 30 天）'
                      : scope}
              </li>
            ))}
        </ul>
        <p>只在你刚刚从 Codex 或 ChatGPT 发起连接时授权。</p>
        {['拒绝', '允许'].map((label, i) => (
          <button
            key={label}
            disabled={busy || !oauthQuery}
            onClick={() =>
              void action(async () => {
                const result = await authPost('oauth2/consent', {
                  accept: !!i,
                  oauth_query: oauthQuery,
                });
                if (!result.redirect_uri && !result.url) throw new Error('授权结果缺少重定向地址');
                window.location.assign(result.redirect_uri ?? result.url);
              })
            }
          >
            {label}
          </button>
        ))}
        {error && <p role="alert">{error}</p>}
      </main>
    );
  return (
    <>
      <div className="session-bar">
        云端库存 · 只读检查器{' '}
        <button
          disabled={busy}
          onClick={() =>
            void action(async () => {
              await authPost('sign-out', {});
              client.clear();
              window.location.assign('/login');
            })
          }
        >
          退出登录
        </button>
        {error && <span role="alert">{error}</span>}
      </div>
      {children}
    </>
  );
}

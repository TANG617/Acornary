import { isIP } from 'node:net';
export type RuntimeConfig =
  | { mode: 'local' }
  | { mode: 'cloud'; origin: string; resource: string; secret: string; trustedProxy: string };

// Cloud configuration is deliberately fail-closed: no PAT or localhost fallback.
export function runtimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  const mode = env.ACORNARY_MODE ?? 'local';
  if (mode === 'local') return { mode };
  if (mode !== 'cloud') throw new Error('ACORNARY_MODE must be local or cloud.');
  const origin = env.ACORNARY_ORIGIN;
  const secret = env.BETTER_AUTH_SECRET;
  const trustedProxy = env.ACORNARY_TRUSTED_PROXY;
  if (!origin || !secret || secret.length < 32 || !trustedProxy)
    throw new Error(
      'Cloud requires ACORNARY_ORIGIN, BETTER_AUTH_SECRET (32+ characters), and ACORNARY_TRUSTED_PROXY.',
    );
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.origin !== origin || url.username || url.password)
    throw new Error('ACORNARY_ORIGIN must be an HTTPS origin without a path.');
  if (isIP(trustedProxy) !== 4)
    throw new Error('ACORNARY_TRUSTED_PROXY must be the exact private IPv4 address of Caddy.');
  return { mode, origin, resource: `${origin}/mcp`, secret, trustedProxy };
}

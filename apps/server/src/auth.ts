import { betterAuth } from 'better-auth';
import { jwt } from 'better-auth/plugins';
import { mcp } from '@better-auth/mcp';
import { cimd } from '@better-auth/cimd';
import { fetchClientMetadataResource } from '@better-auth/cimd/node';
import type { RuntimeConfig } from './config.js';
import { pool, query } from './db.js';
import type { Context } from './service.js';

export const inventoryScopes = ['inventory:read', 'inventory:write'] as const;
export function createAuth(config: Extract<RuntimeConfig, { mode: 'cloud' }>) {
  return betterAuth({
    appName: 'Acornary',
    baseURL: config.origin,
    basePath: '/api/auth',
    secret: config.secret,
    database: pool,
    logger: { disabled: true },
    trustedOrigins: [config.origin],
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 12 },
    session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
    advanced: { useSecureCookies: true, ipAddress: { ipAddressHeaders: ['x-real-ip'] } },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      customRules: { '/sign-in/email': { window: 60, max: 5 } },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            if (!(await ownerContext(session.userId))) return false;
          },
        },
      },
    },
    plugins: [
      jwt(),
      mcp({
        resource: config.resource,
        loginPage: '/login',
        consentPage: '/consent',
        scopes: ['openid', 'profile', 'email', 'offline_access', ...inventoryScopes],
        grantTypes: ['authorization_code', 'refresh_token'],
        accessTokenExpiresIn: 300,
        refreshTokenExpiresIn: 30 * 24 * 60 * 60,
        refreshTokenReuseInterval: 0,
        allowDynamicClientRegistration: false,
        allowUnauthenticatedClientRegistration: false,
        clientPrivileges: async () => false,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: 'mcp-2026-07-28' }),
    ],
  });
}
export type Auth = ReturnType<typeof createAuth>;

// Never accept an actor/household chosen by the client. Recheck on every request,
// including JWT requests, so disabling the owner takes effect immediately.
export async function ownerContext(userId: string): Promise<Context | null> {
  const row = (
    await query(
      pool,
      'SELECT household_id,actor_id FROM auth_owners WHERE user_id=$1 AND enabled=true',
      [userId],
    )
  ).rows[0];
  return row ? { ...row, source: 'MCP' } : null;
}

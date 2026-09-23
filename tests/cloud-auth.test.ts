import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { initialize } from '../apps/server/src/initialize.js';
import { buildApp } from '../apps/server/src/app.js';
import { createAuth, ownerContext } from '../apps/server/src/auth.js';
import { manageOwner } from '../apps/server/src/owner.js';
import { pool, query } from '../apps/server/src/db.js';
import type { RuntimeConfig } from '../apps/server/src/config.js';

// Only the external CIMD transport is replaced; provider parsing, signatures,
// PKCE, consent, token issuance, JWT verification and database are real.
vi.mock('@better-auth/cimd/node', () => ({
  fetchClientMetadataResource: async (input: any) => {
    const client_id = String(input);
    if (!client_id.startsWith('https://client.example.test/'))
      throw new Error('Unexpected test URL');
    return Response.json({
      client_id,
      client_name: 'Isolated acceptance client',
      redirect_uris: ['http://127.0.0.1:45219/callback'],
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      scope: 'openid offline_access inventory:read inventory:write',
    });
  },
}));
const config: Extract<RuntimeConfig, { mode: 'cloud' }> = {
  mode: 'cloud',
  origin: 'https://auth.example.test',
  resource: 'https://auth.example.test/mcp',
  trustedProxy: '172.30.78.10',
  secret: 'isolated-test-only-secret-at-least-32-characters',
};
const email = `owner-${randomUUID()}@example.test`,
  password = 'Isolated-test-password-123!';
let app: Awaited<ReturnType<typeof buildApp>>, auth: ReturnType<typeof createAuth>, ctx: any;
let cookie: string, userId: string;
const headers = {
  host: 'auth.example.test',
  'x-forwarded-proto': 'https',
  origin: config.origin,
  'x-real-ip': '203.0.113.10',
};
const inject = (options: any) =>
  app.inject({
    ...options,
    remoteAddress: config.trustedProxy,
    headers: { ...headers, ...options.headers },
  });
const jsonPost = (url: string, payload: any, extra = {}) =>
  inject({
    method: 'POST',
    url,
    payload,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...extra },
  });
const tokenPost = (payload: Record<string, string>) =>
  inject({
    method: 'POST',
    url: '/api/auth/oauth2/token',
    payload: new URLSearchParams(payload).toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
  });
const call = (token: string, name = 'query_items', args: any = {}) =>
  jsonPost(
    '/mcp',
    {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name,
        arguments: args,
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': { name: 'cloud-auth-test', version: '1' },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    },
    {
      authorization: `Bearer ${token}`,
      accept: 'application/json, text/event-stream',
      'mcp-protocol-version': '2026-07-28',
      'mcp-method': 'tools/call',
      'mcp-name': name,
    },
  );

beforeAll(async () => {
  if (!new URL(process.env.DATABASE_URL!).pathname.endsWith('acornary_test'))
    throw new Error('Isolated acornary_test required');
  ctx = { ...(await initialize()), source: 'TEST' };
  // Only remove an owner from earlier isolated test runs, never business rows.
  await query(pool, 'DELETE FROM "user" WHERE id IN (SELECT user_id FROM auth_owners)');
  await manageOwner('create', email, password);
  userId = (await query(pool, 'SELECT user_id FROM auth_owners')).rows[0].user_id;
  auth = createAuth(config);
  app = await buildApp(ctx, 'a-local-token-is-not-a-cloud-credential', false, config);
  await app.ready();
  const realFetch = globalThis.fetch;
  vi.stubGlobal('fetch', async (input: any, init: any) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === `${config.origin}/api/auth/jwks`) return auth.handler(new Request(url, init));
    return realFetch(input, init);
  });
});
afterAll(async () => {
  vi.unstubAllGlobals();
  await app?.close();
  await pool.end();
});

async function grant(scope = 'openid offline_access inventory:read inventory:write') {
  const client_id = `https://client.example.test/${randomUUID()}.json`;
  const verifier = randomUUID() + randomUUID();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id,
    redirect_uri: 'http://127.0.0.1:45219/callback',
    scope,
    resource: config.resource,
    state: 'test-state',
    code_challenge_method: 'S256',
    code_challenge: createHash('sha256').update(verifier).digest('base64url'),
  });
  const authorize = await inject({
    url: `/api/auth/oauth2/authorize?${params}`,
    headers: { cookie, accept: 'text/html' },
  });
  expect(authorize.statusCode, authorize.body).toBe(302);
  const location = new URL(authorize.headers.location!, config.origin);
  expect(location.pathname).toBe('/consent');
  const consent = await jsonPost(
    '/api/auth/oauth2/consent',
    { accept: true, oauth_query: location.search.slice(1) },
    { cookie },
  );
  expect(consent.statusCode, consent.body).toBe(200);
  const callback = new URL(consent.json().redirect_uri ?? consent.json().url);
  expect(callback.searchParams.get('state')).toBe('test-state');
  expect(callback.searchParams.get('iss')).toBe(`${config.origin}/api/auth`);
  const result = await tokenPost({
    grant_type: 'authorization_code',
    client_id,
    code: callback.searchParams.get('code')!,
    code_verifier: verifier,
    redirect_uri: 'http://127.0.0.1:45219/callback',
    resource: config.resource,
  });
  expect(result.statusCode, result.body).toBe(200);
  return { client_id, ...result.json() };
}

describe('cloud OAuth and private inspector', () => {
  it('rejects anonymous/private access, wrong ingress, PAT, signup and signing endpoints', async () => {
    for (const url of ['/api/context', '/api/read/query_items', '/api/debug'])
      expect((await inject({ url })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/session', headers })).statusCode).toBe(403);
    expect(
      (await inject({ url: '/api/session', headers: { origin: 'https://evil.test' } })).statusCode,
    ).toBe(403);
    expect((await call('a-local-token-is-not-a-cloud-credential')).statusCode).toBe(401);
    for (const path of ['sign-up/email', 'sign-jwt', 'token', 'oauth2/register'])
      expect((await jsonPost(`/api/auth/${path}`, {})).statusCode).toBe(404);
    const discovery = await inject({ url: '/.well-known/oauth-authorization-server/api/auth' });
    expect(discovery.statusCode, discovery.body).toBe(200);
    expect(discovery.json()).toMatchObject({
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });
    expect(discovery.json()).not.toHaveProperty('registration_endpoint');
  });
  it('logs in with a secure cookie and maps to the existing installation', async () => {
    const r = await jsonPost('/api/auth/sign-in/email', { email, password });
    expect(r.statusCode, r.body).toBe(200);
    const cookies = r.headers['set-cookie'] as string[];
    cookie = cookies.map((s) => s.split(';')[0]).join('; ');
    expect(cookies.join(';')).toMatch(/Secure/i);
    expect(cookies.join(';')).toMatch(/HttpOnly/i);
    expect(await ownerContext(userId)).toMatchObject({
      actor_id: ctx.actor_id,
      household_id: ctx.household_id,
    });
    expect((await inject({ url: '/api/context', headers: { cookie } })).json().household.id).toBe(
      ctx.household_id,
    );
    const r2 = await inject({
      url:
        '/api/debug?input=' + encodeURIComponent(JSON.stringify({ view: 'table', table: 'user' })),
      headers: { cookie },
    });
    expect(r2.statusCode).not.toBe(200);
  });
  it('performs CIMD, consent, PKCE, bound JWT, per-tool scopes and idempotent replay', async () => {
    const grantResult = await grant();
    expect(grantResult.expires_in).toBe(300);
    const claims = JSON.parse(
      Buffer.from(grantResult.access_token.split('.')[1], 'base64url').toString(),
    );
    expect(claims.sub).toBe(userId);
    expect(claims.aud).toContain(config.resource);
    expect(claims.exp - claims.iat).toBe(300);
    const args = { name: 'OAuth isolated SKU', kind: 'SKU', idempotency_key: randomUUID() };
    const first = await call(grantResult.access_token, 'create_catalog_node', args);
    expect(first.statusCode, first.body).toBe(200);
    const second = await call(grantResult.access_token, 'create_catalog_node', args);
    expect(second.json().result.structuredContent).toEqual(first.json().result.structuredContent);
    expect(first.json().result.isError).not.toBe(true);
    const secondClient = await grant();
    const catalog_node_id = first.json().result.structuredContent.affected_objects[0].id;
    const created = await call(grantResult.access_token, 'create_items', {
      catalog_node_id,
      count: 1,
      idempotency_key: randomUUID(),
      initial_attributes: [
        {
          template_id: 'contents',
          template_version: 1,
          values: { remaining: { value: '1000', unit: 'mL' }, accuracy: 'MEASURED' },
        },
      ],
    });
    const item_id = created.json().result.structuredContent.affected_objects[0].id;
    const concurrent = await Promise.all(
      [grantResult, secondClient].map((g) =>
        call(g.access_token, 'consume_item_content', {
          item_id,
          expected_revisions: { [item_id]: 1 },
          idempotency_key: randomUUID(),
          amount: { value: '200', unit: 'mL' },
          accuracy: 'MEASURED',
        }),
      ),
    );
    expect(concurrent.filter((r) => r.json().result.isError)).toHaveLength(1);
    expect(
      concurrent.find((r) => r.json().result.isError)!.json().result.structuredContent.error.code,
    ).toBe('REVISION_CONFLICT');
    const current = await call(secondClient.access_token, 'get_item', { item_id });
    expect(current.json().result.structuredContent.revision).toBe(2);
    const ownEvents = (
      await query(pool, 'SELECT actor_id FROM events WHERE target_id=$1', [item_id])
    ).rows;
    expect(ownEvents.every((row) => row.actor_id === ctx.actor_id)).toBe(true);
    const readGrant = await grant('offline_access inventory:read');
    const denied = await call(readGrant.access_token, 'create_catalog_node', args);
    expect(denied.statusCode).toBe(403);
    expect(denied.headers['www-authenticate']).toContain('inventory:write');
    expect((await call(readGrant.access_token)).statusCode).toBe(200);
    const rotated = await tokenPost({
      grant_type: 'refresh_token',
      client_id: grantResult.client_id,
      refresh_token: grantResult.refresh_token,
      resource: config.resource,
    });
    expect(rotated.statusCode, rotated.body).toBe(200);
    expect(rotated.json().refresh_token).not.toBe(grantResult.refresh_token);
    expect(
      (
        await tokenPost({
          grant_type: 'refresh_token',
          client_id: grantResult.client_id,
          refresh_token: grantResult.refresh_token,
          resource: config.resource,
        })
      ).statusCode,
    ).toBe(400);
    await manageOwner('revoke-grants', email);
    expect(
      (
        await tokenPost({
          grant_type: 'refresh_token',
          client_id: readGrant.client_id,
          refresh_token: readGrant.refresh_token,
          resource: config.resource,
        })
      ).statusCode,
    ).toBe(400);
    // A revoked grant's existing JWT is valid for at most its original 5 minutes.
    expect((await call(readGrant.access_token)).statusCode).toBe(200);
    await manageOwner('disable', email);
    expect((await call(readGrant.access_token)).statusCode).toBe(403);
    expect((await inject({ url: '/api/context', headers: { cookie } })).statusCode).toBe(401);
    await manageOwner('enable', email);
  });
  it('rejects correctly signed tokens with wrong audience, issuer or expiry', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const override of [
      { aud: 'https://wrong.example.test/mcp' },
      { iss: 'https://wrong.example.test' },
      { exp: now - 60 },
    ]) {
      const signed = await auth.api.signJWT({
        body: {
          payload: {
            sub: userId,
            client_id: 'test',
            scope: 'inventory:read inventory:write',
            iss: `${config.origin}/api/auth`,
            aud: config.resource,
            iat: now,
            exp: now + 300,
            ...override,
          },
        },
      });
      expect((await call(signed.token)).statusCode).toBe(401);
    }
  });
});

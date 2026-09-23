import { debugRead } from './debug.js';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { localhostHostValidation } from '@modelcontextprotocol/fastify';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { AsyncLocalStorage } from 'node:async_hooks';
import { requireMcpAuth } from '@better-auth/mcp';
import { createInsufficientScopeError } from 'better-auth/oauth2';
import { createAuth, ownerContext, inventoryScopes } from './auth.js';
import { runtimeConfig, type RuntimeConfig } from './config.js';
import type { FastifyRequest, FastifyReply } from 'fastify';
import {
  schemas,
  reads,
  descriptions,
  type Operation,
} from '../../../packages/contracts/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import { execute, type Context } from './service.js';
import { pool, query } from './db.js';
export async function buildApp(
  ctx: Context,
  token: string,
  serveStatic = true,
  config: RuntimeConfig = runtimeConfig(),
) {
  const cloud = config.mode === 'cloud' ? config : null;
  const auth = cloud ? createAuth(cloud) : null;
  const identities = new AsyncLocalStorage<{
    ctx: Context;
    scopes: Set<string>;
    clientId: string;
  }>();
  const webContexts = new WeakMap<FastifyRequest, Context>();
  const headersFor = (req: FastifyRequest) => {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
    return headers;
  };
  const requestFor = (req: FastifyRequest) =>
    new Request(`${cloud?.origin ?? `http://${req.headers.host}`}${req.url}`, {
      method: req.method,
      headers: headersFor(req),
      ...(!['GET', 'HEAD'].includes(req.method) && req.body !== undefined
        ? { body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body) }
        : {}),
    });
  const sendResponse = (reply: FastifyReply, response: Response) => {
    reply.code(response.status);
    response.headers.forEach((value, key) => {
      if (key !== 'set-cookie') reply.header(key, value);
    });
    const cookies = response.headers.getSetCookie();
    if (cookies.length) reply.header('set-cookie', cookies);
    return response.body ? reply.send(Readable.fromWeb(response.body as any)) : reply.send();
  };
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
    },
    // OAuth URLs contain authorization codes. Do not log request URLs or bodies.
    disableRequestLogging: true,
    trustProxy: cloud ? [cloud.trustedProxy] : false,
    requestTimeout: 30000,
    bodyLimit: 1024 * 1024,
  });
  if (!cloud) app.addHook('onRequest', localhostHostValidation());
  app.addHook('onRequest', async (req, reply) => {
    if (
      cloud &&
      req.url !== '/health' &&
      (req.socket.remoteAddress?.replace(/^::ffff:/, '') !== cloud.trustedProxy ||
        req.headers.host !== new URL(cloud.origin).host ||
        req.headers['x-forwarded-proto'] !== 'https')
    )
      return reply.code(403).send({ error: { code: 'FORBIDDEN', message: 'Untrusted ingress.' } });
    if (
      req.headers.origin &&
      req.headers.origin !== (cloud?.origin ?? `http://${req.headers.host}`)
    )
      return reply
        .code(403)
        .send({ error: { code: 'FORBIDDEN', message: 'Cross-origin access denied.' } });
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (cloud)
      reply.header(
        'Content-Security-Policy',
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
      );
    if (auth && /^\/api\/(context|read(?:\/|$)|debug(?:\?|$))/.test(req.url)) {
      const session = await auth.api.getSession({ headers: headersFor(req) });
      const context = session && (await ownerContext(session.user.id));
      if (!context)
        return reply
          .code(401)
          .send({ error: { code: 'UNAUTHORIZED', message: 'Owner login required.' } });
      webContexts.set(req, context);
    }
  });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof DomainError)
      return reply
        .code(error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 400)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    app.log.error({ code: error.code ?? 'INTERNAL_ERROR' }, 'Request failed');
    return reply
      .code(error.statusCode ?? 500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Request failed.' } });
  });
  app.get('/health', async () => {
    await query(pool, 'SELECT 1');
    return { status: 'ok' };
  });
  app.get('/api/session', async (req) => {
    if (!auth) return { mode: 'local', authenticated: true };
    const session = await auth.api.getSession({ headers: headersFor(req) });
    const allowed = session && (await ownerContext(session.user.id));
    return { mode: 'cloud', authenticated: !!allowed };
  });
  if (auth) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_req, body, done) => done(null, body),
    );
    const publicAuthPaths = new Set([
      '/sign-in/email',
      '/sign-out',
      '/get-session',
      '/jwks',
      '/oauth2/authorize',
      '/oauth2/token',
      '/oauth2/consent',
      '/oauth2/continue',
      '/oauth2/revoke',
      '/oauth2/introspect',
      '/oauth2/userinfo',
      '/.well-known/openid-configuration',
      '/.well-known/oauth-authorization-server',
    ]);
    const handler = async (req: FastifyRequest, reply: FastifyReply) => {
      const path = req.url.split('?')[0];
      if (path.startsWith('/api/auth/') && !publicAuthPaths.has(path.slice('/api/auth'.length)))
        return reply.code(404).send({ error: 'not_found' });
      return sendResponse(reply, await auth.handler(requestFor(req)));
    };
    app.route({ method: ['GET', 'POST'], url: '/api/auth/*', handler });
    app.get('/.well-known/*', handler);
  }
  app.get('/api/context', async (req) => {
    const context = webContexts.get(req) ?? ctx;
    const household = (
      await query(pool, 'SELECT * FROM households WHERE id=$1', [context.household_id])
    ).rows[0];
    const install = (
      await query(pool, 'SELECT container_catalog_id FROM installations WHERE household_id=$1', [
        context.household_id,
      ])
    ).rows[0];
    return { household, container_catalog_id: install?.container_catalog_id };
  });
  app.get('/api/read/:operation', async (req) => {
    const name = (req.params as any).operation as Operation;
    if (!reads.has(name)) throw new DomainError('FORBIDDEN', 'This HTTP interface is read-only.');
    let input: unknown = {};
    try {
      input = JSON.parse((req.query as any).input ?? '{}');
    } catch {
      throw new DomainError('ATTRIBUTE_VALIDATION_FAILED', 'Invalid JSON query.');
    }
    return execute({ ...(webContexts.get(req) ?? ctx), source: 'WEB' }, name, input);
  });
  app.get('/api/debug', async (req) => {
    let input: unknown;
    try {
      input = JSON.parse((req.query as any).input ?? '{}');
    } catch {
      throw new DomainError('ATTRIBUTE_VALIDATION_FAILED', 'Invalid JSON query.');
    }
    return debugRead({ ...(webContexts.get(req) ?? ctx), source: 'WEB_DEBUG' }, input);
  });
  const mcp = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'acornary', version: '0.1.0' },
      {
        instructions:
          'Acornary 管理具体物品。先查询 UUID、属性和 revision，再进行明确的写操作。已知差异影响选择时先澄清；在用户确认范围内没有已知差异时可选择并报告实际 UUID。不得猜测缺失事实；推荐不自动变为库存写入。写操作携带幂等键与 expected_revisions；超时重试保留原键和参数。版本冲突后重新查询并判断原操作是否仍成立，不自动替换 revision 强行重试。未记录状态不等于 ACTIVE。Web 只读。模板字段与单位通过 list_attribute_templates/get_attribute_template 发现。',
      },
    );
    for (const name of Object.keys(schemas) as Operation[])
      server.registerTool(
        name,
        {
          description: descriptions[name],
          inputSchema: schemas[name] as any,
          annotations: {
            readOnlyHint: reads.has(name),
            destructiveHint: !reads.has(name),
            idempotentHint: true,
            openWorldHint: false,
          },
          ...(cloud
            ? {
                _meta: {
                  securitySchemes: [
                    {
                      type: 'oauth2',
                      scopes: [reads.has(name) ? 'inventory:read' : 'inventory:write'],
                    },
                  ],
                },
              }
            : {}),
        },
        async (args: any) => {
          try {
            const identity = identities.getStore();
            if (
              cloud &&
              (!identity ||
                !identity.scopes.has(reads.has(name) ? 'inventory:read' : 'inventory:write'))
            )
              throw new DomainError('FORBIDDEN', 'OAuth scope is required.');
            const result = await execute({ ...(identity?.ctx ?? ctx), source: 'MCP' }, name, args);
            if (identity)
              app.log.info(
                {
                  oauth_client_id: identity.clientId,
                  operation_id: result.operation_id,
                  tool: name,
                },
                'MCP operation',
              );
            return {
              content: [{ type: 'text' as const, text: JSON.stringify(result) }],
              structuredContent: result,
            };
          } catch (e) {
            if (!(e instanceof DomainError)) throw e;
            const error = { code: e.code, message: e.message, details: e.details };
            return {
              isError: true,
              content: [{ type: 'text' as const, text: JSON.stringify({ error }) }],
              structuredContent: { error },
            };
          }
        },
      );
    return server;
  });
  const cloudMcp =
    auth && cloud
      ? requireMcpAuth(
          auth,
          async (request, claims) => {
            const context = typeof claims.sub === 'string' ? await ownerContext(claims.sub) : null;
            if (!context || typeof claims.client_id !== 'string')
              return Response.json({ error: 'forbidden' }, { status: 403 });
            const scopes = new Set(typeof claims.scope === 'string' ? claims.scope.split(' ') : []);
            // Challenge before invoking SDK tools, including before idempotency replays.
            const body =
              request.method === 'POST'
                ? await request
                    .clone()
                    .json()
                    .catch(() => null)
                : null;
            const name =
              body?.method === 'tools/call' ? (body.params?.name as Operation) : undefined;
            const scope =
              name && name in schemas && !reads.has(name) ? 'inventory:write' : 'inventory:read';
            if (!scopes.has(scope)) throw createInsufficientScopeError([scope]);
            return identities.run({ ctx: context, scopes, clientId: claims.client_id }, () =>
              mcp.fetch(request),
            );
          },
          { resource: cloud.resource, challengeScopes: [...inventoryScopes, 'offline_access'] },
        )
      : null;
  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      if (cloudMcp) return sendResponse(reply, await cloudMcp(requestFor(req)));
      const provided = Buffer.from(req.headers.authorization ?? ''),
        expected = Buffer.from(`Bearer ${token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
        return reply.code(401).send({
          error: { code: 'UNAUTHORIZED', message: 'A personal access token is required.' },
        });
      return sendResponse(reply, await mcp.fetch(requestFor(req)));
    },
  });
  app.addHook('onClose', () => mcp.close());
  if (serveStatic) {
    await app.register(staticFiles, { root: resolve('apps/web/dist'), prefix: '/' });
    app.get('/login', (_req, reply) => reply.sendFile('index.html'));
    app.get('/consent', (_req, reply) => reply.sendFile('index.html'));
  }
  return app;
}

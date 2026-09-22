import { debugRead } from './debug.js';
import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { localhostHostValidation } from '@modelcontextprotocol/fastify';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import {
  schemas,
  reads,
  descriptions,
  type Operation,
} from '../../../packages/contracts/src/index.js';
import { DomainError } from '../../../packages/domain/src/index.js';
import { execute, type Context } from './service.js';
import { pool, query } from './db.js';
export async function buildApp(ctx: Context, token: string, serveStatic = true) {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info', redact: ['req.headers.authorization'] },
    bodyLimit: 1024 * 1024,
  });
  app.addHook('onRequest', localhostHostValidation());
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin && req.headers.origin !== `http://${req.headers.host}`)
      return reply
        .code(403)
        .send({ error: { code: 'FORBIDDEN', message: 'Cross-origin access denied.' } });
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
  });
  app.setErrorHandler((error: any, _req, reply) => {
    if (error instanceof DomainError)
      return reply
        .code(error.code === 'NOT_FOUND' ? 404 : error.code === 'FORBIDDEN' ? 403 : 400)
        .send({ error: { code: error.code, message: error.message, details: error.details } });
    app.log.error({ err: error }, 'Request failed');
    return reply
      .code(error.statusCode ?? 500)
      .send({ error: { code: 'INTERNAL_ERROR', message: 'Request failed.' } });
  });
  app.get('/health', async () => {
    await query(pool, 'SELECT 1');
    return { status: 'ok' };
  });
  app.get('/api/context', async () => {
    const household = (
      await query(pool, 'SELECT * FROM households WHERE id=$1', [ctx.household_id])
    ).rows[0];
    const install = (
      await query(pool, 'SELECT container_catalog_id FROM installations WHERE household_id=$1', [
        ctx.household_id,
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
    return execute({ ...ctx, source: 'WEB' }, name, input);
  });
  app.get('/api/debug', async (req) => {
    let input: unknown;
    try {
      input = JSON.parse((req.query as any).input ?? '{}');
    } catch {
      throw new DomainError('ATTRIBUTE_VALIDATION_FAILED', 'Invalid JSON query.');
    }
    return debugRead({ ...ctx, source: 'WEB_DEBUG' }, input);
  });
  const mcp = createMcpHandler(() => {
    const server = new McpServer(
      { name: 'acornary', version: '0.1.0' },
      {
        instructions:
          'Acornary 管理具体物品。先查询 UUID、属性和 revision，再进行明确的写操作。多个候选必须向用户澄清，禁止自行挑选、FEFO 或猜测缺失事实。写操作携带幂等键与 expected_revisions；重试保留原键和参数。未记录状态不等于 ACTIVE。Web 只读。模板字段与单位通过 list_attribute_templates/get_attribute_template 发现。',
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
        },
        async (args: any) => {
          try {
            const result = await execute({ ...ctx, source: 'MCP' }, name, args);
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
  app.route({
    method: ['POST', 'GET', 'DELETE'],
    url: '/mcp',
    handler: async (req, reply) => {
      const provided = Buffer.from(req.headers.authorization ?? ''),
        expected = Buffer.from(`Bearer ${token}`);
      if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
        return reply.code(401).send({
          error: { code: 'UNAUTHORIZED', message: 'A personal access token is required.' },
        });
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers))
        if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(',') : value);
      const response = await mcp.fetch(
        new Request(`http://${req.headers.host}${req.url}`, {
          method: req.method,
          headers,
          ...(req.method === 'POST' ? { body: JSON.stringify(req.body) } : {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => reply.header(key, value));
      return response.body ? reply.send(Readable.fromWeb(response.body as any)) : reply.send();
    },
  });
  app.addHook('onClose', () => mcp.close());
  if (serveStatic) await app.register(staticFiles, { root: resolve('apps/web/dist'), prefix: '/' });
  return app;
}

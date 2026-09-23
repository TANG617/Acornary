import { createServer } from 'node:https';
import { request } from 'node:http';
import { readFileSync } from 'node:fs';
import { initialize } from '../apps/server/src/initialize.js';
import { manageOwner } from '../apps/server/src/owner.js';
import { buildApp } from '../apps/server/src/app.js';
if (!process.env.DATABASE_URL?.match(/\/acornary_e2e_\d+$/))
  throw new Error('Isolated E2E database required.');
const ctx = { ...(await initialize()), source: 'E2E' };
await manageOwner('create', 'browser@example.test', 'Browser-test-password-123!');
const app = await buildApp(ctx, '', true, {
  mode: 'cloud',
  origin: 'https://127.0.0.1:3210',
  resource: 'https://127.0.0.1:3210/mcp',
  trustedProxy: '127.0.0.1',
  secret: 'isolated-browser-only-secret-at-least-32-characters',
});
await app.listen({ host: '127.0.0.1', port: 3211 });
createServer(
  { key: readFileSync('/tls/key.pem'), cert: readFileSync('/tls/cert.pem') },
  (req, res) => {
    const upstream = request(
      {
        hostname: '127.0.0.1',
        port: 3211,
        path: req.url,
        method: req.method,
        headers: {
          ...req.headers,
          host: '127.0.0.1:3210',
          'x-forwarded-proto': 'https',
          'x-real-ip': '127.0.0.1',
        },
      },
      (response) => {
        res.writeHead(response.statusCode ?? 500, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', () => {
      res.statusCode = 502;
      res.end();
    });
    req.pipe(upstream);
  },
).listen(3210, '0.0.0.0');

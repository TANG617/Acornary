import { spawnSync } from 'node:child_process';
const name = 'acornary',
  url = 'https://acornary.protium.top/mcp';
const action = process.argv[2];
const run = (args, options = {}) =>
  spawnSync('codex', ['mcp', ...args], { stdio: 'inherit', ...options });
const existing = () => {
  const r = run(['get', name, '--json'], { encoding: 'utf8', stdio: 'pipe' });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
};
if (action === 'connect') {
  const config = existing();
  if (config && config.transport?.url !== url)
    throw new Error(
      'An acornary entry points elsewhere; inspect it before replacing it. Other MCP entries remain unchanged.',
    );
  // `mcp add` performs the initial OAuth login; do not immediately request a second grant.
  if (!config)
    process.exit(
      run(['add', name, '--url', url, '--oauth-client-registration', 'cimd', '--oauth-resource', url])
        .status ?? 1,
    );
  process.exit(
    run([
      'login',
      name,
      '--scopes',
      'inventory:read,inventory:write,offline_access',
      '--oauth-client-registration',
      'cimd',
    ]).status ?? 1,
  );
} else if (action === 'disconnect') {
  if (existing()) {
    run(['logout', name]);
    process.exit(run(['remove', name]).status ?? 1);
  }
} else if (action === 'doctor') {
  const r = await fetch('https://acornary.protium.top/.well-known/oauth-protected-resource/mcp');
  const metadata = await r.json();
  console.log(
    JSON.stringify(
      {
        configured: !!existing(),
        metadataStatus: r.status,
        resource: metadata.resource,
        authorization_servers: metadata.authorization_servers,
      },
      null,
      2,
    ),
  );
  if (!r.ok || metadata.resource !== url) process.exit(1);
} else throw new Error('Usage: node scripts/codex-cloud.mjs connect|disconnect|doctor');

import { spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
const {
  DEPLOY_HOST: host,
  DEPLOY_USER: user,
  VERSION: version,
  COMMIT: commit,
  DIGEST: digest,
} = process.env;
if (
  !/^[a-zA-Z0-9.-]+$/.test(host ?? '') ||
  !/^[a-z_][a-z0-9_-]*$/.test(user ?? '') ||
  !/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version ?? '') ||
  !/^[0-9a-f]{40}$/.test(commit ?? '') ||
  !/^sha256:[0-9a-f]{64}$/.test(digest ?? '')
)
  throw new Error('Invalid deployment request');
function ssh(command) {
  const result = spawnSync(
    'ssh',
    [
      '-F',
      '/dev/null',
      '-i',
      process.env.DEPLOY_KEY_FILE,
      '-o',
      'IdentityAgent=none',
      '-o',
      'KexAlgorithms=ecdh-sha2-nistp256',
      '-o',
      'Ciphers=aes128-gcm@openssh.com',
      '-o',
      'MACs=hmac-sha2-256-etm@openssh.com,hmac-sha2-256',
      '-o',
      'HostKeyAlgorithms=ssh-ed25519',
      '-o',
      'BatchMode=yes',
      '-o',
      'IdentitiesOnly=yes',
      '-o',
      'StrictHostKeyChecking=yes',
      '-o',
      `UserKnownHostsFile=${process.env.DEPLOY_HOST_KEYS_FILE}`,
      '-o',
      'ConnectTimeout=15',
      `${user}@${host}`,
      command,
    ],
    { encoding: 'utf8', timeout: 60000 },
  );
  let response;
  try {
    response = JSON.parse(result.stdout);
  } catch {
    throw new Error('SSH request failed');
  }
  if (result.status !== 0 && response.phase !== 'rejected') throw new Error('SSH request failed');
  return response;
}
const request = `start ${version} ${commit} ${digest}`;
let job;
for (let n = 0; n < 180; n++) {
  try {
    // Repeating start after a lost response returns the existing job, not another deploy.
    job = ssh(job ? `status ${job.id}` : request);
  } catch (error) {
    if (n === 179) throw error;
    await new Promise((resolve) => setTimeout(resolve, 5000));
    continue;
  }
  console.log(JSON.stringify(job));
  if (['succeeded', 'failed', 'needs_attention', 'rejected'].includes(job.phase)) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `\nProduction deployment: **${job.phase}**\n\n\`Job ${job.id}\`\n`,
    );
    if (job.phase !== 'succeeded') process.exit(1);
    process.exit(0);
  }
  await new Promise((resolve) => setTimeout(resolve, 5000));
}
throw new Error(
  'Deployment polling timed out; the server job is not cancelled. Query its status before retrying.',
);

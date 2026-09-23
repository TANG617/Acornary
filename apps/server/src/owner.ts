import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { transaction, pool } from './db.js';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type OwnerAction = 'create' | 'reset-password' | 'disable' | 'enable' | 'revoke-grants';
export async function manageOwner(action: OwnerAction, email: string, password?: string) {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Valid email required.');
  email = email.trim().toLowerCase();
  if (['create', 'reset-password'].includes(action) && (!password || password.length < 12))
    throw new Error('Password must have at least 12 characters.');
  const hashed = password ? await hashPassword(password) : undefined;
  await transaction(async (c) => {
    await c.query("SELECT pg_advisory_xact_lock(hashtextextended('acornary-owner',0))");
    if (action === 'create') {
      if ((await c.query('SELECT 1 FROM auth_owners')).rowCount)
        throw new Error('Owner already exists.');
      const install = (await c.query("SELECT * FROM installations WHERE slot='local'")).rows[0];
      if (!install) throw new Error('Existing installation required.');
      const id = randomUUID();
      await c.query('INSERT INTO "user"(id,name,email,"emailVerified") VALUES($1,$2,$3,true)', [
        id,
        'Owner',
        email,
      ]);
      await c.query(
        'INSERT INTO account(id,"accountId","providerId","userId",password,"updatedAt") VALUES($1,$2,$3,$2,$4,now())',
        [randomUUID(), id, 'credential', hashed],
      );
      await c.query('INSERT INTO auth_owners(user_id,household_id,actor_id) VALUES($1,$2,$3)', [
        id,
        install.household_id,
        install.actor_id,
      ]);
      return;
    }
    const user = (
      await c.query(
        'SELECT u.id FROM "user" u JOIN auth_owners o ON o.user_id=u.id WHERE u.email=$1',
        [email],
      )
    ).rows[0];
    if (!user) throw new Error('Owner not found.');
    if (action === 'enable' || action === 'disable')
      await c.query('UPDATE auth_owners SET enabled=$2 WHERE user_id=$1', [
        user.id,
        action === 'enable',
      ]);
    if (action === 'reset-password') {
      const updated = await c.query(
        'UPDATE account SET password=$2,"updatedAt"=now() WHERE "userId"=$1 AND "providerId"=\'credential\'',
        [user.id, hashed],
      );
      if (updated.rowCount !== 1) throw new Error('Owner credential account is missing.');
    }
    if (action !== 'enable') {
      await c.query('DELETE FROM "oauthAccessToken" WHERE "userId"=$1', [user.id]);
      await c.query('DELETE FROM "oauthRefreshToken" WHERE "userId"=$1', [user.id]);
      await c.query('DELETE FROM "oauthConsent" WHERE "userId"=$1', [user.id]);
      if (action !== 'revoke-grants')
        await c.query('DELETE FROM session WHERE "userId"=$1', [user.id]);
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const action = process.argv[2] as OwnerAction;
  if (!['create', 'reset-password', 'disable', 'enable', 'revoke-grants'].includes(action))
    throw new Error('Usage: owner create|reset-password|disable|enable|revoke-grants');
  if (!process.stdin.isTTY)
    throw new Error(
      'Owner commands require an interactive terminal; credentials must not be passed as arguments.',
    );
  let hidden = false;
  const output = new Writable({
    write(chunk, _encoding, callback) {
      if (!hidden) process.stdout.write(chunk);
      callback();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  try {
    const email = await rl.question('Owner email: ');
    let password: string | undefined;
    if (['create', 'reset-password'].includes(action)) {
      const pending = rl.question('Password (hidden): ');
      hidden = true;
      password = await pending;
      hidden = false;
      process.stdout.write('\n');
      const confirmation = rl.question('Repeat password (hidden): ');
      hidden = true;
      const repeated = await confirmation;
      hidden = false;
      process.stdout.write('\n');
      if (password !== repeated) throw new Error('Passwords do not match.');
    }
    await manageOwner(action, email, password);
    console.log('Owner operation completed.');
  } finally {
    rl.close();
    await pool.end();
  }
}

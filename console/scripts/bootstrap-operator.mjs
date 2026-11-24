// Creates the organisation (if none) and the operator account, or resets the operator's password.
//   FLEET_OPERATOR_PASSWORD='...' npm run bootstrap -- --username bill [--org "My Org"] [--reset]
// The password comes from the environment so it never appears in shell history or process args.
import { randomBytes, scrypt } from 'node:crypto';
import { promisify } from 'node:util';
import pg from 'pg';

const scryptAsync = promisify(scrypt);
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const username = opt('--username');
const orgName = opt('--org') ?? 'Home';
const reset = args.includes('--reset');
const password = process.env.FLEET_OPERATOR_PASSWORD;
const url = process.env.DATABASE_URL_UNPOOLED || process.env.DATABASE_URL;

if (!url) { console.error('DATABASE_URL is not set'); process.exit(1); }
if (!username) { console.error('--username is required'); process.exit(1); }
if (!password || password.length < 12) { console.error('FLEET_OPERATOR_PASSWORD must be set, 12+ characters'); process.exit(1); }

const salt = randomBytes(16);
const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
const hash = `scrypt$N=16384,r=8,p=1$${salt.toString('hex')}$${key.toString('hex')}`;

const client = new pg.Client({ connectionString: url });
await client.connect();
try {
  await client.query('BEGIN');
  const existing = await client.query('SELECT id, org_id FROM users WHERE lower(username) = lower($1)', [username]);
  if (existing.rows[0]) {
    if (!reset) { console.error(`User ${username} exists. Pass --reset to change the password.`); process.exit(1); }
    const u = existing.rows[0];
    await client.query('UPDATE users SET password_hash = $2 WHERE id = $1', [u.id, hash]);
    await client.query('DELETE FROM sessions WHERE user_id = $1', [u.id]);
    await client.query(
      `INSERT INTO audit_events (org_id, actor_user_id, actor_label, action, subject_type, subject_id, subject_label, outcome)
       VALUES ($1, NULL, 'bootstrap-script', 'auth.password_reset', 'user', $2, $3, 'success')`,
      [u.org_id, u.id, username],
    );
    console.log(`Password reset for ${username}; existing sessions ended.`);
  } else {
    let org = (await client.query('SELECT id FROM organisations ORDER BY created_at LIMIT 1')).rows[0];
    if (!org) org = (await client.query('INSERT INTO organisations (name) VALUES ($1) RETURNING id', [orgName])).rows[0];
    const u = (await client.query(
      'INSERT INTO users (org_id, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [org.id, username, hash],
    )).rows[0];
    await client.query(
      `INSERT INTO audit_events (org_id, actor_user_id, actor_label, action, subject_type, subject_id, subject_label, outcome)
       VALUES ($1, NULL, 'bootstrap-script', 'user.create', 'user', $2, $3, 'success')`,
      [org.id, u.id, username],
    );
    console.log(`Created operator ${username}.`);
  }
  await client.query('COMMIT');
} catch (err) {
  await client.query('ROLLBACK');
  throw err;
} finally {
  await client.end();
}

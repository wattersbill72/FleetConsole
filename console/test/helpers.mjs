import { db, closePool } from '../build-test/server/db.js';
import { hashPassword } from '../build-test/server/auth.js';

export { db, closePool };

/** Minimal Vercel-style req/res for calling handlers directly. */
export function mockReq({ method = 'GET', body, cookie, query = {}, headers = {} } = {}) {
  return {
    method, body, query,
    headers: { host: 'console.test', ...(cookie ? { cookie } : {}), ...headers },
  };
}

export function mockRes() {
  const res = {
    statusCode: 200, headers: {}, body: undefined,
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    end(b) { if (b !== undefined) this.body = b; return this; },
  };
  return res;
}

export async function call(handler, reqOpts) {
  const res = mockRes();
  await handler(mockReq(reqOpts), res);
  return res;
}

import { randomBytes } from 'node:crypto';
let n = 0;
export async function makeOperator(label = 'org') {
  n += 1;
  const tag = `${randomBytes(4).toString('hex')}-${n}`; // test files run in parallel against one database
  const org = (await db.query('INSERT INTO organisations (name) VALUES ($1) RETURNING id', [`${label}-${tag}`])).rows[0];
  const username = `${label}-op-${tag}`;
  const password = 'correct horse battery staple';
  const user = (await db.query(
    'INSERT INTO users (org_id, username, password_hash) VALUES ($1, $2, $3) RETURNING id',
    [org.id, username, await hashPassword(password)],
  )).rows[0];
  return { orgId: org.id, userId: user.id, username, password };
}

export function cookieFrom(res) {
  const sc = res.headers['set-cookie'];
  return sc ? sc.split(';')[0] : undefined;
}

export async function audit(action, orgId) {
  return (await db.query('SELECT * FROM audit_events WHERE action = $1 AND org_id = $2 ORDER BY id', [action, orgId])).rows;
}

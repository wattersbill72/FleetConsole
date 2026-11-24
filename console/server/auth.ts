import { randomBytes, scrypt, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db, tx, type Queryable } from './db.js';
import { recordAudit } from './audit.js';
import { json } from './http.js';

const scryptAsync = promisify(scrypt) as (
  pw: string, salt: Buffer, keylen: number, opts: { N: number; r: number; p: number },
) => Promise<Buffer>;

// ---------- Passwords (Node built-in scrypt; no auth library, per DEC-001) ----------
// Format: scrypt$N=16384,r=8,p=1$<salt-hex>$<key-hex>

export const MIN_PASSWORD_LENGTH = 12;
const N = 16384, R = 8, P = 1, KEYLEN = 64;

export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(plain, salt, KEYLEN, { N, r: R, p: P });
  return `scrypt$N=${N},r=${R},p=${P}$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const params = Object.fromEntries(parts[1].split(',').map((kv) => kv.split('=')));
  const n = parseInt(params.N ?? '0', 10), r = parseInt(params.r ?? '0', 10), p = parseInt(params.p ?? '0', 10);
  if (!n || !r || !p) return false;
  const expected = Buffer.from(parts[3], 'hex');
  const actual = await scryptAsync(plain, Buffer.from(parts[2], 'hex'), expected.length, { N: n, r, p });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// Verified when the username is unknown, so unknown-user and wrong-password take the same time.
let dummyHash: Promise<string> | undefined;
const getDummyHash = () => (dummyHash ??= hashPassword('not-a-real-password'));

// ---------- Sessions ----------

const COOKIE = 'fc_session';
const ABSOLUTE_DAYS = 30;
const TOUCH_AFTER_SECONDS = 60;

function idleMinutes(): number {
  const v = parseInt(process.env.SESSION_IDLE_MINUTES ?? '', 10);
  return Number.isFinite(v) && v > 0 ? v : 480;
}

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s) throw new Error('SESSION_SECRET is not set');
  return s;
}

const hashToken = (token: string) => createHmac('sha256', secret()).update(token).digest('hex');

async function createSession(q: Queryable, userId: string): Promise<string> {
  const token = randomBytes(32).toString('hex');
  await q.query(
    `INSERT INTO sessions (user_id, token_hash, expires_at)
     VALUES ($1, $2, now() + make_interval(days => $3))`,
    [userId, hashToken(token), ABSOLUTE_DAYS],
  );
  return token;
}

const isProd = () => process.env.NODE_ENV === 'production' || !!process.env.VERCEL;

function setCookie(res: VercelResponse, value: string, maxAge: number) {
  const attrs = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (isProd()) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

function readCookie(req: VercelRequest): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === COOKIE) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

// ---------- Sign-in / sign-out ----------

const MAX_FAILURES = 5;
const FAILURE_WINDOW_MINUTES = 15;

export type LoginResult =
  | { ok: true; token: string }
  | { ok: false; status: 401 | 429; error: string };

const GENERIC_FAILURE = 'Invalid username or password';

export async function signIn(username: string, password: string): Promise<LoginResult> {
  const uname = username.trim().toLowerCase();

  const recent = await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM login_attempts
      WHERE lower(username) = $1 AND succeeded = false
        AND attempted_at > now() - make_interval(mins => $2)`,
    [uname, FAILURE_WINDOW_MINUTES],
  );
  const locked = parseInt(recent.rows[0].n, 10) >= MAX_FAILURES;

  const found = await db.query<{ id: string; org_id: string; username: string; password_hash: string; disabled_at: string | null }>(
    'SELECT id, org_id, username, password_hash, disabled_at FROM users WHERE lower(username) = $1',
    [uname],
  );
  const user = found.rows[0];

  // Always do one scrypt verification so timing does not reveal whether the user exists or is locked.
  const hash = user?.password_hash ?? (await getDummyHash());
  const passwordOk = await verifyPassword(password, hash);

  if (locked) {
    await recordAudit(db, {
      orgId: user?.org_id ?? null, actorUserId: user?.id ?? null, actorLabel: user?.username ?? 'unknown',
      action: 'auth.sign_in', outcome: 'failure', detail: { reason: 'locked' },
    });
    return { ok: false, status: 429, error: 'Too many failed attempts. Try again later.' };
  }

  if (!user || user.disabled_at || !passwordOk) {
    await db.query('INSERT INTO login_attempts (username, succeeded) VALUES ($1, false)', [uname]);
    await recordAudit(db, {
      orgId: user?.org_id ?? null, actorUserId: user?.id ?? null, actorLabel: user?.username ?? 'unknown',
      action: 'auth.sign_in', outcome: 'failure', detail: { reason: 'invalid_credentials' },
    });
    return { ok: false, status: 401, error: GENERIC_FAILURE };
  }

  const token = await tx(async (q) => {
    await q.query('INSERT INTO login_attempts (username, succeeded) VALUES ($1, true)', [uname]);
    await q.query('DELETE FROM login_attempts WHERE lower(username) = $1 AND succeeded = false', [uname]);
    const t = await createSession(q, user.id);
    await recordAudit(q, {
      orgId: user.org_id, actorUserId: user.id, actorLabel: user.username,
      action: 'auth.sign_in', outcome: 'success',
    });
    return t;
  });
  return { ok: true, token };
}

export function startSession(res: VercelResponse, token: string) {
  setCookie(res, token, ABSOLUTE_DAYS * 24 * 60 * 60);
}

// ---------- withAuth ----------

export interface AuthContext {
  userId: string;
  username: string;
  orgId: string;
  sessionId: string;
}

async function resolve(req: VercelRequest): Promise<AuthContext | null> {
  const token = readCookie(req);
  if (!token) return null;
  const r = await db.query<{ session_id: string; user_id: string; username: string; org_id: string; stale: boolean }>(
    `SELECT s.id AS session_id, u.id AS user_id, u.username, u.org_id,
            (s.last_active_at < now() - make_interval(secs => $3)) AS stale
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1
        AND u.disabled_at IS NULL
        AND s.expires_at > now()
        AND s.last_active_at > now() - make_interval(mins => $2)`,
    [hashToken(token), idleMinutes(), TOUCH_AFTER_SECONDS],
  );
  const row = r.rows[0];
  if (!row) return null;
  if (row.stale) {
    await db.query('UPDATE sessions SET last_active_at = now() WHERE id = $1', [row.session_id]);
  }
  return { userId: row.user_id, username: row.username, orgId: row.org_id, sessionId: row.session_id };
}

function sameOrigin(req: VercelRequest): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export type AuthedHandler = (req: VercelRequest, res: VercelResponse, ctx: AuthContext) => Promise<unknown> | unknown;

/** Every operator-facing route goes through this. Handlers must scope every query by ctx.orgId. */
export function withAuth(handler: AuthedHandler) {
  return async (req: VercelRequest, res: VercelResponse) => {
    const ctx = await resolve(req);
    if (!ctx) return json(res, 401, { error: 'Not authenticated' });
    if (req.method && !['GET', 'HEAD'].includes(req.method) && !sameOrigin(req)) {
      return json(res, 403, { error: 'Cross-origin request refused' });
    }
    return handler(req, res, ctx);
  };
}

export async function signOut(res: VercelResponse, ctx: AuthContext) {
  await tx(async (q) => {
    await q.query('DELETE FROM sessions WHERE id = $1', [ctx.sessionId]);
    await recordAudit(q, {
      orgId: ctx.orgId, actorUserId: ctx.userId, actorLabel: ctx.username,
      action: 'auth.sign_out', outcome: 'success',
    });
  });
  setCookie(res, '', 0);
}

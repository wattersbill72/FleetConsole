import { timingSafeEqual } from 'node:crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { evaluateStaleness } from '../../server/evaluate.js';
import { expireDecommissions } from '../../server/decommission.js';
import { deliverDue } from '../../server/notify/deliver.js';
import { json, methodNotAllowed } from '../../server/http.js';

// Called every minute by Vercel Cron (see vercel.json), which sends `Authorization: Bearer $CRON_SECRET`.
// With no CRON_SECRET configured the route refuses to run rather than run open.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const secret = process.env.CRON_SECRET;
  if (!secret) return json(res, 503, { error: 'Cron is not configured' });

  const given = Buffer.from(String(req.headers.authorization ?? ''));
  const want = Buffer.from(`Bearer ${secret}`);
  if (given.length !== want.length || !timingSafeEqual(given, want)) return json(res, 401, { error: 'Unauthorized' });

  const evaluation = await evaluateStaleness();
  const decommissionsExpired = await expireDecommissions();
  // Delivery is a separate step so a mail problem can never stop detection from running.
  let delivery = { sent: 0, retrying: 0, failed: 0 };
  try { delivery = await deliverDue(); } catch { /* the rows stay pending and are retried next minute */ }
  return json(res, 200, { ...evaluation, decommissionsExpired, delivery });
}

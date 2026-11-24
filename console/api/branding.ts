import type { VercelRequest, VercelResponse } from '@vercel/node';
import { db } from '../server/db.js';
import { json, methodNotAllowed } from '../server/http.js';

// Public on purpose: the sign-in screen shows the product name. Returns the name and nothing else.
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const r = await db.query<{ product_name: string }>(
    'SELECT product_name FROM organisations ORDER BY created_at LIMIT 1',
  );
  return json(res, 200, { productName: r.rows[0]?.product_name ?? 'Fleet Console' });
}

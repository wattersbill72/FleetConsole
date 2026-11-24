import type { VercelRequest, VercelResponse } from '@vercel/node';

export function json(res: VercelResponse, status: number, body: unknown): VercelResponse {
  res.setHeader('Cache-Control', 'no-store');
  return res.status(status).json(body);
}

export function methodNotAllowed(res: VercelResponse, allow: string[]): VercelResponse {
  res.setHeader('Allow', allow.join(', '));
  return json(res, 405, { error: 'Method not allowed' });
}

export function bodyObject(req: VercelRequest): Record<string, unknown> {
  const b = req.body;
  return b && typeof b === 'object' && !Array.isArray(b) ? (b as Record<string, unknown>) : {};
}

export function clientIp(req: VercelRequest): string {
  const fwd = req.headers['x-forwarded-for'];
  const first = Array.isArray(fwd) ? fwd[0] : fwd;
  return (first ?? '').split(',')[0].trim() || 'unknown';
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

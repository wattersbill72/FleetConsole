import type { VercelRequest, VercelResponse } from '@vercel/node';
import { consoleOrigin } from '../server/enrol.js';
import { renderInstallScript } from '../server/installScript.js';
import { methodNotAllowed } from '../server/http.js';

// Served at /install.sh (see vercel.json). Public by design; the script contains no secret.
export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') return methodNotAllowed(res, ['GET']);
  const script = renderInstallScript(consoleOrigin(req));
  if (!script) {
    res.status(400).setHeader('Content-Type', 'text/plain');
    return res.end('This console address is not valid for the installer. Set CONSOLE_URL.\n');
  }
  res.setHeader('Content-Type', 'text/x-shellscript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  return res.status(200).end(script);
}

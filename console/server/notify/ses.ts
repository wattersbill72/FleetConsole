import { type Channel, type Message, SendError, registerChannel } from './channels.js';
import { signV4 } from './sigv4.js';

// Email through AWS SES v2 (DEC-007). Variable names avoid AWS_*, which Vercel reserves.

interface Settings { region: string; keyId: string; secret: string; from: string; endpoint: string }

function settings(): Settings | null {
  const region = process.env.SES_REGION, keyId = process.env.SES_ACCESS_KEY_ID;
  const secret = process.env.SES_SECRET_ACCESS_KEY, from = process.env.SES_FROM;
  if (!region || !keyId || !secret || !from) return null;
  return { region, keyId, secret, from, endpoint: (process.env.SES_ENDPOINT || `https://email.${region}.amazonaws.com`).replace(/\/+$/, '') };
}

export const emailChannel: Channel = {
  name: 'email',
  configured: () => settings() !== null,

  async send(m: Message) {
    const s = settings();
    if (!s) throw new SendError('Email sending is not configured (SES_REGION, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY, SES_FROM)', true);

    const body = JSON.stringify({
      FromEmailAddress: s.from,
      Destination: { ToAddresses: [m.to] },
      Content: { Simple: {
        Subject: { Data: m.subject, Charset: 'UTF-8' },
        Body: { Text: { Data: m.text, Charset: 'UTF-8' }, ...(m.html ? { Html: { Data: m.html, Charset: 'UTF-8' } } : {}) },
      } },
    });
    const headers = signV4({
      method: 'POST', url: `${s.endpoint}/v2/email/outbound-emails`, region: s.region, service: 'ses',
      headers: { 'content-type': 'application/json' }, body, accessKeyId: s.keyId, secretAccessKey: s.secret,
    });

    let res: Response;
    try {
      res = await fetch(`${s.endpoint}/v2/email/outbound-emails`, { method: 'POST', headers, body, signal: AbortSignal.timeout(8000) });
    } catch (e) {
      throw new SendError(`Could not reach SES: ${(e as Error).name === 'TimeoutError' ? 'timed out' : 'network error'}`, true);
    }
    const text = await res.text();
    if (res.ok) {
      try { return { id: (JSON.parse(text) as { MessageId?: string }).MessageId }; } catch { return {}; }
    }
    // Never include the request (it holds the recipient and our signature) in the error; keep the provider's words.
    let detail = '';
    try { detail = (JSON.parse(text) as { message?: string; Message?: string }).message ?? (JSON.parse(text) as { Message?: string }).Message ?? ''; } catch { /* not JSON */ }
    const kind = res.headers.get('x-amzn-errortype')?.split(':')[0] ?? '';
    const msg = `SES refused the message (HTTP ${res.status}${kind ? `, ${kind}` : ''})${detail ? `: ${detail.slice(0, 200)}` : ''}`;
    // Throttling and server errors are worth retrying; a rejected message or bad credentials are not.
    throw new SendError(msg, res.status >= 500 || res.status === 429 || /Throttl/i.test(kind));
  },
};

registerChannel(emailChannel);

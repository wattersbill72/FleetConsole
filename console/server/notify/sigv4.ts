import { createHash, createHmac } from 'node:crypto';

// AWS Signature Version 4 for one JSON POST, with Node's crypto and nothing else. Verified against
// AWS's published test vector (see test/notify.test.mjs). Handles simple paths and no query string
// escaping beyond RFC 3986, which is all the SES v2 send call needs.

export interface SignInput {
  method: string;
  url: string;
  region: string;
  service: string;
  headers: Record<string, string>;   // every header here is signed; host is added from the URL
  body: string;
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  now?: Date;
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const hmac = (key: string | Buffer, s: string) => createHmac('sha256', key).update(s).digest();
const rfc3986 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

export function signV4(i: SignInput): Record<string, string> {
  const u = new URL(i.url);
  const now = i.now ?? new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');   // 20150830T123600Z
  const date = amzDate.slice(0, 8);

  const headers: Record<string, string> = { ...i.headers, host: u.host, 'x-amz-date': amzDate };
  if (i.sessionToken) headers['x-amz-security-token'] = i.sessionToken;

  const names = Object.keys(headers).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v.trim().replace(/\s+/g, ' ')]));
  const canonicalHeaders = names.map((n) => `${n}:${lower[n]}\n`).join('');
  const signedHeaders = names.join(';');

  const path = u.pathname.split('/').map((seg) => rfc3986(decodeURIComponent(seg))).join('/') || '/';
  const query = [...u.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] === b[0] ? (a[1] < b[1] ? -1 : 1) : a[0] < b[0] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`).join('&');

  const canonical = [i.method.toUpperCase(), path, query, canonicalHeaders, signedHeaders, sha256(i.body)].join('\n');
  const scope = `${date}/${i.region}/${i.service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + i.secretAccessKey, date), i.region), i.service), 'aws4_request');
  const signature = createHmac('sha256', key).update(toSign).digest('hex');

  return {
    ...headers,
    Authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

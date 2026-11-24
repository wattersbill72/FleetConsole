// Builds the words of a notification. Pure: no I/O, so it is tested directly.

export interface AlertView {
  id: string;
  rule: string;
  subject_label: string;
  farm_name: string | null;
  farm_time_zone: string | null;
  opened_at: Date;
  silent_since: Date | null;
  closed_at: Date | null;
  duration_s: number | null;
  outage_s: number | null;
  detail: Record<string, any>;
}

export interface Rendered { subject: string; text: string; html: string }

// Operator-supplied names end up in headers and HTML. Strip control characters; escape for HTML.
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  if (h < 24) return rem ? `${h} h ${rem} min` : `${h} h`;
  const d = Math.floor(h / 24);
  return h % 24 ? `${d} d ${h % 24} h` : `${d} d`;
}

export function formatTime(d: Date, timeZone: string | null): string {
  let tz = 'UTC';
  try { if (timeZone) { new Intl.DateTimeFormat('en-US', { timeZone }); tz = timeZone; } } catch { /* unknown zone: use UTC */ }
  return new Intl.DateTimeFormat('en-US', { dateStyle: 'medium', timeStyle: 'long', timeZone: tz }).format(d);
}

function condition(a: AlertView): string {
  if (a.rule === 'removal_unconfirmed') {
    return `was asked to remove itself but did not confirm within ${a.detail?.minutes ?? 15} minutes. Its credential has been revoked. ` +
      'Run "sudo fleetagent uninstall" on the machine, then mark the node removed in the console';
  }
  if (a.rule === 'node_stale') {
    const t = a.detail?.threshold_s ? ` (no heartbeat for ${formatDuration(a.detail.threshold_s)})` : '';
    return `has stopped reporting${t}`;
  }
  if (a.rule === 'farm_stale') {
    const names = Array.isArray(a.detail?.nodes) ? a.detail.nodes.map((n: { name: string }) => clean(String(n.name))) : [];
    return `no machine is reporting${names.length ? ` (${names.join(', ')})` : ''}`;
  }
  return a.rule;
}

export function renderAlert(opts: {
  productName: string; kind: 'alert_open' | 'alert_close'; alert: AlertView; link: string | null;
}): Rendered {
  const { alert: a, kind } = opts;
  const product = clean(opts.productName);
  const subject = clean(a.subject_label);
  const where = a.farm_name && a.rule === 'node_stale' ? ` in farm ${clean(a.farm_name)}` : '';
  const tz = a.farm_time_zone;
  const lines: string[] = [];
  let title: string;

  if (kind === 'alert_open') {
    title = `[${product}] ALERT: ${subject} ${a.rule === 'farm_stale' ? 'has no machine reporting' : a.rule === 'removal_unconfirmed' ? 'removal was not confirmed' : 'is not reporting'}`;
    lines.push(`${subject}${where}: ${condition(a)}.`, '');
    lines.push(`Opened:        ${formatTime(a.opened_at, tz)}`);
    if (a.silent_since) lines.push(`Last heard:    ${formatTime(a.silent_since, tz)}`);
  } else {
    if (a.rule === 'removal_unconfirmed') {
      return {
        subject: `[${product}] RESOLVED: ${subject} is now marked removed`,
        text: [`${subject}${where} has been marked removed.`, ...(opts.link ? ['', `View: ${opts.link}`] : [])].join('\n'),
        html: `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(`${subject}${where} has been marked removed.`)}</pre>`,
      };
    }
    const down = a.outage_s ?? a.duration_s;
    title = `[${product}] RESOLVED: ${subject} is reporting again${down != null ? ` (silent ${formatDuration(down)})` : ''}`;
    lines.push(`${subject}${where} is reporting again.`, '');
    lines.push(`Opened:        ${formatTime(a.opened_at, tz)}`);
    if (a.closed_at) lines.push(`Resolved:      ${formatTime(a.closed_at, tz)}`);
    if (a.outage_s != null) lines.push(`Silent for:    ${formatDuration(a.outage_s)}`);
    if (a.duration_s != null) lines.push(`Alert open:    ${formatDuration(a.duration_s)}`);
  }
  if (opts.link) lines.push('', `View: ${opts.link}`);
  lines.push('', `${product} sends one message when an alert opens and one when it closes.`);

  const text = lines.join('\n');
  const html = `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(text).replace(
    opts.link ? esc(opts.link) : '\u0000', opts.link ? `<a href="${esc(opts.link)}">${esc(opts.link)}</a>` : '',
  )}</pre>`;
  return { subject: title, text, html };
}

export function renderTest(productName: string): Rendered {
  const product = clean(productName);
  const text = `This is a test notification from ${product}.\n\nIf you can read this, alert emails will reach you.`;
  return { subject: `[${product}] Test notification`, text, html: `<pre style="font:14px/1.5 ui-monospace,Menlo,monospace;white-space:pre-wrap">${esc(text)}</pre>` };
}

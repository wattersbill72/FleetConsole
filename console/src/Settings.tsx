import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type NotificationsView } from './api';
import { when } from './format';

export function Settings({ onChanged }: { onChanged: () => void }) {
  const [v, setV] = useState<NotificationsView | null>(null);
  const [address, setAddress] = useState('');
  const [error, setError] = useState('');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ recipient: string; ok: boolean; error?: string }[] | null>(null);

  const load = () => api.notifications().then(setV).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  async function add(e: FormEvent) {
    e.preventDefault();
    setError('');
    try { await api.addTarget(address); setAddress(''); await load(); } catch (err) { setError(err instanceof ApiError ? err.message : 'Could not reach the server'); }
  }
  async function test() {
    setTesting(true); setError(''); setTestResult(null);
    try { setTestResult((await api.testNotification()).results); await load(); onChanged(); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Could not reach the server'); }
    setTesting(false);
  }

  if (!v) return <p className="muted">{error || 'Loading…'}</p>;
  const emailOk = v.channels.email?.configured;

  return (
    <section>
      <h2>Notifications</h2>
      <p className={emailOk ? 'muted' : 'error'}>
        {emailOk ? 'Email sending is set up.' : 'Email sending is not set up. Set SES_REGION, SES_ACCESS_KEY_ID, SES_SECRET_ACCESS_KEY and SES_FROM on the server. Alerts wait and are sent once it is.'}
      </p>
      <p className="muted">One email is sent when an alert opens and one when it closes. Nothing is repeated while it stays open.</p>

      <h3>Send alerts to</h3>
      {v.targets.length === 0 && <p className="muted">No address yet. Alerts are recorded but nobody is told.</p>}
      <ul className="list">
        {v.targets.map((t) => (
          <li key={t.id} className="row">
            <span>{t.address}</span>
            <button className="link" onClick={async () => { await api.deleteTarget(t.id).catch(() => undefined); await load(); }}>Remove</button>
          </li>
        ))}
      </ul>
      <form className="card" onSubmit={add} style={{ maxWidth: 420 }}>
        <label>Email address
          <input type="email" value={address} onChange={(e) => setAddress(e.target.value)} required placeholder="you@example.com" />
        </label>
        <div className="row"><button type="submit">Add address</button></div>
      </form>
      {error && <p role="alert" className="error">{error}</p>}

      <div className="row" style={{ marginTop: 16 }}>
        <button onClick={test} disabled={testing || v.targets.length === 0}>{testing ? 'Sending…' : 'Send test notification'}</button>
        {v.failed_24h > 0 && (
          <button onClick={async () => { await api.retryNotifications().catch(() => undefined); await load(); onChanged(); }}>
            Retry {v.failed_24h} failed
          </button>
        )}
      </div>
      {testResult && (
        <ul className="list">
          {testResult.map((r) => (
            <li key={r.recipient}>{r.ok ? '✓ Sent to' : '✗ Failed for'} {r.recipient}{r.error ? `: ${r.error}` : ''}</li>
          ))}
        </ul>
      )}

      <h3>Recent notifications</h3>
      {v.recent.length === 0 && <p className="muted">None yet.</p>}
      <ul className="list">
        {v.recent.map((n) => (
          <li key={n.id}>
            <div className="row">
              <strong>{{ sent: '✓ Sent', failed: '✗ Failed', pending: '… Waiting', skipped: '– Not sent' }[n.status]}</strong>
              <span className="muted">{when(n.created_at)}</span>
            </div>
            <div className="muted">
              {n.kind === 'test' ? 'Test' : `${n.kind === 'alert_open' ? 'Opened' : 'Closed'}: ${n.subject_label ?? ''}`}
              {n.recipient ? ` → ${n.recipient}` : ''}
            </div>
            {n.last_error && <div className={n.status === 'sent' ? 'muted' : 'error'}>{n.last_error}</div>}
          </li>
        ))}
      </ul>
    </section>
  );
}

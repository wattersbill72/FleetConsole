import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Enrolment } from './api';

type Issued = { token: string; command: string; expires_at: string };

export function AddNode({ farmId, onClose }: { farmId: string; onClose: () => void }) {
  const [platform, setPlatform] = useState<'ubuntu' | 'macos'>('ubuntu');
  const [name, setName] = useState('');
  const [intermittent, setIntermittent] = useState(false);
  const [interval, setInterval_] = useState(60);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [outstanding, setOutstanding] = useState<Enrolment[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  const loadOutstanding = () => api.enrolments(farmId).then((r) => setOutstanding(r.enrolments)).catch(() => undefined);
  useEffect(() => { void loadOutstanding(); }, [farmId]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api.createEnrolment(farmId, {
        platform, display_name: name || undefined, intermittent, initial_config: { heartbeat_interval_s: interval },
      });
      setIssued({ token: r.token, command: r.command, expires_at: r.enrolment.expires_at });
      void loadOutstanding();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    }
    setBusy(false);
  }

  async function cancel(id: string) {
    await api.cancelEnrolment(farmId, id).catch(() => undefined);
    void loadOutstanding();
  }

  if (issued) {
    return (
      <div className="card" style={{ maxWidth: 'none' }}>
        <h3>Run this on the {platform === 'ubuntu' ? 'Ubuntu' : 'macOS'} machine</h3>
        <pre className="cmd">{issued.command}</pre>
        <div className="row">
          <button onClick={async () => { await navigator.clipboard.writeText(issued.command).catch(() => undefined); setCopied(true); }}>
            {copied ? 'Copied' : 'Copy command'}
          </button>
          <span className="muted">Single use. Expires {new Date(issued.expires_at).toLocaleTimeString()}.</span>
        </div>
        <p className="error">This is the only time the token is shown. If you lose it, generate a new one.</p>
        <button className="link" onClick={() => { setIssued(null); setCopied(false); onClose(); }}>Done</button>
      </div>
    );
  }

  return (
    <>
      <form className="card" style={{ maxWidth: 'none' }} onSubmit={submit}>
        <h3>Add node</h3>
        <label>Platform
          <select value={platform} onChange={(e) => setPlatform(e.target.value as 'ubuntu' | 'macos')}>
            <option value="ubuntu">Ubuntu 24.04</option>
            <option value="macos">macOS (Apple silicon)</option>
          </select>
        </label>
        <label>Display name (optional; defaults to the hostname)
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="UBUNTU-Dell01" />
        </label>
        <label>Heartbeat interval (seconds, 30 to 300)
          <input type="number" min={30} max={300} value={interval} onChange={(e) => setInterval_(Number(e.target.value))} />
        </label>
        <label className="check">
          <input type="checkbox" checked={intermittent} onChange={(e) => setIntermittent(e.target.checked)} />
          Intermittent: expected to be offline at times, no stale alert
        </label>
        {error && <p role="alert" className="error">{error}</p>}
        <div className="row">
          <button type="submit" disabled={busy}>Generate command</button>
          <button type="button" className="link" onClick={onClose}>Cancel</button>
        </div>
      </form>
      {outstanding.length > 0 && (
        <>
          <h3>Outstanding enrolments</h3>
          <ul className="list">
            {outstanding.map((o) => (
              <li key={o.id} className="row">
                <span>{o.display_name ?? 'unnamed'} <span className="muted">{o.platform} · expires {new Date(o.expires_at).toLocaleTimeString()}</span></span>
                <button className="link" onClick={() => cancel(o.id)}>Cancel</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

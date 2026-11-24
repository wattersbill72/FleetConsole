import { useEffect, useState } from 'react';
import { api, type AlertRow } from './api';
import { formatDuration, when } from './format';

const RULES: Record<string, string> = { node_stale: 'Machine stopped reporting', farm_stale: 'No machine reporting in farm' };

export function Alerts({ highlightId }: { highlightId: string | null }) {
  const [q, setQ] = useState('');
  const [state, setState] = useState('all');
  const [range, setRange] = useState('30d');
  const [rows, setRows] = useState<AlertRow[]>([]);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const params = (offset: number): Record<string, string> => {
    const p: Record<string, string> = { state, range, offset: String(offset), limit: '50' };
    if (q.trim()) p.q = q.trim();
    if (highlightId) { p.id = highlightId; delete p.range; p.state = 'all'; }
    return p;
  };
  const load = (offset = 0) => {
    setLoading(true);
    api.alerts(params(offset))
      .then((r) => { setRows(offset ? [...rows, ...r.alerts] : r.alerts); setTotal(r.total); setError(''); })
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => { const t = setTimeout(() => load(0), 250); return () => clearTimeout(t); }, [q, state, range, highlightId]); // eslint-disable-line

  return (
    <section>
      <div className="row"><h2>Alerts</h2>{highlightId && <a href="#alerts">Show all alerts</a>}</div>
      {!highlightId && (
        <div className="filters">
          <input placeholder="Search by name" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search by name" />
          <select value={state} onChange={(e) => setState(e.target.value)} aria-label="State">
            <option value="all">Open and closed</option><option value="open">Open only</option><option value="closed">Closed only</option>
          </select>
          <select value={range} onChange={(e) => setRange(e.target.value)} aria-label="Opened within">
            <option value="24h">Last 24 hours</option><option value="7d">Last 7 days</option><option value="30d">Last 30 days</option><option value="all">All time</option>
          </select>
        </div>
      )}
      {error && <p role="alert" className="error">{error}</p>}
      {!loading && rows.length === 0 && !error && <p className="muted">No alerts match.</p>}
      <ul className="list">
        {rows.map((a) => (
          <li key={a.id} className={a.id === highlightId ? 'hl' : ''}>
            <div className="row">
              <strong>{a.closed_at ? '✓ Closed' : '⚠ Open'}: {a.subject_label}</strong>
              <span className="muted">{a.closed_at ? `lasted ${formatDuration(a.duration_s ?? 0)}` : 'still open'}</span>
            </div>
            <div className="muted">
              {RULES[a.rule] ?? a.rule}{a.farm_name && a.rule === 'node_stale' ? ` · ${a.farm_name}` : ''} · opened {when(a.opened_at)}
              {a.silent_since ? ` · last heard ${when(a.silent_since)}` : ''}
              {a.closed_at ? ` · closed ${when(a.closed_at)}${a.outage_s != null ? ` · silent for ${formatDuration(a.outage_s)}` : ''}` : ''}
            </div>
          </li>
        ))}
      </ul>
      {rows.length < total && <button onClick={() => load(rows.length)}>Show more ({total - rows.length} left)</button>}
    </section>
  );
}

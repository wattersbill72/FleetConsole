import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type NodeStatus, type Overview as Data, type OverviewNode } from './api';
import { ago, pct, when } from './format';

const REFRESH_MS = 30_000;

// Status is always shown as an icon and a word, and non-healthy rows carry a heavier edge, so nothing
// depends on colour alone.
const STATUS: Record<NodeStatus, { icon: string; label: string }> = {
  stale: { icon: '✕', label: 'Stale' },
  degraded: { icon: '▲', label: 'Degraded' },
  decommissioning: { icon: '⏻', label: 'Removing' },
  pending: { icon: '…', label: 'Pending' },
  'expected-offline': { icon: '◌', label: 'Offline (expected)' },
  healthy: { icon: '✓', label: 'Healthy' },
};

export function Overview({ onUnauthorized }: { onUnauthorized: () => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [fetchedAt, setFetchedAt] = useState(0);          // client clock when the data arrived
  const [failure, setFailure] = useState('');
  const [now, setNow] = useState(Date.now());
  const busy = useRef(false);

  const refresh = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    try {
      setData(await api.overview());
      setFetchedAt(Date.now());
      setFailure('');
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) onUnauthorized();
      else setFailure(e instanceof ApiError ? e.message : 'Could not reach the console');
    } finally {
      busy.current = false;
    }
  }, [onUnauthorized]);

  // Poll while the tab is visible; refresh as soon as it becomes visible again.
  useEffect(() => {
    void refresh();
    const poll = setInterval(() => { if (document.visibilityState === 'visible') void refresh(); }, REFRESH_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    const onVis = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(poll); clearInterval(tick); document.removeEventListener('visibilitychange', onVis); };
  }, [refresh]);

  if (!data) return <p className="muted">{failure || 'Loading…'}</p>;

  const sinceFetch = Math.max(0, Math.round((now - fetchedAt) / 1000));
  const s = data.summary;

  return (
    <section>
      <div className={s.all_clear ? 'headline ok' : 'headline bad'} role="status">
        <strong>
          {s.all_clear
            ? `✓ All clear: ${s.healthy} of ${s.nodes_total} machine${s.nodes_total === 1 ? '' : 's'} healthy`
            : s.needs_attention > 0
              ? `⚠ ${s.needs_attention} machine${s.needs_attention === 1 ? '' : 's'} need${s.needs_attention === 1 ? 's' : ''} attention`
              : `⚠ ${s.open_alerts} open alert${s.open_alerts === 1 ? '' : 's'}`}
        </strong>
        <span>
          <a href="#alerts">Open alerts: {s.open_alerts}</a>
          {s.pending > 0 && ` · ${s.pending} pending`}
          {s.expected_offline > 0 && ` · ${s.expected_offline} offline as expected`}
        </span>
      </div>

      {data.alerts.length > 0 && (
        <ul className="list alerts-top">
          {data.alerts.map((a) => (
            <li key={a.id}>
              <a href={`#alerts/${a.id}`}><strong>⚠ {a.subject_label}</strong></a>
              <span className="muted"> {a.rule === 'farm_stale' ? 'no machine reporting' : 'stopped reporting'} · since {when(a.opened_at)}</span>
            </li>
          ))}
          {s.open_alerts > data.alerts.length && <li><a href="#alerts">and {s.open_alerts - data.alerts.length} more</a></li>}
        </ul>
      )}

      <p className={failure ? 'error' : 'muted'} aria-live="polite">
        {failure
          ? `Could not refresh (${failure}). Showing what the console last sent, ${ago(sinceFetch)}.`
          : `Updated ${ago(sinceFetch)} · refreshes every ${REFRESH_MS / 1000} s`}{' '}
        <button className="link" onClick={() => void refresh()}>Refresh now</button>
      </p>

      {data.farms.length === 0 && <p>No farms yet. <a href="#farms">Create one</a> to start adding machines.</p>}
      {data.farms.map((f) => (
        <div key={f.id} className="farm">
          <div className="row">
            <h3><a href={`#farms/${f.id}`}>{f.name}</a></h3>
            <span className="muted">{f.nodes.length === 0 ? 'no machines' : `${f.healthy} of ${f.nodes.length} healthy`}</span>
          </div>
          {f.nodes.length === 0 ? (
            <p className="muted">No machines yet. <a href={`#farms/${f.id}`}>Add the first node</a></p>
          ) : (
            <div className="nodes" role="table" aria-label={`Machines in ${f.name}`}>
              <div className="nrow nhead" role="row">
                <span role="columnheader">Machine</span><span role="columnheader">Status</span><span role="columnheader">Last heard</span>
                <span role="columnheader">CPU</span><span role="columnheader">Memory</span><span role="columnheader">Disk</span><span role="columnheader">Agent</span>
              </div>
              {f.nodes.map((n) => <NodeRow key={n.id} n={n} farmId={f.id} sinceFetch={sinceFetch} />)}
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

function NodeRow({ n, farmId, sinceFetch }: { n: OverviewNode; farmId: string; sinceFetch: number }) {
  const st = n.status === 'decommissioning' && n.decommission_unconfirmed ? { icon: '✕', label: 'Removal not confirmed' } : STATUS[n.status];
  const lastKnown = n.status === 'stale' || n.status === 'expected-offline';
  const age = n.age_s === null ? null : n.age_s + sinceFetch;
  const cell = (label: string, v: number | null) => (
    <span role="cell" data-label={label} className={lastKnown && v !== null ? 'lastknown' : ''} title={lastKnown && v !== null ? 'Last known value' : undefined}>
      {pct(v)}
    </span>
  );
  return (
    <div className={`nrow s-${n.status}`} role="row">
      <span role="cell" className="nname"><a href={`#farms/${farmId}`}>{n.display_name}</a></span>
      <span role="cell" data-label="Status"><span className={`badge b-${n.status}`}><span aria-hidden="true">{st.icon}</span> {st.label}</span></span>
      <span role="cell" data-label="Last heard" title={n.last_heartbeat_at ? when(n.last_heartbeat_at) : 'Has not reported yet'}>{ago(age)}</span>
      {cell('CPU', n.cpu_pct)}
      {cell('Memory', n.mem_pct)}
      {cell('Disk', n.disk_worst_pct)}
      <span role="cell" data-label="Agent">{n.agent_version ?? '—'}</span>
    </div>
  );
}

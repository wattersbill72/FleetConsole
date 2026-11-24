import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Login } from './Login';
import { Farms } from './Farms';
import { Overview } from './Overview';
import { Alerts } from './Alerts';
import { Settings } from './Settings';

export function App() {
  // 'loading' until we know whether a session exists; nothing but the sign-in form is ever rendered without one.
  const [me, setMe] = useState<Me | null | 'loading'>('loading');
  const [productName, setProductName] = useState('Fleet Console');
  const [hash, setHash] = useState(window.location.hash);
  const [failed, setFailed] = useState(0);

  useEffect(() => {
    const on = () => setHash(window.location.hash);
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  const checkFailures = useCallback(() => { api.notifications().then((n) => setFailed(n.failed_24h)).catch(() => undefined); }, []);

  const refresh = useCallback(async () => {
    try {
      const m = await api.me();
      setMe(m);
      setProductName(m.org.productName);
    } catch {
      setMe(null);
      api.branding().then((b) => setProductName(b.productName)).catch(() => undefined);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);
  useEffect(() => { if (me && me !== 'loading') checkFailures(); }, [me, hash, checkFailures]);
  useEffect(() => { document.title = productName; }, [productName]);

  const view = hash.startsWith('#alerts') ? 'alerts' : hash.startsWith('#settings') ? 'settings' : hash.startsWith('#farms') ? 'farms' : 'overview';
  const farmId = hash.startsWith('#farms/') ? hash.slice('#farms/'.length) : null;
  const alertId = hash.startsWith('#alerts/') ? hash.slice('#alerts/'.length) : null;

  if (me === 'loading') return <p className="muted pad">Loading…</p>;
  if (!me) return <Login productName={productName} onSignedIn={refresh} />;

  return (
    <div className="shell">
      <header className="bar">
        <strong>{productName}</strong>
        <span className="muted">
          {me.user.username} · {me.org.name}{' '}
          <button className="link" onClick={async () => { await api.logout().catch(() => undefined); setMe(null); }}>
            Sign out
          </button>
        </span>
      </header>
      <nav className="tabs">
        <a href="#" className={view === 'overview' ? 'on' : ''}>Overview</a>
        <a href="#farms" className={view === 'farms' ? 'on' : ''}>Farms</a>
        <a href="#alerts" className={view === 'alerts' ? 'on' : ''}>Alerts</a>
        <a href="#settings" className={view === 'settings' ? 'on' : ''}>Settings</a>
      </nav>
      {failed > 0 && view !== 'settings' && (
        <p className="banner" role="alert">{failed} notification{failed === 1 ? '' : 's'} failed to send. <a href="#settings">See why</a></p>
      )}
      <main className={view === 'overview' ? 'pad wide' : 'pad'}>
        {view === 'alerts' && <Alerts highlightId={alertId} />}
        {view === 'settings' && <Settings onChanged={checkFailures} />}
        {view === 'farms' && <Farms farmId={farmId} />}
        {view === 'overview' && <Overview onUnauthorized={() => setMe(null)} />}
      </main>
    </div>
  );
}

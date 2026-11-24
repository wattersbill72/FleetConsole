import { useCallback, useEffect, useState } from 'react';
import { api, type Me } from './api';
import { Login } from './Login';
import { Farms } from './Farms';

export function App() {
  // 'loading' until we know whether a session exists; nothing but the sign-in form is ever rendered without one.
  const [me, setMe] = useState<Me | null | 'loading'>('loading');
  const [productName, setProductName] = useState('Fleet Console');

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
  useEffect(() => { document.title = productName; }, [productName]);

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
      <main className="pad">
        <Farms />
      </main>
    </div>
  );
}

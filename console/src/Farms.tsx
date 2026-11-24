import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type Farm, type NodeRow } from './api';
import { AddNode } from './AddNode';

const ZONES: string[] = (Intl as unknown as { supportedValuesOf(k: string): string[] }).supportedValuesOf('timeZone');
const localZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

// The selected farm lives in the address bar (#farms/<id>) so the overview and emails can link to it.
const selectFarm = (id: string | null) => { window.location.hash = id ? `#farms/${id}` : '#farms'; };

export function Farms({ farmId }: { farmId: string | null }) {
  const [farms, setFarms] = useState<Farm[] | null>(null);
  const selected = farmId;
  const setSelected = selectFarm;
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  const load = () => api.farms().then((r) => setFarms(r.farms)).catch((e) => setError(e.message));
  useEffect(() => { void load(); }, []);

  if (error) return <p role="alert" className="error">{error}</p>;
  if (!farms) return <p className="muted">Loading…</p>;

  const farm = farms.find((f) => f.id === selected);
  if (farm) {
    return (
      <FarmView
        farm={farm}
        onBack={() => setSelected(null)}
        onSaved={(f) => setFarms(farms.map((x) => (x.id === f.id ? f : x)))}
      />
    );
  }

  return (
    <section>
      <div className="row">
        <h2>Farms</h2>
        {farms.length > 0 && !creating && <button onClick={() => setCreating(true)}>New farm</button>}
      </div>
      {(creating || farms.length === 0) && (
        <FarmForm
          submitLabel="Create farm"
          onCancel={farms.length > 0 ? () => setCreating(false) : undefined}
          onSubmit={async (v) => {
            const { farm: f } = await api.createFarm(v);
            setFarms([...farms, f].sort((a, b) => a.name.localeCompare(b.name)));
            setCreating(false);
            setSelected(f.id);
          }}
          intro={farms.length === 0 ? 'A farm groups the machines at one site. Create your first one to get started.' : undefined}
        />
      )}
      {farms.length > 0 && (
        <ul className="list">
          {farms.map((f) => (
            <li key={f.id}>
              <button className="link" onClick={() => setSelected(f.id)}>{f.name}</button>
              <span className="muted"> {f.time_zone}{f.description ? ` · ${f.description}` : ''}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function FarmView({ farm, onBack, onSaved }: { farm: Farm; onBack: () => void; onSaved: (f: Farm) => void }) {
  const [editing, setEditing] = useState(false);
  return (
    <section>
      <button className="link" onClick={onBack}>← Farms</button>
      {editing ? (
        <FarmForm
          initial={farm}
          submitLabel="Save"
          onCancel={() => setEditing(false)}
          onSubmit={async (v) => {
            const { farm: f } = await api.updateFarm(farm.id, v);
            onSaved(f);
            setEditing(false);
          }}
        />
      ) : (
        <>
          <div className="row">
            <h2>{farm.name}</h2>
            <button onClick={() => setEditing(true)}>Edit</button>
          </div>
          <p className="muted">{farm.time_zone}{farm.description ? ` · ${farm.description}` : ''}</p>
        </>
      )}
      <Nodes farmId={farm.id} />
    </section>
  );
}

function FarmForm(props: {
  initial?: Farm;
  submitLabel: string;
  intro?: string;
  onCancel?: () => void;
  onSubmit: (v: { name: string; description: string; time_zone: string }) => Promise<void>;
}) {
  const [name, setName] = useState(props.initial?.name ?? '');
  const [description, setDescription] = useState(props.initial?.description ?? '');
  const [zone, setZone] = useState(props.initial?.time_zone ?? localZone);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await props.onSubmit({ name, description, time_zone: zone });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
      setBusy(false);
    }
  }

  return (
    <form className="card" onSubmit={submit}>
      {props.intro && <p>{props.intro}</p>}
      <label>Name
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required placeholder="home-kennewick" />
      </label>
      <label>Site description
        <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} rows={2} />
      </label>
      <label>Time zone
        <select value={zone} onChange={(e) => setZone(e.target.value)}>
          {(ZONES.includes(zone) ? ZONES : [zone, ...ZONES]).map((z) => <option key={z}>{z}</option>)}
        </select>
      </label>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="row">
        <button type="submit" disabled={busy}>{props.submitLabel}</button>
        {props.onCancel && <button type="button" className="link" onClick={props.onCancel}>Cancel</button>}
      </div>
    </form>
  );
}

function Nodes({ farmId }: { farmId: string }) {
  const [nodes, setNodes] = useState<NodeRow[] | null>(null);
  const [adding, setAdding] = useState(false);
  const load = () => api.nodes(farmId).then((r) => setNodes(r.nodes)).catch(() => setNodes([]));
  useEffect(() => { void load(); }, [farmId]);
  if (!nodes) return <p className="muted">Loading…</p>;

  return (
    <>
      {nodes.length === 0 && !adding ? (
        <div className="empty">
          <h3>No nodes yet</h3>
          <p>Enrol the first machine in this farm.</p>
          <button onClick={() => setAdding(true)}>Add node</button>
        </div>
      ) : (
        <>
          <div className="row" style={{ marginTop: 16 }}>
            <h3>Nodes</h3>
            {!adding && <button onClick={() => setAdding(true)}>Add node</button>}
          </div>
          <ul className="list">
            {nodes.map((n) => (
              <li key={n.id}>
                <strong>{n.display_name}</strong> <span className="muted">{n.platform} · {n.status}{n.hostname ? ` · ${n.hostname}` : ''}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      {adding && <AddNode farmId={farmId} onClose={() => { setAdding(false); void load(); }} />}
    </>
  );
}


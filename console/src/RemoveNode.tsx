import { useState, type FormEvent } from 'react';
import { api, ApiError, type NodeRow } from './api';

// Removing a node is destructive, so it asks for the node's name, and it says plainly what happens next.
export function RemoveNode({ node, onChanged }: { node: NodeRow; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'remove' | 'mark'>('remove');
  const [typed, setTyped] = useState('');
  const [history, setHistory] = useState<'keep' | 'purge'>('keep');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const removing = node.status === 'decommissioning';
  const unconfirmed = removing && node.decommission_unconfirmed;

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      if (mode === 'remove') await api.removeNode(node.id, typed, history);
      else await api.markRemoved(node.id, typed, history);
      setOpen(false); setTyped('');
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not reach the server');
    }
    setBusy(false);
  }

  return (
    <div className="remove">
      {removing && !unconfirmed && (
        <p className="muted">
          ⏻ Removing: waiting for the agent to uninstall itself and confirm. It acts on its next heartbeat.
          {node.removal_error && <span className="error"> The agent reported: {node.removal_error}</span>}
        </p>
      )}
      {unconfirmed && (
        <p className="error" role="alert">
          ✕ The agent did not confirm removal in time and its credential has been revoked. Run <code>sudo fleetagent uninstall</code> on the
          machine, then mark the node removed here.
        </p>
      )}

      {!open && (
        <div className="row" style={{ justifyContent: 'flex-start' }}>
          {!unconfirmed && (!removing || node.removal_error) && (
            <button className="link" onClick={() => { setMode('remove'); setOpen(true); }}>{removing ? 'Try again' : 'Remove…'}</button>
          )}
          {(removing || node.status === 'stale' || node.status === 'pending') && (
            <button className="link" onClick={() => { setMode('mark'); setOpen(true); }}>Mark removed…</button>
          )}
        </div>
      )}

      {open && (
        <form className="card" onSubmit={submit} style={{ maxWidth: 'none' }}>
          <h3>{mode === 'remove' ? `Remove ${node.display_name}` : `Mark ${node.display_name} removed`}</h3>
          <p className="muted">
            {mode === 'remove'
              ? 'The agent on the machine uninstalls itself on its next heartbeat, within a minute or two, and confirms. Nothing else on the machine is touched.'
              : 'Use this when the machine is gone, was wiped, or you ran the local uninstall. It revokes the node\'s credential and takes it out of the console. Nothing is sent to the machine.'}
          </p>
          <fieldset>
            <legend>History</legend>
            <label className="check"><input type="radio" checked={history === 'keep'} onChange={() => setHistory('keep')} /> Keep it for the retention period</label>
            <label className="check"><input type="radio" checked={history === 'purge'} onChange={() => setHistory('purge')} /> Delete it now</label>
          </fieldset>
          <label>Type <strong>{node.display_name}</strong> to confirm
            <input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
          </label>
          {error && <p role="alert" className="error">{error}</p>}
          <div className="row">
            <button type="submit" disabled={busy || typed.trim() !== node.display_name}>{mode === 'remove' ? 'Remove node' : 'Mark removed'}</button>
            <button type="button" className="link" onClick={() => { setOpen(false); setTyped(''); setError(''); }}>Cancel</button>
          </div>
          {mode === 'remove' && !removing && node.status !== 'healthy' && (
            <button type="button" className="link" onClick={() => setMode('mark')}>The machine is gone or unreachable? Mark it removed instead</button>
          )}
        </form>
      )}
    </div>
  );
}

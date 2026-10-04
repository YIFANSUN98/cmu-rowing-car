import { useState } from 'react';
import { api } from './api';
export function AccessSettings({ onAdminChanged }: { onAdminChanged: () => void }) {
  const [role, setRole] = useState<'team' | 'admin'>('team');
  const [currentKey, setCurrentKey] = useState(''),
    [newKey, setNewKey] = useState(''),
    [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  return (
    <section className="access-settings">
      <h2>Manage access</h2>
      <p>
        Changing a key signs out everyone using that key. Share the new team key with your crew.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          setMessage('');
          if (newKey !== confirmation) {
            setError('The new keys do not match.');
            return;
          }
          setBusy(true);
          try {
            await api('password', 'POST', { role, currentKey, newKey });
            setCurrentKey('');
            setNewKey('');
            setConfirmation('');
            if (role === 'admin') onAdminChanged();
            else setMessage('Team key changed. Previous team sessions are signed out.');
          } catch (error) {
            setError((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="access-fields">
          <label className="field">
            Key to change
            <select value={role} onChange={(e) => setRole(e.target.value as 'team' | 'admin')}>
              <option value="team">Drivers and rowers</option>
              <option value="admin">Admin</option>
            </select>
          </label>
          <label className="field">
            Current admin key
            <input
              type="password"
              autoComplete="current-password"
              required
              value={currentKey}
              onChange={(e) => setCurrentKey(e.target.value)}
              maxLength={256}
            />
          </label>
          <label className="field">
            New access key
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={256}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
            />
          </label>
          <label className="field">
            Confirm new access key
            <input
              type="password"
              autoComplete="new-password"
              required
              minLength={8}
              maxLength={256}
              value={confirmation}
              onChange={(e) => setConfirmation(e.target.value)}
            />
          </label>
        </div>
        <p className="tiny">
          Use at least 8 characters. Changing the admin key also signs you out.
        </p>
        <button className="primary" disabled={busy}>
          {busy ? 'Changing key…' : 'Change access key'}
        </button>
        {error && (
          <p className="notice warning" role="alert">
            {error}
          </p>
        )}
        {message && <p role="status">{message}</p>}
      </form>
    </section>
  );
}

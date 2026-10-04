import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../exports/plan';
import { api, cached } from './api';
import { sharePlan, publishable } from './plan';
import type { Publication } from './schema';
export function PublishControls({ snapshot, stale }: { snapshot?: Snapshot; stale: boolean }) {
  const [publication, setPublication] = useState<Publication | null>(
    () => cached<Publication | null>('plan') ?? null,
  );
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    void api<Publication | null>('plan')
      .then((p) => {
        if (active) setPublication(p);
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    generation.current++;
    setMessage('');
  }, [snapshot, stale]);
  return (
    <section className="publish-panel">
      <div>
        <h3>Share with your crew</h3>
        <p>
          {publication
            ? 'A published plan is available to drivers and rowers.'
            : 'Publish the checked routes when your plan is ready.'}
        </p>
      </div>
      <div className="button-row">
        <button
          className="primary"
          disabled={busy || !snapshot || !publishable(snapshot, stale)}
          onClick={async () => {
            if (!snapshot || !publishable(snapshot, stale)) return;
            setBusy(true);
            setError('');
            const current = generation.current;
            try {
              const result = await api<Publication>('plan', 'PUT', sharePlan(snapshot));
              setPublication(result);
              setMessage(
                current === generation.current
                  ? 'Published. Drivers and rowers can now view this plan.'
                  : 'Published the previous result. Replan and publish again to include your latest edits.',
              );
            } catch (error) {
              setError((error as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Saving…' : publication ? 'Update published plan' : 'Publish to team'}
        </button>
        {publication && (
          <button
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError('');
              try {
                await api('plan', 'DELETE', {});
                setPublication(null);
                setMessage('Plan removed from the team view.');
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Unpublish plan
          </button>
        )}
      </div>
      {snapshot && !publishable(snapshot, stale) && (
        <p className="tiny">
          {snapshot.plan.settings.comparisonDates
            ? 'Historical comparisons cannot be published as a live schedule.'
            : 'Replan and resolve any issues before publishing.'}
        </p>
      )}
      {message && <p role="status">{message}</p>}
      {error && (
        <p className="notice warning" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

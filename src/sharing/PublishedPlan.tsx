import { useEffect, useMemo, useState } from 'react';
import { ClubBrand } from '../components/ClubBrand';
import { Results } from '../components/Results';
import { api, cached } from './api';
import { viewSnapshot } from './plan';
import type { Publication } from './schema';
export function PublishedPlan({ initialFromSession = false }: { initialFromSession?: boolean }) {
  const [publication, setPublication] = useState<Publication | null>(
    () => cached<Publication | null>('plan') ?? null,
  );
  const [loading, setLoading] = useState(() => cached('plan') === undefined),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    let refreshing = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retried = false;
    const load = async () => {
      if (refreshing) return;
      refreshing = true;
      try {
        const next = await api<Publication | null>('plan');
        if (active) {
          setPublication((previous) => (previous?.id === next?.id ? previous : next));
          setError('');
          retried = false;
        }
      } catch (error) {
        if (active) {
          setError((error as Error).message);
          // An initial transient storage failure should not wait for the 30-second poll.
          if (!retried && (error as Error & { status?: number }).status === 503) {
            retried = true;
            retry = setTimeout(() => {
              if (active) void load();
            }, 750);
          }
        }
      } finally {
        refreshing = false;
        if (active) setLoading(false);
      }
    };
    // Login/session can carry the current plan; avoid immediately requesting it twice.
    if (!initialFromSession || cached('plan') === undefined) void load();
    const visible = () => {
      if (document.visibilityState === 'visible') void load();
    };
    const interval = setInterval(visible, 30000);
    document.addEventListener('visibilitychange', visible);
    return () => {
      active = false;
      clearInterval(interval);
      clearTimeout(retry);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  const snapshot = useMemo(
    () => (publication ? viewSnapshot(publication) : undefined),
    [publication],
  );
  return (
    <>
      <header className="site-header">
        <ClubBrand />
        <div className="header-intro">
          <h1>Your week on the water.</h1>
          <p>Your crew’s published pickup plan. All times Eastern Time.</p>
        </div>
      </header>
      <main>
        <div className="published-meta">
          <p>
            {publication
              ? `Published ${new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', dateStyle: 'medium', timeStyle: 'short' }).format(new Date(publication.publishedAt))} ET`
              : ''}
          </p>
        </div>
        {loading ? (
          <p role="status">Loading the team plan…</p>
        ) : error && !snapshot ? (
          <p className="notice warning" role="alert">
            {error}
          </p>
        ) : snapshot ? (
          <>
            {error && (
              <p className="notice warning" role="status">
                Could not check for updates. Showing the last loaded plan.
              </p>
            )}
            <Results key={publication!.id} snapshot={snapshot} stale={false} />
          </>
        ) : (
          <section className="empty-plan">
            <h2>No plan published yet.</h2>
            <p>Your admin will publish the routes here when they are ready.</p>
          </section>
        )}
      </main>
    </>
  );
}

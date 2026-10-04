import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { preloadRouteMap } from '../components/routeMapLoader';
import { ClubBrand } from '../components/ClubBrand';
import { SiteFooter } from '../components/SiteFooter';
import { api, setAccess, accessGeneration, type Access } from './api';
import { PublishedPlan } from './PublishedPlan';
import { AccessSettings } from './AccessSettings';
const Planner = lazy(() => import('../App'));

export function AccessGate() {
  const [session, setSession] = useState<Access>();
  const [checking, setChecking] = useState(true);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [page, setPage] = useState<'planner' | 'published' | 'access'>('planner');
  const [publishedVisit, setPublishedVisit] = useState(0);
  const view = useRef({ session, page });
  view.current = { session, page };
  const clear = useCallback(() => {
    setAccess();
    setSession(undefined);
    setPage('planner');
  }, []);
  useEffect(() => {
    let cancelled = false;
    let first = true;
    const check = async () => {
      const epoch = accessGeneration();
      try {
        const current = await api<Access>(first ? 'session?includePlan=1' : 'session');
        first = false;
        if (!cancelled && epoch === accessGeneration()) {
          setAccess(current);
          setSession(current);
          setError('');
        }
      } catch (error) {
        if (!cancelled && epoch === accessGeneration()) {
          clear();
          setError(
            (error as Error & { status?: number }).status === 401 ? '' : (error as Error).message,
          );
        }
      } finally {
        if (!cancelled) setChecking(false);
      }
    };
    const expired = () => {
      clear();
      setError('Your session ended. Sign in with the current access key.');
    };
    const visible = () => {
      // Published-plan refreshes already authenticate. Do not run a second poll.
      if (
        document.visibilityState === 'visible' &&
        view.current.session?.role === 'admin' &&
        view.current.page !== 'published'
      )
        void check();
    };
    preloadRouteMap();
    void check();
    const interval = setInterval(visible, 30000);
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('access-expired', expired);
    return () => {
      cancelled = true;
      clearInterval(interval);
      document.removeEventListener('visibilitychange', visible);
      window.removeEventListener('access-expired', expired);
    };
  }, [clear]);
  if (checking)
    return (
      <main className="access-page">
        <p role="status">Opening your club planner…</p>
      </main>
    );
  if (!session)
    return (
      <>
        <main id="top" className="access-page">
          <ClubBrand />
          <form
            className="access-card"
            onSubmit={async (event) => {
              event.preventDefault();
              preloadRouteMap();
              setBusy(true);
              setError('');
              try {
                const current = await api<Access>('login', 'POST', { key, includePlan: true });
                setAccess(current);
                setSession(current);
                setKey('');
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            <span className="eyebrow">CMU ROWING / TEAM ACCESS</span>
            <h1>Your crew. Your plan.</h1>
            <p>Enter your club access key to continue.</p>
            <label className="field">
              Access key
              <input
                type="password"
                name="password"
                autoComplete="current-password"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                required
                maxLength={256}
              />
            </label>
            <button className="primary" disabled={busy}>
              {busy ? 'Signing in…' : 'Enter planner →'}
            </button>
            {error && (
              <p role="alert" className="notice warning">
                {error}
              </p>
            )}
          </form>
        </main>
        <SiteFooter />
      </>
    );
  return (
    <>
      <nav id="top" className="access-toolbar" aria-label="Club access">
        <span>{session.role === 'admin' ? 'Admin' : 'Team plan'}</span>
        <div className="button-row">
          {session.role === 'admin' && (
            <>
              <button
                onClick={() => setPage('planner')}
                aria-current={page === 'planner' ? 'page' : undefined}
              >
                Plan the route
              </button>
              <button
                onClick={() => {
                  setPage('published');
                  setPublishedVisit((n) => n + 1);
                }}
                aria-current={page === 'published' ? 'page' : undefined}
              >
                View published plan
              </button>
              <button
                onClick={() => setPage('access')}
                aria-current={page === 'access' ? 'page' : undefined}
              >
                Manage access
              </button>
            </>
          )}
          <button
            disabled={busy}
            onClick={async () => {
              preloadRouteMap();
              setBusy(true);
              setError('');
              try {
                await api('logout', 'POST', {});
                clear();
              } catch (error) {
                setError((error as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Sign out
          </button>
        </div>
      </nav>
      {error && (
        <p role="alert" className="notice warning access-error">
          {error}
        </p>
      )}
      {session.role === 'admin' ? (
        <>
          <div hidden={page !== 'planner'}>
            <Suspense fallback={<p role="status">Opening planner…</p>}>
              <Planner />
            </Suspense>
          </div>
          {page === 'published' && <PublishedPlan key={publishedVisit} />}
          {page === 'access' && (
            <main>
              <AccessSettings onAdminChanged={clear} />
            </main>
          )}
        </>
      ) : (
        <PublishedPlan initialFromSession />
      )}
      <SiteFooter />
    </>
  );
}

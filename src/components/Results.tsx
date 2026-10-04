import { travelLabel } from '../domain/types';
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../exports/plan';
import { instructions, navLink } from '../exports/plan';
import { clockMinutes } from '../domain/util';
import { RouteNavigation } from './RouteNavigation';
import { RideShareCards } from './RideShareCards';
import { loadRouteMap, preloadRouteMap, preloadedRouteMap } from './routeMapLoader';
const RouteMap = lazy(loadRouteMap);
export function Results({ snapshot, stale }: { snapshot: Snapshot; stale: boolean }) {
  const { plan, problems, data } = snapshot;
  const MapComponent = preloadedRouteMap() ?? RouteMap;
  useEffect(() => {
    if (plan.settings.mode !== 'tomtom') return;
    preloadRouteMap();
  }, [plan.settings.mode]);
  const names = useMemo(
    () => Object.fromEntries(data.members.map((m) => [m.member_id, m.display_name])),
    [data.members],
  );
  const [selected, setSelected] = useState(0);
  const [copyMessage, setCopyMessage] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const current = useRef<{ snapshot: Snapshot; stale: boolean } | null>({ snapshot, stale });
  current.current = { snapshot, stale };
  useEffect(() => {
    current.current = { snapshot, stale };
    return () => {
      current.current = null;
    };
  }, [snapshot, stale]);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const index = Math.min(selected, plan.days.length - 1),
    day = plan.days[index],
    problem = problems[index];
  const name = (id: string) => data.members.find((m) => m.member_id === id)?.display_name ?? id;
  const dayLabel = (date: string) =>
    new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(
      new Date(date + 'T12:00:00Z'),
    );
  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopyMessage('Driver instructions copied.');
    } catch {
      setCopyMessage('Clipboard unavailable. Select and copy the route details instead.');
    }
  };
  const exportExcel = async () => {
    if (stale || exporting) return;
    setExporting(true);
    setExportError('');
    try {
      const { downloadPlanExcel } = await import('../exports/excel');
      // Input edits, replanning or unmounting while the exporter loads invalidate this click.
      if (!current.current || current.current.stale || current.current.snapshot !== snapshot)
        return;
      downloadPlanExcel(snapshot);
    } catch {
      setExportError('Could not create the Excel file. Please try downloading again.');
    } finally {
      setExporting(false);
    }
  };
  if (!day) return null;
  return (
    <section className={'results ' + (stale ? 'stale-results' : '')} id="results">
      <div className="section-heading">
        <div>
          <span className="eyebrow">03 / YOUR WEEK ON THE WATER</span>
          <h2>
            {plan.verified
              ? plan.days.some((d) => d.rideShares?.length)
                ? 'Your rides, planned.'
                : 'A seat for everyone.'
              : 'This week needs attention.'}
          </h2>
        </div>
        <div className="result-actions">
          <button
            className="route-download"
            disabled={stale || exporting}
            onClick={exportExcel}
            title={
              stale
                ? 'Replan after changing inputs to download the updated routes.'
                : 'Download all planned dates as an Excel workbook'
            }
          >
            {exporting ? 'Preparing Excel…' : 'Download Excel ↓'}
          </button>
          <span className={'pill ' + (stale ? 'warning' : plan.verified ? 'good' : 'warning')}>
            {stale
              ? 'Stale · comparison only'
              : plan.verified
                ? plan.days.some((d) => d.rideShares?.length)
                  ? 'Uber booking required'
                  : 'Constraints checked'
                : 'Incomplete plan'}
          </span>
        </div>
      </div>
      {exportError && (
        <p className="notice warning" role="alert">
          {exportError}
        </p>
      )}
      {stale && (
        <div className="notice warning" role="status">
          Inputs or settings changed. This previous result is stale. Replan before using it.
        </div>
      )}
      {plan.settings.comparisonDates && (
        <p className="notice">
          Historical comparison · estimates for{' '}
          {Object.values(plan.settings.comparisonDates).sort().join(', ')}.
        </p>
      )}
      <div className="week-layout">
        <div className="daily">
          <div className="day-tabs" role="tablist" aria-label="Practice days">
            {plan.days.map((d, i) => (
              <button
                key={d.date}
                role="tab"
                aria-selected={index === i}
                onClick={() => setSelected(i)}
                className={index === i ? 'active' : ''}
              >
                <span>{dayLabel(d.date)}</span>
                <b>{Number(d.date.slice(-2))}</b>
                <small>
                  {d.status === 'feasible'
                    ? `${d.routes.length} cars${d.rideShares?.length ? ` + ${d.rideShares.length} Uber` : ''}`
                    : 'Needs review'}
                </small>
              </button>
            ))}
          </div>
          <div className="daily-title">
            <h3>
              {new Intl.DateTimeFormat('en-US', {
                weekday: 'long',
                month: 'long',
                day: 'numeric',
                timeZone: 'UTC',
              }).format(new Date(day.date + 'T12:00:00Z'))}
            </h3>
            <span>Arrive by {clockMinutes(problem.deadline)} ET</span>
          </div>
          {day.messages.map((message, i) => (
            <div className={'notice ' + (day.status === 'feasible' ? '' : 'warning')} key={i}>
              {message}
            </div>
          ))}
          {day.routes.map((route, ri) => {
            const cardKey = `${day.date}:${route.driverId}`;
            const routeId = `route-${day.date}-${ri}`;
            const text = instructions(route, problem, data, plan.simulation);
            let previous = problem.matrix.locations[route.start].address;
            return (
              <article className="car-card" key={route.driverId}>
                <header className="car-summary">
                  <div className="car-people">
                    <span className="eyebrow">DRIVER</span>
                    <h4>{name(route.driverId)}</h4>
                    <div className="rider-chips" aria-label="Riders">
                      <span className="rider-label">Riders</span>
                      {route.passengerIds.length ? (
                        route.passengerIds.map((id) => <span key={id}>{name(id)}</span>)
                      ) : (
                        <span>None</span>
                      )}
                    </div>
                  </div>
                  <button
                    className="text-button route-toggle"
                    aria-expanded={Boolean(expanded[cardKey])}
                    aria-controls={routeId}
                    aria-label={`${expanded[cardKey] ? 'Hide' : 'Show'} route for ${name(route.driverId)}`}
                    onClick={() =>
                      setExpanded((previous) => ({ ...previous, [cardKey]: !previous[cardKey] }))
                    }
                  >
                    {expanded[cardKey] ? 'Hide route −' : 'Show route +'}
                  </button>
                </header>
                {expanded[cardKey] && (
                  <div id={routeId} className="car-route">
                    {!plan.scenario?.uploadedTest && (
                      <RouteNavigation
                        route={route}
                        problem={problem}
                        driver={name(route.driverId)}
                        stale={stale}
                      />
                    )}
                    <div className="car-facts">
                      <span>
                        {route.passengerIds.length + 1} / {route.seats} seats
                      </span>
                      {plan.settings.mode !== 'mock' && (
                        <span className="travel-attribution" translate="no">
                          {travelLabel(plan.settings.mode)}
                        </span>
                      )}
                      <span>{Math.round(route.durationSeconds / 60)} min route</span>
                      <span>{(route.meters / 1000).toFixed(1)} km</span>
                      <span>{route.stops.length} pickup stops</span>
                    </div>
                    {plan.settings.mode === 'tomtom' && !plan.scenario?.uploadedTest && (
                      <Suspense fallback={<p className="map-message">Loading map…</p>}>
                        <MapComponent route={route} problem={problem} names={names} />
                      </Suspense>
                    )}
                    <ol className="timeline">
                      <li>
                        <time>{clockMinutes(route.departure)}</time>
                        <div>
                          <b>Leave for practice</b>
                          <p>{previous}</p>
                        </div>
                        <span className="timeline-mark start" />
                      </li>
                      {route.stops.map((stop, si) => {
                        const address = problem.matrix.locations[stop.location].address,
                          link = navLink(previous, address);
                        previous = address;
                        return (
                          <li key={si}>
                            <time title={clockMinutes(stop.arrival)}>
                              {clockMinutes(stop.arrival)}
                            </time>
                            <div>
                              <b>
                                {si + 1}. {stop.memberIds.map(name).join(' + ')}
                              </b>
                              <p>{address}</p>
                              <small>
                                Leave {clockMinutes(stop.departure)} · {stop.occupancy} aboard
                              </small>
                            </div>
                            {!plan.scenario?.uploadedTest && (
                              <a
                                aria-label={`Navigate to pickup ${si + 1} for ${name(route.driverId)}`}
                                href={link}
                                target="_blank"
                                rel="noreferrer"
                              >
                                ↗
                              </a>
                            )}
                            <span className="timeline-mark" />
                          </li>
                        );
                      })}
                      <li className="destination">
                        <time>{clockMinutes(route.arrival)}</time>
                        <div>
                          <b>Boathouse</b>
                          <p>{problem.matrix.locations[route.destination].address}</p>
                          <small>
                            Estimated arrival
                            {plan.settings.bufferMinutes > 0
                              ? ` · ${plan.settings.bufferMinutes} min planned buffer`
                              : ''}
                          </small>
                        </div>
                        {!plan.scenario?.uploadedTest && (
                          <a
                            aria-label={`Navigate to boathouse for ${name(route.driverId)}`}
                            href={navLink(
                              previous,
                              problem.matrix.locations[route.destination].address,
                            )}
                            target="_blank"
                            rel="noreferrer"
                          >
                            ↗
                          </a>
                        )}
                        <span className="timeline-mark finish" />
                      </li>
                    </ol>
                    <footer>
                      <span>
                        Passenger{route.passengerIds.length === 1 ? '' : 's'}:{' '}
                        {route.passengerIds.map(name).join(', ') || 'None'}
                      </span>
                      <button className="text-button" disabled={stale} onClick={() => copy(text)}>
                        Copy instructions ↗
                      </button>
                    </footer>
                  </div>
                )}
              </article>
            );
          })}
          <RideShareCards day={day} problem={problem} name={name} stale={stale} />
        </div>
      </div>
      {copyMessage && (
        <div role="status" className="tiny">
          {copyMessage}
        </div>
      )}
    </section>
  );
}

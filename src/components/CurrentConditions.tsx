import { useEffect, useState } from 'react';
import { CurrentClock } from './CurrentClock';
import { parseWeather, WEATHER_SOURCE, WEATHER_URL } from '../weather';
import { parseFlow, FLOW_SOURCE, FLOW_URL } from '../water';

const REFRESH_MS = 10 * 60 * 1000;
function useObservation<T>(url: string, parse: (value: unknown) => T) {
  const [state, setState] = useState<{ observation?: T; failed: boolean }>({ failed: false });
  useEffect(() => {
    let disposed = false,
      lastAttempt = 0;
    let controller: AbortController | undefined;
    const refresh = async () => {
      lastAttempt = Date.now();
      controller?.abort();
      const request = new AbortController();
      controller = request;
      const timeout = setTimeout(() => request.abort(), 12000);
      try {
        const response = await fetch(url, {
          signal: request.signal,
          headers: { Accept: 'application/geo+json' },
          referrerPolicy: 'no-referrer',
        });
        if (!response.ok) throw new Error('Observation unavailable.');
        const observation = parse(await response.json());
        if (!disposed) setState({ observation, failed: false });
      } catch {
        if (!disposed) setState((previous) => ({ ...previous, failed: true }));
      } finally {
        clearTimeout(timeout);
      }
    };
    const refreshIfVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastAttempt >= REFRESH_MS)
        void refresh();
    };
    void refresh();
    const interval = setInterval(refreshIfVisible, REFRESH_MS);
    document.addEventListener('visibilitychange', refreshIfVisible);
    return () => {
      disposed = true;
      controller?.abort();
      clearInterval(interval);
      document.removeEventListener('visibilitychange', refreshIfVisible);
    };
  }, [url, parse]);
  return state;
}

const fresh = (observation?: { observedAt: string }) => {
  if (!observation) return false;
  const age = Date.now() - Date.parse(observation.observedAt);
  return age >= -5 * 60 * 1000 && age <= 2 * 60 * 60 * 1000;
};
function details(source: string, state: { observation?: { observedAt: string }; failed: boolean }) {
  if (!state.observation) return `${source}. ${state.failed ? 'Unavailable' : 'Loading…'}`;
  const when = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(state.observation.observedAt));
  return `${source}. Observed ${when} ET.${!fresh(state.observation) ? ' Latest reading is out of date.' : ''}${state.failed ? ' Refresh unavailable.' : ''}`;
}

export function CurrentConditions() {
  const weather = useObservation(WEATHER_URL, parseWeather);
  const flow = useObservation(FLOW_URL, parseFlow);
  const temperature =
    fresh(weather.observation) && weather.observation?.temperatureC != null
      ? `${Math.round((weather.observation.temperatureC * 9) / 5 + 32)}°F`
      : '—';
  const discharge = fresh(flow.observation)
    ? Math.round(flow.observation!.cubicFeetPerSecond).toLocaleString('en-US')
    : '—';
  return (
    <aside className="current-conditions" aria-label="Pittsburgh time and river conditions">
      <CurrentClock />
      <div className="conditions-readings">
        <a
          className="condition-reading"
          href={WEATHER_SOURCE}
          target="_blank"
          rel="noreferrer"
          title={details('NWS air temperature · Allegheny County Airport', weather)}
          aria-label={`Temperature: ${temperature === '—' ? 'unavailable' : temperature}. ${details('NWS · Allegheny County Airport', weather)}`}
        >
          <span>Temperature</span>
          <strong>{temperature}</strong>
        </a>
        <a
          className="condition-reading"
          href={FLOW_SOURCE}
          target="_blank"
          rel="noreferrer"
          title={details(
            'USGS · Allegheny at Natrona, upstream of the boathouse. Provisional discharge, in cubic feet per second',
            flow,
          )}
          aria-label={`Water flow at Natrona: ${discharge === '—' ? 'unavailable' : `${discharge} cubic feet per second`}. ${details('USGS upstream gauge', flow)}`}
        >
          <span>Flow · Natrona</span>
          <strong>
            {discharge}
            {discharge !== '—' && <small> ft³/s</small>}
          </strong>
        </a>
      </div>
    </aside>
  );
}

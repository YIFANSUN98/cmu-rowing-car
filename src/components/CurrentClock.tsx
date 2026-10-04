import { useEffect, useState } from 'react';
import { ZONE } from '../domain/types';

const timeFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hour12: true,
});
const dateFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  weekday: 'short',
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

export function CurrentClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const refresh = () => {
      clearTimeout(timer);
      setNow(new Date());
      // Update at the next minute boundary, including after a suspended tab resumes.
      timer = setTimeout(refresh, 60000 - (Date.now() % 60000) + 25);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh();
    };
    refresh();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);
  const parts = timeFormat.formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value;
  return (
    <div
      className="hero-badge"
      role="timer"
      aria-label="Current Pittsburgh date and time"
      aria-live="off"
    >
      <b>
        <time dateTime={now.toISOString()}>
          {part('hour')}:{part('minute')} <small>{part('dayPeriod')} ET</small>
        </time>
      </b>
      <span>{dateFormat.format(now)}</span>
    </div>
  );
}

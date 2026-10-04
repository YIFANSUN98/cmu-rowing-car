import type { CarRoute, DayProblem } from '../domain/types';
import { routeNavigation } from '../exports/navigation';

export function RouteNavigation({
  route,
  problem,
  driver,
  stale,
}: {
  route: CarRoute;
  problem: DayProblem;
  driver: string;
  stale: boolean;
}) {
  const links = routeNavigation(route, problem);
  return (
    <div className="route-navigation">
      <a
        className="maps-button"
        href={stale ? undefined : (links.url ?? links.parts[0].url)}
        aria-disabled={stale || undefined}
        aria-label={`Open ${driver}'s route in Google Maps`}
        target="_blank"
        rel="noreferrer"
      >
        {links.url ? 'Open in Google Maps ↗' : 'Open route · part 1 ↗'}
      </a>
      <p className="tiny">
        Opens the app when installed. Pickup order is included; Google may choose different roads or
        times.
      </p>
      {links.parts.length > 1 && (
        <details className="navigation-parts">
          <summary>Mobile browser: open in {links.parts.length} parts</summary>
          <p className="tiny">
            Use these if your browser omits a stop. Open the next part after reaching the previous
            part’s final pickup.
          </p>
          <div className="button-row">
            {links.parts.map((part, i) => (
              <a
                key={i}
                className="maps-button"
                href={stale ? undefined : part.url}
                aria-disabled={stale || undefined}
                target="_blank"
                rel="noreferrer"
              >
                Part {i + 1} ↗
              </a>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

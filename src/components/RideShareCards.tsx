import type { DayPlan, DayProblem } from '../domain/types';
import { clockMinutes } from '../domain/util';
import { googleDirections } from '../exports/navigation';

export function RideShareCards({
  day,
  problem,
  name,
  stale,
}: {
  day: DayPlan;
  problem: DayProblem;
  name: (id: string) => string;
  stale: boolean;
}) {
  return (
    <>
      {(day.rideShares ?? []).map((trip, index) => {
        const pickup = problem.matrix.locations[trip.location],
          destination = problem.matrix.locations[trip.destination];
        return (
          <article className="car-card uber-card" key={index}>
            <header className="car-summary">
              <div className="car-people">
                <span className="eyebrow">UBER {index + 1} · BOOKING REQUIRED</span>
                <h4>{trip.memberIds.map(name).join(', ')}</h4>
                <p className="tiny">
                  {trip.memberIds.length} passenger{trip.memberIds.length === 1 ? '' : 's'} · one
                  pickup · no ride has been ordered
                </p>
              </div>
            </header>
            <div className="car-route">
              <ol className="timeline">
                <li>
                  <time>{clockMinutes(trip.pickupTime)}</time>
                  <div>
                    <b>Be ready for pickup</b>
                    <p>{pickup.address}</p>
                    <small>
                      Plan to leave by {clockMinutes(trip.departure)}. Book ahead and allow for the
                      app’s pickup wait.
                    </small>
                  </div>
                  <span className="timeline-mark start" />
                </li>
                <li>
                  <time>{clockMinutes(trip.arrival)}</time>
                  <div>
                    <b>Boathouse</b>
                    <p>{destination.address}</p>
                    <small>
                      Driving estimate; Uber availability and pickup wait are not included.
                    </small>
                  </div>
                  <span className="timeline-mark finish" />
                </li>
              </ol>
              <a
                className="maps-button"
                href={stale ? undefined : googleDirections([pickup, destination])}
                aria-disabled={stale || undefined}
                target="_blank"
                rel="noreferrer"
              >
                View trip in Google Maps ↗
              </a>
            </div>
          </article>
        );
      })}
      {day.independent.length > 0 && (
        <div className="notice">
          <b>Travelling independently</b>
          <p>{day.independent.map(name).join(', ')}</p>
        </div>
      )}
      {day.external.length > 0 && (
        <div className="notice">
          <b>Other arranged transport</b>
          <p>{day.external.map(name).join(', ')}</p>
        </div>
      )}
    </>
  );
}

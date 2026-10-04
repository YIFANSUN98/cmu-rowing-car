import { useMemo, useState } from 'react';
import type { Dataset } from '../domain/types';
import {
  manualDraftErrors,
  moveManualPerson,
  setManualDriver,
  type ManualDay,
  type ManualDraft,
} from '../planner/manual';

export function ManualPlanEditor({
  data,
  draft,
  busy,
  generationError,
  onChange,
  onGenerate,
  onCancel,
}: {
  data: Dataset;
  draft: ManualDraft;
  busy: boolean;
  generationError?: string;
  onChange: (draft: ManualDraft) => void;
  onGenerate: () => void;
  onCancel: () => void;
}) {
  const [date, setDate] = useState(draft.days[0]?.date),
    [showErrors, setShowErrors] = useState(false);
  const day = draft.days.find((d) => d.date === date) ?? draft.days[0];
  const names = useMemo(
    () => new Map(data.members.map((m) => [m.member_id, m.display_name])),
    [data],
  );
  const name = (id: string) => names.get(id) ?? 'Choose a driver';
  const errors = manualDraftErrors(draft, data);
  const update = (next: ManualDay) =>
    onChange({ ...draft, days: draft.days.map((d) => (d.date === day.date ? next : d)) });
  const target = (id: string) => {
    const driver = day.cars.find((c) => c.driverId === id);
    if (driver) return `driver:${driver.id}`;
    const car = day.cars.find((c) => c.passengerIds.includes(id));
    if (car) return `car:${car.id}`;
    return day.people.find((p) => p.id === id)!.mode;
  };
  const unassigned = day.people.filter(
    (p) =>
      p.mode === 'carpool' &&
      !day.cars.some((c) => c.driverId === p.id || c.passengerIds.includes(p.id)),
  );
  const move = (carId: string, index: number, delta: number) => {
    const next = structuredClone(day),
      ids = next.cars.find((c) => c.id === carId)!.passengerIds;
    [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
    update(next);
  };
  return (
    <section id="manual-editor" className="manual-editor" aria-labelledby="manual-title">
      <div className="section-heading">
        <div>
          <span className="eyebrow">ADMIN / SPECIAL ARRANGEMENTS</span>
          <h2 id="manual-title">Arrange your routes.</h2>
        </div>
      </div>
      <p>
        Choose the cars and pickup order. Generating updates the times and maps, keeping your
        assignments. Selecting a driver confirms they can drive that day.
      </p>
      <p className="tiny">
        These changes apply to this plan. Your uploaded sheets stay unchanged; automatic replanning
        starts from those sheets.
      </p>
      <fieldset disabled={busy} className="manual-fields">
        <legend className="sr-only">Manual route arrangements</legend>
        <div className="manual-toolbar">
          <label className="field">
            Arrival time for this plan
            <input
              aria-label="Manual arrival deadline"
              type="time"
              value={draft.deadline}
              onChange={(e) => onChange({ ...draft, deadline: e.target.value })}
            />
          </label>
          <div className="day-tabs" role="tablist" aria-label="Dates to edit">
            {draft.days.map((d) => (
              <button
                type="button"
                key={d.date}
                role="tab"
                aria-selected={d.date === day.date}
                className={d.date === day.date ? 'active' : ''}
                onClick={() => setDate(d.date)}
              >
                {d.date}
              </button>
            ))}
          </div>
        </div>
        <div className="manual-heading">
          <h3>Cars for {day.date}</h3>
          <button
            onClick={() =>
              update({
                ...day,
                cars: [
                  ...day.cars,
                  {
                    id: crypto.randomUUID(),
                    driverId: '',
                    passengerIds: [],
                    seats: 5,
                    leaveAt: '',
                  },
                ],
              })
            }
          >
            Add car
          </button>
        </div>
        {!day.cars.length && (
          <p className="notice">
            Add a car and choose its driver, then assign riders below. You can also use Uber or
            independent travel.
          </p>
        )}
        <div className="manual-cars">
          {day.cars.map((car, index) => (
            <article className="manual-car" key={car.id} aria-label={`Edit car ${index + 1}`}>
              <div className="manual-heading">
                <h4>
                  Car {index + 1}{' '}
                  <span className="tiny">
                    {(car.driverId ? 1 : 0) + car.passengerIds.length} / {car.seats} seats
                  </span>
                </h4>
                <button
                  onClick={() => update({ ...day, cars: day.cars.filter((c) => c.id !== car.id) })}
                  aria-label={`Remove car ${index + 1}`}
                >
                  Remove car
                </button>
              </div>
              <label className="field">
                Driver
                <select
                  aria-label={`Driver for car ${index + 1}`}
                  value={car.driverId}
                  onChange={(e) => update(setManualDriver(day, car.id, e.target.value))}
                >
                  <option value="">Choose a driver</option>
                  {data.members.map((m) => (
                    <option key={m.member_id} value={m.member_id}>
                      {m.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <div className="manual-car-options">
                <label className="field">
                  Seats, including driver
                  <select
                    aria-label={`Seats for car ${index + 1}`}
                    value={car.seats}
                    onChange={(e) =>
                      update({
                        ...day,
                        cars: day.cars.map((c) =>
                          c.id === car.id ? { ...c, seats: Number(e.target.value) } : c,
                        ),
                      })
                    }
                  >
                    {[1, 2, 3, 4, 5].map((n) => (
                      <option key={n}>{n}</option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  Leave at <span className="tiny">Blank = calculate</span>
                  <input
                    aria-label={`Departure for car ${index + 1}`}
                    type="time"
                    value={car.leaveAt}
                    onChange={(e) =>
                      update({
                        ...day,
                        cars: day.cars.map((c) =>
                          c.id === car.id ? { ...c, leaveAt: e.target.value } : c,
                        ),
                      })
                    }
                  />
                </label>
              </div>
              <p className="tiny">Pickup order · use the arrows to change it</p>
              <ol className="manual-passengers">
                {car.passengerIds.map((id, i) => (
                  <li key={id}>
                    <span>{name(id)}</span>
                    <div className="manual-order-buttons">
                      <button
                        disabled={i === 0}
                        aria-label={`Move ${name(id)} earlier in car ${index + 1}`}
                        onClick={() => move(car.id, i, -1)}
                      >
                        ↑
                      </button>
                      <button
                        disabled={i === car.passengerIds.length - 1}
                        aria-label={`Move ${name(id)} later in car ${index + 1}`}
                        onClick={() => move(car.id, i, 1)}
                      >
                        ↓
                      </button>
                    </div>
                  </li>
                ))}
              </ol>
              {!car.passengerIds.length && (
                <p className="tiny">Assign riders from the crew list below.</p>
              )}
            </article>
          ))}
        </div>
        <div className="manual-heading">
          <h3>Crew and travel</h3>
          {unassigned.length > 0 && (
            <span className="manual-unassigned" role="status">
              {unassigned.length} need an assignment
            </span>
          )}
        </div>
        <p className="tiny">
          Move a person to another car, mark a cancellation, or choose Uber / own travel. Open
          Pickup details to change an address or ready time for this date.
        </p>
        <div className="manual-crew">
          {day.people.map((person) => (
            <div
              key={person.id}
              className="manual-person"
              data-unassigned={unassigned.some((p) => p.id === person.id) || undefined}
            >
              <label className="field">
                <b>{name(person.id)}</b>
                <select
                  aria-label={`Travel for ${name(person.id)}`}
                  value={target(person.id)}
                  onChange={(e) => update(moveManualPerson(day, person.id, e.target.value))}
                >
                  {day.cars.some((c) => c.driverId === person.id) && (
                    <option value={target(person.id)}>
                      Driving car {day.cars.findIndex((c) => c.driverId === person.id) + 1}
                    </option>
                  )}
                  {['unconfirmed', 'unknown'].includes(person.mode) && (
                    <option value={person.mode}>Needs review</option>
                  )}
                  <option value="carpool">Unassigned rider</option>
                  {day.cars
                    .filter((c) => c.driverId !== person.id)
                    .map((c) => (
                      <option key={c.id} value={`car:${c.id}`}>
                        Car {day.cars.indexOf(c) + 1} · {name(c.driverId)}
                      </option>
                    ))}
                  <option value="uber">Uber · booking required</option>
                  <option value="self">Own travel</option>
                  <option value="external">Other arranged transport</option>
                  <option value="absent">Not attending</option>
                </select>
              </label>
              <details>
                <summary>Pickup details for {name(person.id)}</summary>
                <div className="manual-pickup-fields">
                  <label className="field">
                    Pickup / driver start
                    <input
                      aria-label={`Pickup for ${name(person.id)}`}
                      value={person.pickup}
                      onChange={(e) =>
                        update({
                          ...day,
                          people: day.people.map((p) =>
                            p.id === person.id ? { ...p, pickup: e.target.value } : p,
                          ),
                        })
                      }
                    />
                  </label>
                  <label className="field">
                    Ready after
                    <input
                      aria-label={`Ready time for ${name(person.id)}`}
                      type="time"
                      value={person.readyAfter}
                      onChange={(e) =>
                        update({
                          ...day,
                          people: day.people.map((p) =>
                            p.id === person.id ? { ...p, readyAfter: e.target.value } : p,
                          ),
                        })
                      }
                    />
                  </label>
                </div>
              </details>
            </div>
          ))}
        </div>
      </fieldset>
      {generationError && (
        <div className="notice warning" role="alert">
          {generationError}
        </div>
      )}
      {showErrors && errors.length > 0 && (
        <div className="notice warning" role="alert">
          <b>Finish these arrangements</b>
          <ul>
            {errors.slice(0, 10).map((error, i) => (
              <li key={i}>{error}</li>
            ))}
          </ul>
          {errors.length > 10 && <p>{errors.length - 10} more items remain.</p>}
        </div>
      )}
      <div className="button-row manual-actions">
        <button
          className="primary"
          disabled={busy}
          onClick={() => {
            setShowErrors(true);
            if (!errors.length) onGenerate();
          }}
        >
          {busy ? 'Generating…' : 'Generate updated plan'}
        </button>
        <button onClick={onCancel}>Cancel edits</button>
      </div>
    </section>
  );
}

// The only structure that may be sent to team members. No input sheets or full Snapshot.
export interface Place {
  address: string;
  lat?: number;
  lng?: number;
}
export interface SharedRoute {
  driver: string;
  start: Place;
  destination: Place;
  departure: number;
  arrival: number;
  stops: { names: string[]; place: Place; arrival: number; departure: number }[];
  drivingSeconds: number;
  meters: number;
  seats: number;
  geometry?: { lat: number; lng: number }[];
}
export interface SharedPlan {
  schemaVersion: 1;
  deadline: string;
  days: {
    date: string;
    routes: SharedRoute[];
    independent?: string[];
    external?: string[];
    rideShares?: {
      names: string[];
      pickup: Place;
      destination: Place;
      pickupTime: number;
      departure: number;
      arrival: number;
      drivingSeconds: number;
      meters: number;
    }[];
  }[];
}
export interface Publication {
  id: string;
  publishedAt: string;
  plan: SharedPlan;
}

// Construct a new allowlisted object at the trust boundary: extra private fields are discarded.
export function cleanPlan(value: unknown): SharedPlan {
  const fail = (): never => {
    throw new Error('Publish a complete, checked plan with valid routes and pickup times.');
  };
  const object = (v: unknown): Record<string, any> =>
    v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, any>) : fail();
  const text = (v: unknown, max: number) =>
    typeof v === 'string' && v.trim() && v.length <= max && !/[\u0000-\u001f]/.test(v) ? v : fail();
  const number = (v: unknown, min: number, max: number) =>
    typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max ? v : fail();
  const array = (v: unknown, min: number, max: number): any[] =>
    Array.isArray(v) && v.length >= min && v.length <= max ? v : fail();
  const point = (v: unknown) => {
    const p = object(v);
    return { lat: number(p.lat, -90, 90), lng: number(p.lng, -180, 180) };
  };
  const place = (v: unknown): Place => {
    const p = object(v);
    return {
      address: text(p.address, 500),
      ...(p.lat !== undefined || p.lng !== undefined ? point(p) : {}),
    };
  };
  const plan = object(value);
  if (plan.schemaVersion !== 1 || !/^([01]\d|2[0-3]):[0-5]\d$/.test(plan.deadline)) fail();
  const [h, m] = plan.deadline.split(':').map(Number);
  const deadline = h * 3600 + m * 60;
  const dates = new Set<string>();
  return {
    schemaVersion: 1,
    deadline: plan.deadline,
    days: array(plan.days, 1, 7).map((value) => {
      const day = object(value),
        date = text(day.date, 10);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
        Number.isNaN(Date.parse(`${date}T12:00:00Z`)) ||
        new Date(`${date}T12:00:00Z`).toISOString().slice(0, 10) !== date ||
        dates.has(date)
      )
        fail();
      dates.add(date);
      return {
        date,
        ...(day.independent === undefined
          ? {}
          : { independent: array(day.independent, 0, 500).map((n) => text(n, 150)) }),
        ...(day.external === undefined
          ? {}
          : { external: array(day.external, 0, 500).map((n) => text(n, 150)) }),
        ...(day.rideShares === undefined
          ? {}
          : {
              rideShares: array(day.rideShares, 0, 100).map((value) => {
                const r = object(value),
                  pickupTime = number(r.pickupTime, 0, deadline),
                  departure = number(r.departure, pickupTime, deadline),
                  arrival = number(r.arrival, departure, deadline);
                return {
                  names: array(r.names, 1, 4).map((n) => text(n, 150)),
                  pickup: place(r.pickup),
                  destination: place(r.destination),
                  pickupTime,
                  departure,
                  arrival,
                  drivingSeconds: number(r.drivingSeconds, 0, arrival - departure),
                  meters: number(r.meters, 0, 1000000),
                };
              }),
            }),
        routes: array(day.routes, 0, 100).map((value): SharedRoute => {
          const r = object(value),
            departure = number(r.departure, 0, deadline),
            arrival = number(r.arrival, departure, deadline);
          let previous = departure,
            riders = 0;
          const stops = array(r.stops, 0, 50).map((value) => {
            const s = object(value),
              a = number(s.arrival, previous, arrival),
              d = number(s.departure, a, arrival);
            previous = d;
            const names = array(s.names, 1, 50).map((n) => text(n, 150));
            riders += names.length;
            return { names, place: place(s.place), arrival: a, departure: d };
          });
          const seats = number(r.seats, riders + 1, 100);
          if (!Number.isInteger(seats)) fail();
          return {
            driver: text(r.driver, 150),
            start: place(r.start),
            destination: place(r.destination),
            departure,
            arrival,
            stops,
            seats,
            drivingSeconds: number(r.drivingSeconds, 0, arrival - departure),
            meters: number(r.meters, 0, 1000000),
            ...(r.geometry === undefined
              ? {}
              : { geometry: array(r.geometry, 0, 30000).map(point) }),
          };
        }),
      };
    }),
  };
}

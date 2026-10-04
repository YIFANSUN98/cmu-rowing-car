import type { CarRoute, DayProblem, Location } from '../domain/types';

const destination = (place: Location) =>
  Number.isFinite(place.lat) && Number.isFinite(place.lng)
    ? `${place.lat!.toFixed(6)},${place.lng!.toFixed(6)}`
    : place.address;

export function googleDirections(points: Location[]) {
  const parameters = new URLSearchParams({
    api: '1',
    origin: destination(points[0]),
    destination: destination(points.at(-1)!),
    travelmode: 'driving',
    dir_action: 'navigate',
  });
  if (points.length > 2)
    parameters.set('waypoints', points.slice(1, -1).map(destination).join('|'));
  const url = `https://www.google.com/maps/dir/?${parameters}`;
  if (url.length > 2048) return undefined;
  return url;
}

export function routeNavigation(route: CarRoute, problem: DayProblem) {
  // Keep the verified order. A shared pickup is one stop, not one waypoint per person.
  const points = [route.start, ...route.stops.map((stop) => stop.location), route.destination].map(
    (index) => problem.matrix.locations[index],
  );
  const parts: { url: string; from: string; to: string }[] = [];
  let start = 0;
  while (start < points.length - 1) {
    // Mobile browsers support three intermediate waypoints; overlap the joining stop.
    let end = Math.min(start + 4, points.length - 1);
    let url = googleDirections(points.slice(start, end + 1));
    while (!url && end > start + 1) {
      end--;
      url = googleDirections(points.slice(start, end + 1));
    }
    if (!url) throw new Error('This address is too long for a Google Maps link.');
    parts.push({ url, from: points[start].address, to: points[end].address });
    start = end;
  }
  return { url: points.length <= 11 ? googleDirections(points) : undefined, parts };
}

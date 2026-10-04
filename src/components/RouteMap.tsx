import { useEffect, useRef, useState } from 'react';
import * as L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { CarRoute, DayProblem } from '../domain/types';

export default function RouteMap({
  route,
  problem,
  names,
}: {
  route: CarRoute;
  problem: DayProblem;
  names: Record<string, string>;
}) {
  const container = useRef<HTMLDivElement>(null);
  const fit = useRef<() => void>(() => {});
  const focusStop = useRef<Record<string, () => void>>({});
  const [tileError, setTileError] = useState(false);
  useEffect(() => {
    const stops = [
      {
        location: route.start,
        badge: 'D',
        label: `Driver: ${names[route.driverId]}`,
        kind: 'driver',
      },
      ...route.stops.map((s, i) => ({
        location: s.location,
        badge: String(i + 1),
        label: `Pickup ${i + 1}: ${s.memberIds.map((id) => names[id]).join(' + ')}`,
        kind: 'pickup',
      })),
      { location: route.destination, badge: 'B', label: 'Boathouse', kind: 'finish' },
    ];
    const map = L.map(container.current!, { scrollWheelZoom: true, minZoom: 1 });
    setTileError(false);
    const key = import.meta.env.VITE_TOMTOM_API_KEY;
    const tiles = L.tileLayer(
      `https://api.tomtom.com/map/1/tile/basic/main/{z}/{x}/{y}.png?key=${encodeURIComponent(key)}&language=en-US&tileSize=512`,
      {
        maxZoom: 19,
        tileSize: 512,
        zoomOffset: -1,
        keepBuffer: 0,
        updateWhenIdle: true,
        attribution:
          '&copy; <a href="https://www.tomtom.com/en_gb/thirdpartyproductterms/" target="_blank" rel="noreferrer">TomTom</a>',
      },
    );
    tiles.on('tileerror', () => setTileError(true));
    tiles.addTo(map);
    const bounds = L.latLngBounds([]);
    if (route.geometry?.length) {
      const line = L.polyline(route.geometry, {
        color: '#a51c30',
        weight: 5,
        opacity: 0.9,
        className: 'route-road',
      }).addTo(map);
      bounds.extend(line.getBounds());
    }
    // Combine co-located stops into one labelled marker so none hide each other.
    const groups = new Map<string, typeof stops>();
    for (const stop of stops) {
      const location = problem.matrix.locations[stop.location];
      if (!Number.isFinite(location.lat) || !Number.isFinite(location.lng)) continue;
      const key = `${location.lat},${location.lng}`;
      groups.set(key, [...(groups.get(key) ?? []), stop]);
    }
    for (const group of groups.values()) {
      const location = problem.matrix.locations[group[0].location];
      const position: L.LatLngTuple = [location.lat!, location.lng!];
      const badge = document.createElement('span');
      badge.textContent = group.map((s) => s.badge).join('·');
      const popup = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = group.map((s) => s.label).join(' / ');
      const address = document.createElement('p');
      address.textContent = location.address;
      popup.append(title, address);
      const width = Math.max(30, badge.textContent.length * 10 + 12);
      const marker = L.marker(position, {
        title: title.textContent,
        alt: title.textContent,
        icon: L.divIcon({
          html: badge,
          className: `route-pin ${group[0].kind}`,
          iconSize: [width, 30],
          iconAnchor: [width / 2, 15],
        }),
      })
        .bindPopup(popup)
        .addTo(map);
      group.forEach((stop) => {
        focusStop.current[stop.badge] = () => {
          map.setView(position, 17, { animate: false });
          marker.openPopup();
        };
      });
      bounds.extend(position);
    }
    fit.current = () => {
      map.closePopup();
      if (bounds.isValid())
        map.fitBounds(bounds, { padding: [35, 35], maxZoom: 16, animate: false });
    };
    fit.current();
    const resize = new ResizeObserver(() => {
      map.invalidateSize({ animate: false, pan: false });
      fit.current();
    });
    resize.observe(container.current!);
    return () => {
      resize.disconnect();
      map.remove();
      fit.current = () => {};
      focusStop.current = {};
    };
  }, [route, problem, names]);
  return (
    <div className="route-map-wrap">
      <div className="route-map-heading">
        <div className="route-map-stops" role="group" aria-label="Route stop order">
          <span>Stops</span>
          {[
            { badge: 'D', label: 'Driver' },
            ...route.stops.map((_, i) => ({ badge: String(i + 1), label: `Pickup ${i + 1}` })),
            { badge: 'B', label: 'Boathouse' },
          ].map((stop) => (
            <button
              key={stop.badge}
              title={stop.label}
              aria-label={`Show ${stop.label.toLowerCase()} on map`}
              onClick={() => focusStop.current[stop.badge]?.()}
            >
              {stop.badge}
            </button>
          ))}
        </div>
        <button className="text-button" onClick={() => fit.current()}>
          Fit route
        </button>
      </div>
      <div
        ref={container}
        className="route-map"
        role="region"
        aria-label={`Route map for ${names[route.driverId]}`}
      />
      {tileError && (
        <p className="map-message" role="status">
          Map background unavailable. Your route details are below.
        </p>
      )}
      {!route.geometry?.length && (
        <p className="map-message">Stop locations only; the road path is unavailable.</p>
      )}
    </div>
  );
}

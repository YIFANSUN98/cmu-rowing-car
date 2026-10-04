// Public upstream Allegheny discharge, not a measurement at the boathouse.
export const FLOW_STATION = 'USGS-03049500';
export const FLOW_URL =
  'https://api.waterdata.usgs.gov/ogcapi/v1/collections/latest-continuous/items?f=json' +
  `&monitoring_location_id=${FLOW_STATION}&parameter_code=00060&limit=10`;
export const FLOW_SOURCE = 'https://waterdata.usgs.gov/monitoring-location/USGS-03049500/';
export interface FlowObservation {
  observedAt: string;
  cubicFeetPerSecond: number;
}
export function parseFlow(value: unknown): FlowObservation {
  const features = (value as { features?: { properties?: Record<string, unknown> }[] })?.features;
  if (!Array.isArray(features)) throw new Error('Water flow unavailable.');
  const observations = features.flatMap(({ properties: p }) => {
    if (
      !p ||
      p.monitoring_location_id !== FLOW_STATION ||
      p.parameter_code !== '00060' ||
      p.unit_of_measure !== 'ft^3/s' ||
      typeof p.time !== 'string' ||
      !Number.isFinite(Date.parse(p.time)) ||
      !['string', 'number'].includes(typeof p.value) ||
      String(p.value).trim() === ''
    )
      return [];
    const flow = Number(p.value);
    return Number.isFinite(flow) && flow >= 0
      ? [{ observedAt: p.time, cubicFeetPerSecond: flow }]
      : [];
  });
  observations.sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  if (!observations.length) throw new Error('Water flow unavailable.');
  return observations[0];
}

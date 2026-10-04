import fs from 'node:fs/promises';
import path from 'node:path';
import { normalizeSelectedUploads } from '../src/importers/uploadBatch';
import { parseUploads } from '../src/importers/friendly';
import { defaultSettings } from '../src/domain/types';
import { normalize } from '../src/domain/util';
import { ROUTING_BATCH_SIZE } from '../src/travel/tomtom';

// Offline estimate only: no API key, geocoding, route search, or transmission of club data.
const files = process.argv.slice(2);
if (!files.length || files.length > 3)
  throw new Error(
    'Usage: npm run estimate:routing -- members.xlsx attendance.xlsx drivers.xlsx (or one combined workbook)',
  );
const selected = await Promise.all(
  files.map(async (file) => {
    const bytes = await fs.readFile(file);
    return {
      name: path.basename(file),
      size: bytes.length,
      arrayBuffer: async () =>
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    };
  }),
);
const uploads = await normalizeSelectedUploads(selected);
if (!uploads.members || !uploads.attendance || !uploads.availability)
  throw new Error('Select Members, Attendance, and Drivers inputs together.');
const { data, issues } = parseUploads({
  members: uploads.members.text,
  attendance: uploads.attendance.text,
  availability: uploads.availability.text,
});
const allAddresses = new Set<string>();
let missingAddresses = 0;
const days = [...new Set(data.attendance.map((a) => a.date))].sort().map((date) => {
  const missingBefore = missingAddresses;
  const active = data.attendance.filter(
    (a) => a.date === date && a.attending === 'true' && a.transport_mode === 'carpool',
  );
  const locations = new Set<string>();
  const add = (address: string, lat?: number, lng?: number) => {
    if (lat !== undefined && lng !== undefined) locations.add(`geo:${lat},${lng}`);
    else if (address.trim()) {
      locations.add(normalize(address));
      allAddresses.add(normalize(address));
    } else missingAddresses++;
  };
  if (active.length) add(defaultSettings.destination);
  for (const a of active) {
    const m = data.members.find((m) => m.member_id === a.member_id);
    if (a.pickup_override) add(a.pickup_override);
    else if (m) add(m.pickup_address, m.pickup_lat, m.pickup_lng);
    else missingAddresses++;
  }
  const drivers = data.availability.filter(
    (v) =>
      v.date === date && v.available === 'true' && active.some((a) => a.member_id === v.member_id),
  );
  drivers.forEach((d) => {
    if (d.start_address) add(d.start_address);
  });
  const pairs = (count: number) => count * Math.max(0, count - 1);
  const requests = pairs(locations.size);
  const conservativeRequests = pairs(locations.size + missingAddresses - missingBefore);
  return {
    date,
    missingAddresses: missingAddresses - missingBefore,
    conservativeMatrixRouteRequests: conservativeRequests,
    carpoolMembers: active.length,
    eligibleDrivers: drivers.length,
    knownLocations: locations.size,
    routingBatches: Math.ceil(requests / ROUTING_BATCH_SIZE),
    matrixRouteRequests: requests,
    routeRequestsUpperBound: conservativeRequests + drivers.length * 26,
  };
});
console.log(
  JSON.stringify(
    {
      kind: 'Conservative offline request estimate; not a route result or measured bill',
      assumptions:
        'One fresh plan; no retries. Counts include all directed pairs before the website skips pairs unused by any feasible carpool. Each requested directed pair uses one Routing request; batches contain at most 100 pairs. No Matrix API usage. At most 24 pickup orders plus two time-adjusted rechecks per selected car. Upper bound uses every eligible driver. Geocoding may merge locations. Missing addresses make location counts incomplete.',
      parseErrors: issues.filter((i) => i.severity === 'error').length,
      missingAddressOccurrences: missingAddresses,
      geocodingRequests: allAddresses.size,
      matrixUnits: 0,
      routingBatches: days.reduce((s, d) => s + d.routingBatches, 0),
      conservativeMatrixRouteRequests: days.reduce(
        (s, d) => s + d.conservativeMatrixRouteRequests,
        0,
      ),
      matrixRouteRequests: days.reduce((s, d) => s + d.matrixRouteRequests, 0),
      routeRequestsUpperBound: days.reduce((s, d) => s + d.routeRequestsUpperBound, 0),
      days,
    },
    null,
    2,
  ),
);

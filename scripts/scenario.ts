import fs from 'node:fs';
import path from 'node:path';
import { makeDemo, simulateAvailability } from '../src/domain/scenarios';
import { parseDataset, headers } from '../src/domain/validation';
import { writeCsv } from '../src/importers/csv';
const args = process.argv.slice(2),
  arg = (k: string, d = '') => {
    const i = args.indexOf('--' + k);
    return i < 0 ? d : args[i + 1];
  };
const input = arg('input-dir'),
  output = path.resolve(
    arg('output-dir', input ? 'data/private/scenario' : 'exports/private/demo'),
  );
if (input && !output.startsWith(path.resolve('data/private') + path.sep))
  throw new Error('Source-based simulations must stay under data/private/.');
const config = {
  kind: arg('kind', 'broad'),
  seed: Number(arg('seed', '42')),
  candidateIds: arg('candidates').split(',').filter(Boolean),
  cancelledDriver: arg('cancel-driver') || undefined,
};
let data;
if (input) {
  const result = parseDataset({
    members: fs.readFileSync(path.join(input, 'members.csv'), 'utf8'),
    attendance: fs.readFileSync(path.join(input, 'attendance.csv'), 'utf8'),
    availability: fs.readFileSync(path.join(input, 'driver_availability.csv'), 'utf8'),
  });
  if (result.issues.length)
    throw new Error('Correct canonical input validation errors before simulating.');
  data = simulateAvailability(
    result.data,
    config,
    arg('reviewed-observed')
      ? JSON.parse(fs.readFileSync(arg('reviewed-observed'), 'utf8'))
      : undefined,
  );
} else
  data = makeDemo({
    ...config,
    candidateIds: config.candidateIds.length ? config.candidateIds : undefined,
    people: Number(arg('people', '18')),
    driverCount: Number(arg('drivers', '6')),
  });
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
for (const kind of ['members', 'attendance', 'availability'] as const)
  fs.writeFileSync(
    path.join(output, kind === 'availability' ? 'driver_availability.csv' : kind + '.csv'),
    writeCsv(
      headers[kind],
      data[kind].map((r) => ({ ...r })),
    ),
    { mode: 0o600 },
  );
fs.writeFileSync(path.join(output, 'scenario.json'), JSON.stringify(data.scenario, null, 2), {
  mode: 0o600,
});
console.log(`Simulation written to ${output}`);

import fs from 'node:fs';
import os from 'node:os';
import { makeDemo } from '../src/domain/scenarios';
import { defaultSettings } from '../src/domain/types';
import { prepareProblems } from '../src/domain/prepare';
import { MockTravelProvider } from '../src/travel/mock';
import { solveWeek } from '../src/planner/solve';
const results = [];
for (const [people, driverCount] of [
  [30, 8],
  [60, 12],
]) {
  const data = makeDemo({ people, driverCount });
  const settings = { ...defaultSettings, dates: [...new Set(data.attendance.map((a) => a.date))] };
  const started = performance.now();
  const problems = await prepareProblems(data, settings, new MockTravelProvider());
  const plan = solveWeek(problems, settings, data);
  results.push({
    people,
    driverCount,
    days: 5,
    feasible: plan.verified,
    totalMs: performance.now() - started,
    search: plan.search,
    driverDays: plan.days.reduce((s, d) => s + d.routes.length, 0),
    baselineMinutes: plan.baselineDrivingSeconds / 60,
    plannedMinutes: plan.drivingSeconds / 60,
    dayStatuses: plan.days.map((d) => ({
      status: d.status,
      alternatives: d.alternatives,
      budgetExhausted: d.budgetExhausted,
    })),
  });
}
const report = {
  timestamp: new Date().toISOString(),
  runtime: process.version,
  platform: os.platform() + ' ' + os.release(),
  cpu: os.cpus()[0].model,
  logicalCpus: os.cpus().length,
  results,
};
console.log(JSON.stringify(report, null, 2));
fs.writeFileSync('docs/benchmark-node.json', JSON.stringify(report, null, 2) + '\n');

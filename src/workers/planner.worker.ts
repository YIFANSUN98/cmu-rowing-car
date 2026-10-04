import { solveWeek } from '../planner/solve';
import type { Dataset, DayProblem, Settings } from '../domain/types';
self.onmessage = (
  e: MessageEvent<{
    problems: DayProblem[];
    settings: Settings;
    data: Pick<Dataset, 'scenario' | 'availability'>;
  }>,
) => {
  try {
    const { problems, settings, data } = e.data;
    const plan = solveWeek(problems, settings, data, (message, fraction) =>
      self.postMessage({ type: 'progress', message, fraction }),
    );
    self.postMessage({ type: 'result', plan });
  } catch (error) {
    self.postMessage({ type: 'error', message: (error as Error).message });
  }
};

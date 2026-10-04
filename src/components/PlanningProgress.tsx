const stages = ['Travel estimates', 'Car assignments', 'Route checks'];
export type PlanningStage = 0 | 1 | 2;

export function PlanningProgress({
  stage,
  message,
  percent,
}: {
  stage: PlanningStage;
  message: string;
  percent: number;
}) {
  return (
    <div className="planning-progress">
      <div className="planning-progress-heading">
        <b>{percent === 100 ? 'Planning complete' : stages[stage]}</b>
        <span>{percent}%</span>
      </div>
      <div
        className="planning-progress-track"
        role="progressbar"
        aria-label="Planning progress"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${percent}% · Step ${stage + 1} of ${stages.length}: ${stages[stage]}. ${message}`}
      >
        <span style={{ width: `${percent}%` }} />
      </div>
      <p>{message}</p>
    </div>
  );
}

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Dataset, Issue, Settings, Plan, DayProblem } from './domain/types';
import { defaultSettings } from './domain/types';
import { operationalIssues } from './domain/validation';
import type { FileKind } from './domain/validation';
import { locateOperationalIssues } from './importers/issueLocations';
import type { Snapshot } from './exports/plan';
import { prepareProblems } from './domain/prepare';
import { recheckPlan } from './travel/recheck';
import { Results } from './components/Results';
import { InputReview } from './components/InputReview';
import { UploadStatus } from './components/UploadStatus';
import { ClubBrand } from './components/ClubBrand';
import { CurrentConditions } from './components/CurrentConditions';
import { PlanningProgress, type PlanningStage } from './components/PlanningProgress';
import type { UploadChange } from './components/UploadStatus';
import { downloadTemplate } from './importers/template';
import type { TomTomTravelProvider } from './travel/tomtom';
import type { InputSource } from './importers/spreadsheet';
import { inputKinds, inputLabels as labels } from './importers/friendlySchema';
import type { UploadBatch } from './importers/uploadBatch';
import {
  PrivateFiles,
  saveInputs,
  type SourceFiles,
  type RestoredFile,
} from './sharing/PrivateFiles';
import { PublishControls } from './sharing/PublishControls';
import { withComparisonDates } from './domain/comparison';
import { ManualPlanEditor } from './components/ManualPlanEditor';
import {
  createManualDraft,
  draftFromPublication,
  generateManualPlan,
  type ManualDraft,
} from './planner/manual';
import { api } from './sharing/api';
import type { Publication } from './sharing/schema';
const emptyTexts = { members: '', attendance: '', availability: '' };
export default function App() {
  const originalFiles = useRef<SourceFiles>({});
  const [savedFilesVersion, setSavedFilesVersion] = useState(0);
  const [data, setData] = useState<Dataset>();
  const [normalized, setNormalized] = useState<{
    texts: Record<FileKind, string>;
    sources: Partial<Record<FileKind, InputSource>>;
  }>();
  const uploadTask = useRef<{ worker: Worker; timer: ReturnType<typeof setTimeout> } | undefined>(
    undefined,
  );
  const uploaded = useRef<UploadBatch>({});
  const sources = useRef<Partial<Record<FileKind, InputSource>>>({});
  const [reading, setReading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [texts, setTexts] = useState(emptyTexts);
  const [files, setFiles] = useState<Record<FileKind, string>>({ ...emptyTexts });
  const [uploadChanges, setUploadChanges] = useState<Partial<Record<FileKind, UploadChange>>>({});
  const [issues, setIssues] = useState<Issue[]>([]);
  const [settings, setSettings] = useState<Settings>({
    ...defaultSettings,
    mode: 'tomtom',
    uberFallback: true,
    destinationConfirmed: true,
  });
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [manual, setManual] = useState<{ data: Dataset; draft: ManualDraft }>();
  const [loadingPublished, setLoadingPublished] = useState(false);
  const [revision, setRevision] = useState(0);
  const [planningStage, setPlanningStage] = useState<PlanningStage>(0);
  const [planningPercent, setPlanningPercent] = useState(0);
  const currentRevision = useRef(0);
  const [busy, setBusy] = useState(false),
    [parsing, setParsing] = useState(false),
    [progress, setProgress] = useState(''),
    [error, setError] = useState('');
  const worker = useRef<Worker | null>(null),
    parser = useRef<Worker | null>(null),
    controller = useRef<AbortController | null>(null),
    providerRef = useRef<TomTomTravelProvider | null>(null);
  const activeReject = useRef<((e: Error) => void) | null>(null);
  const stop = () => {
    controller.current?.abort();
    worker.current?.terminate();
    worker.current = null;
    activeReject.current?.(new DOMException('Calculation cancelled.', 'AbortError'));
    activeReject.current = null;
    setBusy(false);
  };
  const invalidate = () => {
    stop();
    setManual(undefined);
    currentRevision.current++;
    setRevision(currentRevision.current);
    setError('');
  };
  const change = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    invalidate();
    setSettings((s) => ({ ...s, [key]: value }));
  };
  useEffect(
    () => () => {
      worker.current?.terminate();
      parser.current?.terminate();
      controller.current?.abort();
      if (uploadTask.current) {
        uploadTask.current.worker.terminate();
        clearTimeout(uploadTask.current.timer);
      }
    },
    [],
  );
  const setInputs = (next: Dataset) => {
    setNormalized(undefined);
    setData(next);
    setIssues([]);
    const dates = [...new Set(next.attendance.map((a) => a.date))].sort().slice(0, 7);
    setSettings((s) => ({ ...s, dates }));
  };
  const parseTexts = (next: Record<FileKind, string>) => {
    if (Object.values(next).every(Boolean)) {
      setParsing(true);
      const w = new Worker(new URL('./workers/parse.worker.ts', import.meta.url), {
        type: 'module',
      });
      parser.current = w;
      w.onmessage = (e) => {
        w.terminate();
        if (parser.current !== w) return;
        parser.current = null;
        setParsing(false);
        if (e.data.error) {
          setError(e.data.error);
          return;
        }
        setInputs(e.data.data);
        setNormalized({ texts: e.data.canonicalTexts, sources: e.data.canonicalSources });
        setIssues(e.data.issues);
      };
      w.onerror = () => {
        w.terminate();
        if (parser.current === w) {
          parser.current = null;
          setParsing(false);
          setError('Could not parse inputs. Review the uploaded files.');
        }
      };
      w.postMessage({ texts: next, sources: sources.current });
    }
  };
  const upload = (selected: File[], restored?: RestoredFile[]) => {
    if (!selected.length) return;
    invalidate();
    setUploadChanges({});
    setNormalized(undefined);
    parser.current?.terminate();
    parser.current = null;
    setParsing(false);
    setData(undefined);
    setIssues([]);
    if (uploadTask.current) {
      uploadTask.current.worker.terminate();
      clearTimeout(uploadTask.current.timer);
      uploadTask.current = undefined;
    }
    setReading(false);
    if (selected.length > 3) {
      setError('Select up to three .xlsx files from the same week.');
      return;
    }
    if (selected.some((file) => file.size > 5 * 1024 * 1024 || !/\.xlsx$/i.test(file.name))) {
      setError('Choose .xlsx files smaller than 5 MB each.');
      return;
    }
    setReading(true);
    const w = new Worker(new URL('./workers/upload.worker.ts', import.meta.url), {
      type: 'module',
    });
    const finish = () => {
      if (uploadTask.current?.worker !== w) return false;
      w.terminate();
      clearTimeout(uploadTask.current.timer);
      uploadTask.current = undefined;
      setReading(false);
      return true;
    };
    const timer = setTimeout(() => {
      if (finish())
        setError('Reading timed out. Download fresh, unprotected .xlsx files and try again.');
    }, 30000);
    uploadTask.current = { worker: w, timer };
    w.onmessage = (event: MessageEvent<{ inputs?: UploadBatch; error?: string }>) => {
      if (!finish()) return;
      if (event.data.error || !event.data.inputs) {
        setError(event.data.error ?? 'Could not read the selected files.');
        return;
      }
      // Apply the selection together: duplicate or damaged files never replace just part of a week.
      const changes: Partial<Record<FileKind, UploadChange>> = {};
      for (const kind of inputKinds) {
        const incoming = event.data.inputs[kind];
        if (!incoming) continue;
        const previous = uploaded.current[kind];
        changes[kind] = !previous
          ? 'added'
          : previous.text === incoming.text
            ? 'unchanged'
            : 'updated';
      }
      const merged = { ...uploaded.current, ...event.data.inputs };
      for (const kind of inputKinds) {
        const incoming = event.data.inputs[kind];
        if (!incoming) continue;
        const file =
          restored?.find((entry) => entry.kinds.includes(kind))?.file ??
          selected.find((file) => file.name === incoming.fileName);
        if (file) originalFiles.current[kind] = file;
      }
      uploaded.current = merged;
      const next = { ...emptyTexts },
        names = { ...emptyTexts };
      const nextSources: Partial<Record<FileKind, InputSource>> = {};
      for (const kind of inputKinds) {
        const input = merged[kind];
        if (!input) continue;
        next[kind] = input.text;
        names[kind] = input.fileName;
        nextSources[kind] = {
          label: input.fileName + (input.sheetName ? ` · ${input.sheetName}` : ''),
          rowMap: input.rowMap,
          gridDateColumns: input.gridDateColumns,
        };
      }
      sources.current = nextSources;
      setTexts(next);
      setFiles(names);
      setUploadChanges(changes);
      parseTexts(next);
    };
    w.onerror = () => {
      if (finish())
        setError('Could not read the selected files. Download fresh copies and try again.');
    };
    w.postMessage({ files: selected, restored });
  };
  const planSettings = useMemo(() => withComparisonDates(settings), [settings]);
  const operational = useMemo(
    () =>
      data
        ? locateOperationalIssues(
            operationalIssues(data, planSettings),
            normalized?.texts ?? texts,
            normalized?.sources ?? sources.current,
          )
        : [],
    [data, planSettings, texts, normalized],
  );
  const allIssues = [...issues, ...operational];
  const planningIssues = allIssues.filter((issue) => issue.file === 'planning' && !issue.inputKind);
  const sheetIssues = allIssues.filter((issue) => !planningIssues.includes(issue));
  const blocking = allIssues.some((i) => i.severity === 'error');
  const plan = async (input = data, config = withComparisonDates(settings)) => {
    if (!input || issues.some((i) => i.severity === 'error')) return;
    const errors = operationalIssues(input, config).filter((i) => i.severity === 'error');
    if (errors.length) {
      setError(errors[0].message);
      return;
    }
    stop();
    // A failed refresh must not leave the preceding plan looking freshly verified.
    currentRevision.current++;
    setRevision(currentRevision.current);
    setError('');
    setBusy(true);
    setPlanningStage(0);
    setPlanningPercent(0);
    setProgress('Preparing travel estimates…');
    const token = currentRevision.current;
    const abort = new AbortController();
    controller.current = abort;
    const report = (stage: PlanningStage, message: string, fraction: number) => {
      if (token !== currentRevision.current || abort.signal.aborted) return;
      const start = [0, 65, 75][stage],
        span = [65, 10, 24][stage];
      setPlanningStage(stage);
      setProgress(message);
      setPlanningPercent((previous) =>
        Math.max(previous, Math.floor(start + span * Math.max(0, Math.min(1, fraction)))),
      );
    };
    try {
      if (!providerRef.current) {
        const { TomTomTravelProvider } = await import('./travel/tomtom');
        providerRef.current = new TomTomTravelProvider(import.meta.env.VITE_TOMTOM_API_KEY ?? '');
      }
      const provider = providerRef.current;
      const usageBefore = provider.usage();
      // Keep the upload running throughout solving and route verification. Waiting
      // here makes a slow storage request block otherwise-ready travel estimates.
      const savedInputs = saveInputs({ ...originalFiles.current }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      const problems = await prepareProblems(
        input,
        config,
        provider,
        abort.signal,
        (message, fraction) => report(0, message, fraction),
      );
      if (abort.signal.aborted || token !== currentRevision.current) return;
      report(1, 'Finding car assignments for your crew…', 0);
      const result = await new Promise<Plan>((resolve, reject) => {
        const w = new Worker(new URL('./workers/planner.worker.ts', import.meta.url), {
          type: 'module',
        });
        worker.current = w;
        activeReject.current = reject;
        w.onmessage = (e) => {
          if (abort.signal.aborted || token !== currentRevision.current) return;
          if (e.data.type === 'progress') report(1, e.data.message, e.data.fraction);
          else {
            activeReject.current = null;
            w.terminate();
            worker.current = null;
            if (e.data.type === 'error') reject(new Error(e.data.message));
            else resolve(e.data.plan);
          }
        };
        w.onerror = () => {
          activeReject.current = null;
          w.terminate();
          reject(new Error('Planner worker failed.'));
        };
        w.postMessage({
          problems,
          settings: config,
          data: { scenario: input.scenario, availability: input.availability },
        });
      });
      if (abort.signal.aborted || token !== currentRevision.current) return;
      report(2, 'Checking pickup order and arrival times…', 0);
      const verified = await recheckPlan(
        result,
        problems,
        provider,
        abort.signal,
        (message, fraction) => report(2, message, fraction),
      );
      const saved = await savedInputs;
      if (!saved.ok) throw saved.error;
      if (token === currentRevision.current && !abort.signal.aborted) {
        setSavedFilesVersion((n) => n + 1);
        verified.travelUsage = provider.usageSince(usageBefore);
        setSnapshot({ plan: verified, problems, data: input, revision: token });
        setProgress('Planning complete.');
        setPlanningPercent(100);
        setTimeout(
          () =>
            document
              .getElementById('results')
              ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          50,
        );
      }
    } catch (e) {
      abort.abort();
      if (token === currentRevision.current && controller.current === abort)
        setError(
          (e as Error).name === 'AbortError' ? 'Calculation cancelled.' : (e as Error).message,
        );
    } finally {
      if (controller.current === abort) setBusy(false);
    }
  };
  const dates = [...new Set(data?.attendance.map((a) => a.date) ?? [])].sort();
  const stale = Boolean(snapshot && snapshot.revision !== revision);
  const openManual = () => {
    if (!data) return;
    const current = !stale ? snapshot : undefined;
    const input = current?.data ?? data;
    setManual({ data: input, draft: createManualDraft(input, settings, current) });
    setError('');
    setTimeout(
      () =>
        document
          .getElementById('manual-editor')
          ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
      50,
    );
  };
  const editPublished = async () => {
    if (!data) return;
    const token = currentRevision.current;
    setLoadingPublished(true);
    setError('');
    try {
      const publication = await api<Publication | null>('plan');
      if (token !== currentRevision.current) return;
      if (!publication)
        throw new Error(
          'There is no published plan yet. Plan routes or arrange them manually first.',
        );
      const draft = draftFromPublication(data, settings, publication);
      setManual({ data, draft });
      setTimeout(
        () =>
          document
            .getElementById('manual-editor')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        50,
      );
    } catch (e) {
      if (token === currentRevision.current) setError((e as Error).message);
    } finally {
      setLoadingPublished(false);
    }
  };
  const generateManual = async () => {
    if (!manual) return;
    stop();
    setBusy(true);
    setError('');
    setPlanningPercent(0);
    setPlanningStage(0);
    setProgress('Preparing your manual arrangements…');
    const token = currentRevision.current;
    const abort = new AbortController();
    controller.current = abort;
    try {
      if (!providerRef.current) {
        const { TomTomTravelProvider } = await import('./travel/tomtom');
        providerRef.current = new TomTomTravelProvider(import.meta.env.VITE_TOMTOM_API_KEY ?? '');
      }
      const provider = providerRef.current,
        before = provider.usage();
      const [generated] = await Promise.all([
        generateManualPlan(
          manual.data,
          manual.draft,
          withComparisonDates({
            ...settings,
            dates: manual.draft.days.map((d) => d.date),
            deadline: manual.draft.deadline,
          }),
          provider,
          abort.signal,
          (message, fraction) => {
            if (abort.signal.aborted || token !== currentRevision.current) return;
            setProgress(message);
            setPlanningStage(fraction < 0.35 ? 0 : fraction < 0.65 ? 1 : 2);
            setPlanningPercent((previous) => Math.max(previous, Math.floor(fraction * 100)));
          },
        ),
        saveInputs({ ...originalFiles.current }),
      ]);
      if (abort.signal.aborted || token !== currentRevision.current) return;
      setSavedFilesVersion((n) => n + 1);
      currentRevision.current++;
      setRevision(currentRevision.current);
      generated.plan.travelUsage = provider.usageSince(before);
      setSnapshot({ ...generated, revision: currentRevision.current });
      setSettings((s) => ({
        ...s,
        dates: generated.plan.settings.dates,
        deadline: generated.plan.settings.deadline,
      }));
      setManual(undefined);
      setProgress('Manual plan ready. Review, then publish or download.');
      setPlanningPercent(100);
      setTimeout(
        () =>
          document
            .getElementById('results')
            ?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        50,
      );
    } catch (e) {
      if (
        controller.current === abort &&
        !abort.signal.aborted &&
        token === currentRevision.current
      )
        setError((e as Error).message);
      abort.abort();
    } finally {
      if (controller.current === abort) setBusy(false);
    }
  };
  const template = async (kind: FileKind) => {
    try {
      await downloadTemplate(kind, settings.dates);
    } catch {
      setError('Could not create the Excel template. Please try again.');
    }
  };
  return (
    <>
      <header className="site-header">
        <ClubBrand />
        <div className="header-intro">
          <h1>
            Less coordinating. <em>More rowing.</em>
          </h1>
          <p>Plan the week, share the driving, and get your crew to the water on time.</p>
        </div>
      </header>
      <main>
        <section className="hero">
          <div className="hero-settings">
            <span className="eyebrow">YOUR NEXT LAUNCH</span>
            <h2>Plan the arrival.</h2>
            <label className="field">
              Boathouse destination
              <input
                value={settings.destination}
                onChange={(e) => change('destination', e.target.value)}
              />
            </label>
            <label className="field arrival-field">
              Arrival deadline
              <input
                type="time"
                value={settings.deadline}
                onChange={(e) => change('deadline', e.target.value)}
              />
            </label>
            <p className="arrival-hint">All times Eastern Time.</p>
            {planningIssues.length > 0 && (
              <div className="notice warning planning-issues" role="alert">
                {planningIssues.map((issue, i) => (
                  <p key={i}>{issue.message}</p>
                ))}
              </div>
            )}
          </div>
          <div className="hero-art" aria-label="Illustration of a crew rowing toward sunrise">
            <div className="sun" />
            <div className="water-lines" />
            <CurrentConditions />
            <svg viewBox="0 0 400 220" className="boat" aria-hidden="true">
              <path d="M30 130 Q210 153 375 121 Q340 172 70 160Z" fill="#a51c30" />
              <path d="M55 130 L340 123" stroke="#f9f1df" strokeWidth="5" />
              {[110, 170, 230, 290].map((x, i) => (
                <g key={x}>
                  <path d={`M${x} 130 l-50 50 m50-50 l45-45`} stroke="#efe5ce" strokeWidth="5" />
                  <circle cx={x} cy={109 - i * 2} r="8" fill="#163d39" />
                  <path
                    d={`M${x - 5} ${118 - i * 2} l-5 12 20-1`}
                    fill="none"
                    stroke="#163d39"
                    strokeWidth="7"
                  />
                </g>
              ))}
            </svg>
            <span className="art-caption">Everyone to the water.</span>
          </div>
        </section>
        <div className="principles">
          <span>
            <b>01</b> Bring your crew’s inputs
          </span>
          <span>
            <b>02</b> Balance the driving
          </span>
          <span>
            <b>03</b> Give every rider a plan
          </span>
        </div>
        <section id="workspace" className="workspace">
          <div className="section-heading">
            <div>
              <span className="eyebrow">01 / SET UP YOUR CREW</span>
              <h2>One week. All aboard.</h2>
            </div>
          </div>
          <div
            className={'upload-panel ' + (dragging ? 'dragging' : '')}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              upload(Array.from(e.dataTransfer.files));
            }}
          >
            <label className="file-select multi-file-select">
              <input
                type="file"
                multiple
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                aria-label="Upload Excel files"
                onChange={(e) => {
                  upload(Array.from(e.target.files ?? []));
                  e.target.value = '';
                }}
              />
              <strong>{reading ? 'Reading your files…' : 'Choose Excel files'}</strong>
              <span>Select members, attendance, and drivers together, or drop them here.</span>
            </label>
            <UploadStatus files={files} changes={uploadChanges} />
            {Object.values(files).some(Boolean) &&
              inputKinds.some((kind) => !files[kind]) &&
              !reading && (
                <p role="status">
                  Still needed:{' '}
                  {inputKinds
                    .filter((kind) => !files[kind])
                    .map((kind) => labels[kind])
                    .join(', ')}
                  .
                </p>
              )}
            <details className="upload-templates">
              <summary>Excel templates</summary>
              <div className="button-row">
                {inputKinds.map((kind) => (
                  <button key={kind} className="text-button" onClick={() => void template(kind)}>
                    {labels[kind]} template ↓
                  </button>
                ))}
              </div>
            </details>
          </div>
          {(parsing || reading) && <p role="status">Reading and validating your files…</p>}
          <PrivateFiles
            sources={originalFiles.current}
            changed={savedFilesVersion}
            disabled={busy || reading || parsing}
            onRestore={(files) =>
              upload(
                files.map((entry) => entry.file),
                files,
              )
            }
          />
        </section>
        <section className="planning-settings">
          <div className="section-heading">
            <div>
              <span className="eyebrow">02 / PLAN THE EARLY START</span>
              <h2>Good mornings start here.</h2>
            </div>
            <span className="timezone">America/New_York</span>
          </div>
          <fieldset className="date-picker">
            <legend>Practice dates</legend>
            {dates.length ? (
              dates.map((date) => (
                <label key={date}>
                  <input
                    type="checkbox"
                    checked={settings.dates.includes(date)}
                    onChange={(e) =>
                      change(
                        'dates',
                        e.target.checked
                          ? [...settings.dates, date].sort()
                          : settings.dates.filter((d) => d !== date),
                      )
                    }
                  />
                  <span>{date}</span>
                </label>
              ))
            ) : (
              <p>Dates appear when you load attendance.</p>
            )}
          </fieldset>
          <InputReview
            issues={sheetIssues}
            loaded={Boolean(data && !parsing && !reading && issues.length === 0)}
          />
          {planSettings.comparisonDates && (
            <div className="notice" role="status">
              <b>Historical comparison</b>
              <p>
                Attendance dates are preserved. Estimates use matching weekdays on{' '}
                {Object.values(planSettings.comparisonDates).sort().join(', ')}; these are not
                historical traffic measurements. Comparisons cannot be published as a live schedule.
              </p>
            </div>
          )}
          {error && !manual && (
            <div role="alert" className="notice warning">
              {error}
            </div>
          )}
          <div className="plan-bar">
            <div className="plan-status">
              {busy || (snapshot && !stale && !manual) ? (
                <PlanningProgress
                  stage={planningStage}
                  message={progress}
                  percent={planningPercent}
                />
              ) : (
                <b>
                  {data
                    ? `${settings.dates.length} practice days. One shared plan.`
                    : 'Upload your three .xlsx files.'}
                </b>
              )}
            </div>
            <div className="button-row">
              {!busy && !manual && (
                <button
                  disabled={
                    !data ||
                    issues.some((i) => i.severity === 'error') ||
                    parsing ||
                    reading ||
                    loadingPublished
                  }
                  onClick={() => void editPublished()}
                >
                  {loadingPublished ? 'Loading published routes…' : 'Edit published routes'}
                </button>
              )}
              {!busy && !manual && (
                <button
                  disabled={
                    !data ||
                    issues.some((i) => i.severity === 'error') ||
                    !settings.dates.length ||
                    parsing ||
                    reading ||
                    loadingPublished
                  }
                  onClick={openManual}
                >
                  {snapshot && !stale ? 'Edit routes' : 'Arrange manually'}
                </button>
              )}
              {busy ? (
                <button
                  onClick={() => {
                    stop();
                    setProgress('Cancelled.');
                  }}
                >
                  Cancel
                </button>
              ) : (
                <button
                  className="primary"
                  disabled={
                    !data || blocking || parsing || reading || Boolean(manual) || loadingPublished
                  }
                  onClick={() => void plan()}
                >
                  {planSettings.comparisonDates
                    ? snapshot
                      ? 'Recompare week'
                      : 'Compare past week'
                    : snapshot
                      ? snapshot.plan.manuallyEdited
                        ? 'Replan from files'
                        : 'Replan week'
                      : 'Plan week'}{' '}
                  <span aria-hidden="true">→</span>
                </button>
              )}
            </div>
          </div>
          <div className="sr-only" role="status" aria-live="polite">
            {progress}
          </div>
        </section>
        {manual && (
          <ManualPlanEditor
            data={manual.data}
            draft={manual.draft}
            busy={busy}
            generationError={error}
            onChange={(draft) => {
              setManual({ ...manual, draft });
              setError('');
            }}
            onGenerate={() => void generateManual()}
            onCancel={() => {
              stop();
              setManual(undefined);
              setError('');
              setPlanningPercent(snapshot && !stale ? 100 : 0);
              setProgress(snapshot && !stale ? 'Previous plan kept.' : 'Manual edits cancelled.');
            }}
          />
        )}
        <PublishControls
          snapshot={snapshot}
          stale={stale || busy || reading || parsing || Boolean(manual)}
        />
        {snapshot ? (
          <Results
            key={snapshot.revision}
            snapshot={snapshot}
            stale={stale || busy || Boolean(manual)}
          />
        ) : (
          <section className="empty-plan">
            <svg className="empty-boat" viewBox="0 0 96 64" fill="none" aria-hidden="true">
              <path d="M12 34h72c-8 12-19 15-36 15S20 46 12 34Z" fill="currentColor" />
              <g stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <path d="m33 23 13 11 18 19M48 24l-8 10h15" />
                <path d="M17 57c5 3 10 3 15 0s10-3 15 0 10 3 15 0 10-3 15 0" />
              </g>
              <circle cx="50" cy="17" r="5" fill="currentColor" />
            </svg>
            <h3>Your next launch, organized.</h3>
            <p>Your weekly overview and driver pickup instructions will appear here.</p>
          </section>
        )}
      </main>
    </>
  );
}

import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import type {
  Recording,
  RecordingParameter,
  ReplayErrorStrategy,
  RecordingUpdateInput,
  ReplayOptions,
  ReplayRun,
} from '@accomplish_ai/agent-core';
import {
  ArrowCounterClockwise,
  ArrowLeft,
  Plus,
  SpinnerGap,
  Stop,
  Trash,
} from '@phosphor-icons/react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Textarea } from '@/components/ui/textarea';
import { getAccomplish } from '../lib/accomplish';
import { useRecordingStore } from '../stores/recordingStore';

const RECORDING_PARAMETER_TYPES = ['text', 'url', 'email', 'number', 'password', 'file-path'];

function isRecordingParameterType(value: string): value is RecordingParameter['type'] {
  return RECORDING_PARAMETER_TYPES.includes(value);
}

function formatDate(value: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(value));
  } catch {
    return value;
  }
}

function formatDuration(durationMs: number): string {
  const seconds = Math.max(Math.round(durationMs / 1000), 0);
  if (seconds < 60) {
    return `${seconds}s`;
  }

  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return `${minutes}m ${remainder}s`;
}

function createParameterId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `param-${Date.now()}`;
}

function buildUploadParameterId(stepId: string): string {
  return `upload-${stepId}`;
}

function buildUploadParameterName(stepIndex: number): string {
  return `upload_step_${stepIndex + 1}`;
}

function buildInitialParameterDrafts(recording: Recording): RecordingParameter[] {
  const drafts = [...recording.parameters];
  for (const step of recording.steps) {
    if (step.action.type !== 'upload') {
      continue;
    }

    const expectedId = buildUploadParameterId(step.id);
    const expectedName = buildUploadParameterName(step.index);
    const exists = drafts.some(
      (parameter) => parameter.id === expectedId || parameter.name === expectedName,
    );
    if (exists) {
      continue;
    }

    drafts.push({
      id: expectedId,
      name: expectedName,
      description:
        step.action.fileNames.length > 0
          ? `Absolute path for upload step ${step.index + 1} (${step.action.fileNames.join(', ')})`
          : `Absolute path for upload step ${step.index + 1}`,
      defaultValue: '',
      type: 'file-path',
    });
  }

  return drafts;
}

function buildInitialParameterValues(parameters: RecordingParameter[]): Record<string, string> {
  return Object.fromEntries(parameters.map((parameter) => [parameter.id, parameter.defaultValue]));
}

interface RecordingDetailContentProps {
  activeStepIndex: number;
  errorStrategy: ReplayErrorStrategy;
  maxRetries: string;
  recording: Recording;
  recordingId: string;
  replayHistory: ReplayRun[];
  replayRun: ReplayRun | null;
  setErrorStrategy: (strategy: ReplayErrorStrategy) => void;
  setMaxRetries: (value: string) => void;
  setSpeed: (value: string) => void;
  setStepTimeoutMs: (value: string) => void;
  speed: string;
  startReplay: (recordingId: string, options?: Partial<ReplayOptions>) => Promise<ReplayRun>;
  stepTimeoutMs: string;
  updateRecording: (recordingId: string, input: RecordingUpdateInput) => Promise<Recording>;
}

function RecordingDetailContent({
  activeStepIndex,
  errorStrategy,
  maxRetries,
  recording,
  recordingId,
  replayHistory,
  replayRun,
  setErrorStrategy,
  setMaxRetries,
  setSpeed,
  setStepTimeoutMs,
  speed,
  startReplay,
  stepTimeoutMs,
  updateRecording,
}: RecordingDetailContentProps) {
  const initialParameterDrafts = useMemo(() => buildInitialParameterDrafts(recording), [recording]);
  const [recordingName, setRecordingName] = useState(recording.name);
  const [recordingDescription, setRecordingDescription] = useState(recording.description ?? '');
  const [recordingTags, setRecordingTags] = useState(recording.tags.join(', '));
  const [parameterDrafts, setParameterDrafts] =
    useState<RecordingParameter[]>(initialParameterDrafts);
  const [parameterValues, setParameterValues] = useState<Record<string, string>>(() =>
    buildInitialParameterValues(initialParameterDrafts),
  );

  const replayParameters = useMemo(() => {
    return Object.fromEntries(
      parameterDrafts.map((parameter) => [
        parameter.id,
        parameterValues[parameter.id] ?? parameter.defaultValue,
      ]),
    );
  }, [parameterDrafts, parameterValues]);

  const handleParameterDraftChange = (
    parameterId: string,
    key: keyof RecordingParameter,
    value: string,
  ) => {
    setParameterDrafts((current) =>
      current.map((parameter) =>
        parameter.id === parameterId ? { ...parameter, [key]: value } : parameter,
      ),
    );
  };

  const handleAddParameter = () => {
    const parameter: RecordingParameter = {
      id: createParameterId(),
      name: `param_${parameterDrafts.length + 1}`,
      description: '',
      defaultValue: '',
      type: 'text',
    };
    setParameterDrafts((current) => [...current, parameter]);
    setParameterValues((current) => ({ ...current, [parameter.id]: '' }));
  };

  const handleRemoveParameter = (parameterId: string) => {
    setParameterDrafts((current) => current.filter((parameter) => parameter.id !== parameterId));
    setParameterValues((current) => {
      const next = { ...current };
      delete next[parameterId];
      return next;
    });
  };

  const handleSaveRecording = async () => {
    const normalizedParameters = parameterDrafts.map((parameter) => ({
      ...parameter,
      name: parameter.name.trim(),
      description: parameter.description.trim(),
    }));

    await updateRecording(recordingId, {
      name: recordingName.trim() || recording.name,
      description: recordingDescription.trim(),
      tags: recordingTags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      parameters: normalizedParameters,
    });
  };

  return (
    <div className="grid min-h-0 flex-1 gap-6 lg:overflow-hidden lg:grid-cols-[320px_minmax(0,1fr)]">
      <div className="space-y-4 lg:min-h-0 lg:overflow-y-auto lg:pr-1">
        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-foreground">Summary</h2>
            <Badge variant="secondary">{recording.status}</Badge>
          </div>
          <div className="space-y-2 text-sm text-muted-foreground">
            <div>{recording.metadata.stepCount} recorded steps</div>
            <div>{formatDuration(recording.metadata.durationMs)}</div>
            <div>{formatDate(recording.updatedAt)}</div>
            <div className="truncate">{recording.metadata.startUrl}</div>
            <div>
              {recording.steps.filter((step) => Boolean(step.screenshot)).length} screenshot
              keyframes
            </div>
          </div>
        </Card>

        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-foreground">Recording Metadata</h2>
            <Button variant="outline" size="sm" onClick={() => void handleSaveRecording()}>
              Save
            </Button>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Name
              </label>
              <Input
                value={recordingName}
                onChange={(event) => setRecordingName(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Description
              </label>
              <Textarea
                value={recordingDescription}
                onChange={(event) => setRecordingDescription(event.target.value)}
                rows={4}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Tags
              </label>
              <Input
                value={recordingTags}
                onChange={(event) => setRecordingTags(event.target.value)}
                placeholder="checkout, qa, login"
              />
            </div>
          </div>
        </Card>

        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 className="text-sm font-medium text-foreground">Replay</h2>
            {replayRun && (
              <Badge variant={replayRun.status === 'failed' ? 'destructive' : 'secondary'}>
                {replayRun.status}
              </Badge>
            )}
          </div>

          {replayRun ? (
            <div className="space-y-3 text-sm text-muted-foreground">
              <div>
                Step {Math.min(replayRun.currentStepIndex + 1, replayRun.totalSteps)} of{' '}
                {replayRun.totalSteps}
              </div>
              <div>{formatDate(replayRun.updatedAt)}</div>
              {replayRun.currentStep && (
                <div>
                  Current:{' '}
                  <span className="text-foreground">{replayRun.currentStep.actionType}</span>
                </div>
              )}
              {replayRun.error && <div className="text-destructive">{replayRun.error}</div>}
            </div>
          ) : (
            <div className="text-sm text-muted-foreground">
              No replay has been started for this recording.
            </div>
          )}
        </Card>

        <Card className="space-y-4 p-5">
          <div>
            <h2 className="text-sm font-medium text-foreground">Replay History</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Completed and failed runs stay attached to this recording after refresh.
            </p>
          </div>

          {replayHistory.length === 0 ? (
            <div className="text-sm text-muted-foreground">No replay runs yet.</div>
          ) : (
            <div className="space-y-3">
              {replayHistory.slice(0, 6).map((run) => (
                <div
                  key={run.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-border p-3"
                >
                  <div className="min-w-0 space-y-1">
                    <div className="text-sm font-medium text-foreground">
                      {run.status === 'paused' || run.status === 'running'
                        ? 'Active replay'
                        : 'Replay run'}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {Math.min(run.currentStepIndex, run.totalSteps)} / {run.totalSteps} steps
                    </div>
                    <div className="text-xs text-muted-foreground">{formatDate(run.updatedAt)}</div>
                    {run.error && <div className="text-xs text-destructive">{run.error}</div>}
                  </div>
                  <Badge variant={run.status === 'failed' ? 'destructive' : 'secondary'}>
                    {run.status}
                  </Badge>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="space-y-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium text-foreground">Parameters</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                Define variables once, then supply replay-specific values below.
              </p>
            </div>
            <Button variant="outline" size="sm" className="gap-2" onClick={handleAddParameter}>
              <Plus className="h-4 w-4" />
              Add
            </Button>
          </div>

          {parameterDrafts.length === 0 ? (
            <div className="text-sm text-muted-foreground">
              No parameters yet. Add one to make URLs or form values reusable across runs.
            </div>
          ) : (
            <div className="space-y-4">
              {parameterDrafts.map((parameter) => (
                <div key={parameter.id} className="space-y-3 rounded-lg border border-border p-4">
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-medium text-foreground">{parameter.name}</div>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="gap-2 text-destructive hover:text-destructive"
                      onClick={() => handleRemoveParameter(parameter.id)}
                    >
                      <Trash className="h-4 w-4" />
                      Remove
                    </Button>
                  </div>

                  <div className="grid gap-3">
                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Parameter Key
                      </label>
                      <Input
                        value={parameter.name}
                        onChange={(event) =>
                          handleParameterDraftChange(parameter.id, 'name', event.target.value)
                        }
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Description
                      </label>
                      <Input
                        value={parameter.description}
                        onChange={(event) =>
                          handleParameterDraftChange(
                            parameter.id,
                            'description',
                            event.target.value,
                          )
                        }
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Default Value
                      </label>
                      <Input
                        value={parameter.defaultValue}
                        onChange={(event) => {
                          handleParameterDraftChange(
                            parameter.id,
                            'defaultValue',
                            event.target.value,
                          );
                          setParameterValues((current) => ({
                            ...current,
                            [parameter.id]:
                              current[parameter.id] === undefined
                                ? event.target.value
                                : current[parameter.id],
                          }));
                        }}
                      />
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Type
                      </label>
                      <select
                        className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                        value={parameter.type}
                        onChange={(event) => {
                          if (isRecordingParameterType(event.target.value)) {
                            handleParameterDraftChange(parameter.id, 'type', event.target.value);
                          }
                        }}
                      >
                        <option value="text">Text</option>
                        <option value="url">URL</option>
                        <option value="email">Email</option>
                        <option value="number">Number</option>
                        <option value="password">Password</option>
                        <option value="file-path">File Path</option>
                      </select>
                    </div>

                    <div className="space-y-1.5">
                      <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        Replay Value
                      </label>
                      <Input
                        type={parameter.type === 'password' ? 'password' : 'text'}
                        value={parameterValues[parameter.id] ?? ''}
                        onChange={(event) =>
                          setParameterValues((current) => ({
                            ...current,
                            [parameter.id]: event.target.value,
                          }))
                        }
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card className="space-y-4 p-5">
          <div>
            <h2 className="text-sm font-medium text-foreground">Replay Options</h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Tune how fast the runner moves. Use `0` to enter step-by-step replay mode.
            </p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Speed Multiplier
              </label>
              <Input value={speed} onChange={(event) => setSpeed(event.target.value)} />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Step Timeout (ms)
              </label>
              <Input
                value={stepTimeoutMs}
                onChange={(event) => setStepTimeoutMs(event.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                On Step Error
              </label>
              <div className="flex gap-2">
                <Button
                  variant={errorStrategy === 'abort' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setErrorStrategy('abort')}
                >
                  Abort
                </Button>
                <Button
                  variant={errorStrategy === 'skip' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setErrorStrategy('skip')}
                >
                  Skip
                </Button>
                <Button
                  variant={errorStrategy === 'retry' ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => setErrorStrategy('retry')}
                >
                  Retry
                </Button>
              </div>
            </div>

            {errorStrategy === 'retry' && (
              <div className="space-y-1.5">
                <label className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Retry Attempts
                </label>
                <Input value={maxRetries} onChange={(event) => setMaxRetries(event.target.value)} />
              </div>
            )}
          </div>

          <Button
            className="gap-2"
            disabled={recording.steps.length === 0}
            onClick={() => {
              const parsedSpeed = Number.parseFloat(speed);
              void startReplay(recordingId, {
                speed: Number.isFinite(parsedSpeed) && parsedSpeed >= 0 ? parsedSpeed : 1,
                stepTimeoutMs: Math.max(Number.parseInt(stepTimeoutMs, 10) || 15000, 1000),
                errorStrategy,
                maxRetries: Math.max(Number.parseInt(maxRetries, 10) || 0, 0),
                parameters: replayParameters,
              });
            }}
          >
            <ArrowCounterClockwise className="h-4 w-4" />
            Replay Recording
          </Button>
        </Card>
      </div>

      <Card className="min-h-0 overflow-hidden p-0">
        <ScrollArea className="h-full min-h-0">
          <div className="flex flex-col divide-y">
            {recording.steps.map((step) => {
              const isActive = step.index === activeStepIndex;
              return (
                <div
                  key={step.id}
                  className={`flex gap-4 px-5 py-4 ${isActive ? 'bg-primary/5' : 'bg-transparent'}`}
                >
                  <div className="flex w-10 shrink-0 items-start justify-center">
                    {isActive ? (
                      <SpinnerGap className="mt-0.5 h-4 w-4 animate-spin text-primary" />
                    ) : (
                      <span className="text-xs text-muted-foreground">{step.index + 1}</span>
                    )}
                  </div>

                  <div className="min-w-0 flex-1 space-y-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {step.action.type}
                      </span>
                      <Badge variant="outline">{step.origin}</Badge>
                      <span className="text-xs text-muted-foreground">
                        {formatDuration(step.timestampMs)}
                      </span>
                    </div>

                    <div className="truncate text-xs text-muted-foreground">{step.pageUrl}</div>

                    {step.selectors && step.selectors.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {step.selectors.slice(0, 3).map((selector) => (
                          <Badge
                            key={`${step.id}-${selector.type}-${selector.value}`}
                            variant="secondary"
                          >
                            {selector.type}: {selector.value}
                          </Badge>
                        ))}
                      </div>
                    )}

                    {step.screenshot && (
                      <div className="overflow-hidden rounded-lg border border-border bg-muted/30">
                        <img
                          src={`data:image/jpeg;base64,${step.screenshot}`}
                          alt={`Recording step ${step.index + 1}`}
                          loading="lazy"
                          className="h-auto max-h-72 w-full object-cover"
                        />
                      </div>
                    )}

                    <pre className="overflow-x-auto rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
                      {JSON.stringify(step.action, null, 2)}
                    </pre>

                    {step.privacyAnnotations && step.privacyAnnotations.length > 0 && (
                      <div className="flex flex-wrap gap-2">
                        {step.privacyAnnotations.slice(0, 4).map((annotation, index) => (
                          <Badge
                            key={`${step.id}-privacy-${annotation.path}-${index}`}
                            variant="outline"
                          >
                            {annotation.type}: {annotation.path}
                          </Badge>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </ScrollArea>
      </Card>
    </div>
  );
}

export default function RecordingDetailPage() {
  const navigate = useNavigate();
  const { recordingId } = useParams();
  const [speed, setSpeed] = useState('1');
  const [stepTimeoutMs, setStepTimeoutMs] = useState('15000');
  const [errorStrategy, setErrorStrategy] = useState<ReplayErrorStrategy>('abort');
  const [maxRetries, setMaxRetries] = useState('2');
  const {
    selectedRecording,
    replayRuns,
    error,
    loadRecording,
    loadReplayRuns,
    refreshActiveReplayForRecording,
    updateRecording,
    startReplay,
    pauseReplay,
    resumeReplay,
    stepReplay,
    cancelReplay,
    applyReplayRun,
  } = useRecordingStore();

  useEffect(() => {
    if (!recordingId) {
      return;
    }
    void loadRecording(recordingId);
    void loadReplayRuns(recordingId);
    void refreshActiveReplayForRecording(recordingId);
  }, [loadRecording, loadReplayRuns, recordingId, refreshActiveReplayForRecording]);

  useEffect(() => {
    const accomplish = getAccomplish();
    return accomplish.onReplayUpdate((run) => {
      applyReplayRun(run);
    });
  }, [applyReplayRun]);

  const replayRun = useMemo(() => {
    if (!recordingId) {
      return null;
    }

    return (
      Object.values(replayRuns)
        .filter((run) => run.recordingId === recordingId)
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))[0] ?? null
    );
  }, [recordingId, replayRuns]);

  const replayHistory = useMemo(() => {
    if (!recordingId) {
      return [];
    }

    return Object.values(replayRuns)
      .filter((run) => run.recordingId === recordingId)
      .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
  }, [recordingId, replayRuns]);

  const activeStepIndex =
    replayRun?.status === 'running' || replayRun?.status === 'paused'
      ? Math.min(replayRun.currentStepIndex, Number.MAX_SAFE_INTEGER)
      : -1;
  const resolvedRecordingId = recordingId ?? selectedRecording?.id ?? null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <div className="mx-auto flex h-full min-h-0 w-full max-w-6xl flex-1 flex-col gap-6 px-6 py-8">
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={() => navigate('/recordings')}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-2xl font-semibold text-foreground">
                {selectedRecording?.name ?? 'Recording'}
              </h1>
              <p className="text-sm text-muted-foreground">
                Inspect recorded browser steps and replay them in a fresh dev-browser page.
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {replayRun?.status === 'running' || replayRun?.status === 'paused' ? (
              <>
                {replayRun.status === 'running' ? (
                  <Button
                    variant="outline"
                    className="gap-2"
                    onClick={() => void pauseReplay(replayRun.id)}
                  >
                    Pause Replay
                  </Button>
                ) : replayRun.options.speed === 0 ? (
                  <>
                    <Button
                      variant="outline"
                      className="gap-2"
                      onClick={() => void stepReplay(replayRun.id)}
                    >
                      Step Replay
                    </Button>
                    <Button className="gap-2" onClick={() => void resumeReplay(replayRun.id)}>
                      Continue Replay
                    </Button>
                  </>
                ) : (
                  <Button className="gap-2" onClick={() => void resumeReplay(replayRun.id)}>
                    Resume Replay
                  </Button>
                )}
                <Button
                  variant="destructive"
                  className="gap-2"
                  onClick={() => void cancelReplay(replayRun.id)}
                >
                  <Stop className="h-4 w-4" />
                  Cancel Replay
                </Button>
              </>
            ) : null}
          </div>
        </div>

        {error && <Card className="p-4 text-sm text-destructive">{error}</Card>}

        {!resolvedRecordingId ? (
          <Card className="p-6 text-sm text-destructive">Recording ID is missing.</Card>
        ) : !selectedRecording ? (
          <Card className="p-6 text-sm text-muted-foreground">Loading recording...</Card>
        ) : (
          <RecordingDetailContent
            key={selectedRecording.id}
            activeStepIndex={activeStepIndex}
            errorStrategy={errorStrategy}
            maxRetries={maxRetries}
            recording={selectedRecording}
            recordingId={resolvedRecordingId}
            replayRun={replayRun}
            replayHistory={replayHistory}
            setErrorStrategy={setErrorStrategy}
            setMaxRetries={setMaxRetries}
            setSpeed={setSpeed}
            setStepTimeoutMs={setStepTimeoutMs}
            speed={speed}
            startReplay={startReplay}
            stepTimeoutMs={stepTimeoutMs}
            updateRecording={updateRecording}
          />
        )}
      </div>
    </div>
  );
}

import type { Recording, ReplayOptions, ReplayStepState } from '@accomplish_ai/agent-core/common';

export const DEFAULT_REPLAY_OPTIONS: ReplayOptions = {
  speed: 1,
  parameters: {},
  errorStrategy: 'abort',
  stepTimeoutMs: 15_000,
  maxRetries: 2,
};

export function serializeForEvaluation(value: unknown): string {
  const serialized = JSON.stringify(value);
  return (serialized === undefined ? 'undefined' : serialized)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

export function assertNeverAction(action: never): never {
  throw new Error(`Unsupported replay action: ${(action as { type?: string }).type ?? 'unknown'}`);
}

export function normalizeReplayOptions(options?: Partial<ReplayOptions>): ReplayOptions {
  return {
    speed:
      typeof options?.speed === 'number' && options.speed >= 0
        ? options.speed
        : DEFAULT_REPLAY_OPTIONS.speed,
    parameters: options?.parameters ?? DEFAULT_REPLAY_OPTIONS.parameters,
    errorStrategy: options?.errorStrategy ?? DEFAULT_REPLAY_OPTIONS.errorStrategy,
    stepTimeoutMs:
      typeof options?.stepTimeoutMs === 'number' &&
      Number.isFinite(options.stepTimeoutMs) &&
      options.stepTimeoutMs >= 0
        ? Math.floor(options.stepTimeoutMs)
        : DEFAULT_REPLAY_OPTIONS.stepTimeoutMs,
    maxRetries:
      typeof options?.maxRetries === 'number' && options.maxRetries >= 0
        ? Math.floor(options.maxRetries)
        : DEFAULT_REPLAY_OPTIONS.maxRetries,
  };
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function makeReplayPageName(runId: string): string {
  return `replay-${runId}`;
}

export function buildCurrentStep(
  recording: Recording,
  stepIndex: number,
): ReplayStepState | undefined {
  const step = recording.steps[stepIndex];
  if (!step) {
    return undefined;
  }

  return {
    index: step.index,
    stepId: step.id,
    actionType: step.action.type,
    pageUrl: step.pageUrl,
  };
}

export function buildUploadParameterId(stepId: string): string {
  return `upload-${stepId}`;
}

export function buildUploadParameterName(stepIndex: number): string {
  return `upload_step_${stepIndex + 1}`;
}

export function parseUploadPathList(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean);
    }
  } catch {
    // Ignore JSON parsing failures and fall back to newline-delimited input.
  }

  return trimmed
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);
}

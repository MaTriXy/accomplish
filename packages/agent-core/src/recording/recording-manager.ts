import { EventEmitter } from 'events';
import type {
  PrivacyConfig,
  Recording,
  RecordingOrigin,
  RecordingStep,
  RecordingUpdateInput,
  ReplayRun,
} from '../common/types/recording.js';
import { DEFAULT_PRIVACY_CONFIG } from '../common/types/recording.js';
import { isDatabaseInitialized } from '../storage/database.js';
import {
  deleteRecording as deleteRecordingRecord,
  getActiveRecordingForTask as getActiveRecordingForTaskRecord,
  getRecording,
  getRecordingPrivacyConfig,
  getReplayRun,
  listRecordings,
  listReplayRunsForRecording,
  markIncompleteReplayRunsAsFailed,
  saveRecording,
  saveReplayRun as saveReplayRunRecord,
  setRecordingPrivacyConfig,
} from '../storage/repositories/recordings.js';
import { createConsoleLogger } from '../utils/logging.js';
import {
  buildExportBaseName,
  exportRecordingToFile,
  importRecordingFromFile,
} from './recording-io.js';
import {
  buildSelectors,
  createEmptyRecording,
  createRecording,
  inferAction,
  inferPageUrl,
} from './recording-inference.js';
import {
  type ActiveRecordingState,
  FALLBACK_PAGE_URL,
  type ManualRecordingState,
  type ManualStepInput,
  type ToolCallPayload,
} from './recording-manager-shared.js';
import { scrubAction, scrubUnknown, scrubUrl } from './recording-privacy.js';

const log = createConsoleLogger({ prefix: 'RecordingManager' });

export class RecordingManager extends EventEmitter {
  private activeRecordings = new Map<string, ActiveRecordingState>();
  private manualRecordings = new Map<string, ManualRecordingState>();

  constructor() {
    super();
    if (isDatabaseInitialized()) {
      markIncompleteReplayRunsAsFailed();
    }
  }

  listRecordings(): Recording[] {
    return listRecordings();
  }

  getRecording(recordingId: string): Recording | null {
    return getRecording(recordingId);
  }

  getActiveRecordingForTask(taskId: string): Recording | null {
    const active = this.activeRecordings.get(taskId);
    if (active) {
      return getRecording(active.recordingId);
    }
    return getActiveRecordingForTaskRecord(taskId);
  }

  listReplayRuns(recordingId: string): ReplayRun[] {
    return listReplayRunsForRecording(recordingId);
  }

  getReplayRun(runId: string): ReplayRun | null {
    return getReplayRun(runId);
  }

  saveReplayRun(run: ReplayRun): ReplayRun {
    saveReplayRunRecord(run);
    return run;
  }

  updateRecording(recordingId: string, input: RecordingUpdateInput): Recording {
    const recording = getRecording(recordingId);
    if (!recording) {
      throw new Error(`Recording ${recordingId} not found`);
    }

    recording.name = input.name?.trim() || recording.name;
    recording.description = input.description?.trim() || undefined;
    if (input.parameters) {
      recording.parameters = input.parameters;
    }
    if (input.tags) {
      recording.tags = input.tags;
    }
    recording.updatedAt = new Date().toISOString();
    saveRecording(recording);
    return recording;
  }

  getPrivacyConfig(): PrivacyConfig {
    return {
      ...DEFAULT_PRIVACY_CONFIG,
      ...(getRecordingPrivacyConfig() ?? {}),
    };
  }

  setPrivacyConfig(config: PrivacyConfig): PrivacyConfig {
    setRecordingPrivacyConfig(config);
    return config;
  }

  async startAgentRecording(taskId: string, name?: string): Promise<Recording> {
    const privacyConfig = this.getPrivacyConfig();
    if (!privacyConfig.enabled) {
      throw new Error('Recording is disabled in settings');
    }

    const existing = this.getActiveRecordingForTask(taskId);
    if (existing) {
      if (!this.activeRecordings.has(taskId)) {
        this.activeRecordings.set(taskId, {
          recordingId: existing.id,
          taskId,
          startedAtMs: Date.now() - existing.metadata.durationMs,
          lastPageUrl:
            existing.steps[existing.steps.length - 1]?.pageUrl ?? existing.metadata.startUrl,
        });
      }
      return existing;
    }

    const recording = createEmptyRecording(taskId, name);
    recording.privacyManifest.configSnapshot = privacyConfig;
    saveRecording(recording);

    this.activeRecordings.set(taskId, {
      recordingId: recording.id,
      taskId,
      startedAtMs: Date.now(),
      lastPageUrl: recording.metadata.startUrl,
    });

    return recording;
  }

  async startManualRecording(name?: string, startUrl?: string): Promise<Recording> {
    const privacyConfig = this.getPrivacyConfig();
    if (!privacyConfig.enabled) {
      throw new Error('Recording is disabled in settings');
    }

    const existing = [...this.manualRecordings.values()]
      .map((entry) => getRecording(entry.recordingId))
      .find((recording) => recording?.status === 'recording');
    if (existing) {
      return existing;
    }

    const recording = createRecording({
      source: 'user',
      name,
      startUrl: startUrl?.trim() || FALLBACK_PAGE_URL,
    });
    recording.privacyManifest.configSnapshot = privacyConfig;
    saveRecording(recording);

    this.manualRecordings.set(recording.id, {
      recordingId: recording.id,
      startedAtMs: Date.now(),
      lastPageUrl: recording.metadata.startUrl,
    });

    return recording;
  }

  async stopRecording(recordingId: string): Promise<Recording> {
    const activeEntry = [...this.activeRecordings.values()].find(
      (entry) => entry.recordingId === recordingId,
    );

    if (activeEntry) {
      return this.finalizeTaskRecording(activeEntry.taskId, 'completed');
    }

    const recording = getRecording(recordingId);
    if (!recording) {
      throw new Error(`Recording ${recordingId} not found`);
    }

    if (recording.status === 'recording') {
      recording.status = 'completed';
      recording.updatedAt = new Date().toISOString();
      saveRecording(recording);
    }

    return recording;
  }

  recordReasoning(taskId: string, text: string): void {
    const active = this.activeRecordings.get(taskId);
    if (!active) {
      return;
    }

    const recording = getRecording(active.recordingId);
    if (!recording) {
      this.activeRecordings.delete(taskId);
      return;
    }

    const privacyConfig = recording.privacyManifest.configSnapshot;
    if (!privacyConfig.recordAgentReasoning) {
      active.pendingReasoning = undefined;
      return;
    }

    const scrubbed = scrubUnknown(text, 'reasoning', privacyConfig);
    active.pendingReasoning = typeof scrubbed.value === 'string' ? scrubbed.value : undefined;
  }

  recordToolUse(_taskId: string, _toolName: string, _toolInput: unknown): void {
    // Reserved for future richer live-step capture. The first MVP slice records on completion.
  }

  recordManualStep(recordingId: string, input: ManualStepInput): Recording | null {
    const active = this.manualRecordings.get(recordingId);
    if (!active) {
      return null;
    }

    const recording = getRecording(recordingId);
    if (!recording) {
      this.manualRecordings.delete(recordingId);
      return null;
    }

    const privacyConfig = recording.privacyManifest.configSnapshot;
    const scrubbedSelectors = input.selectors
      ? scrubUnknown(input.selectors, 'selectors', privacyConfig)
      : { value: undefined, annotations: [] };
    const safeSelectors = Array.isArray(scrubbedSelectors.value)
      ? scrubbedSelectors.value
      : undefined;
    const scrubbedAction = scrubAction(input.action, safeSelectors, privacyConfig);
    const safeAction = scrubbedAction.action;
    const scrubbedPageUrl = scrubUrl(input.pageUrl ?? active.lastPageUrl, privacyConfig);
    const annotations = [
      ...scrubbedAction.annotations,
      ...scrubbedSelectors.annotations,
      ...scrubbedPageUrl.annotations,
      ...(input.privacyAnnotations ?? []),
    ];

    const nextPageUrl =
      safeAction.type === 'navigate' ? safeAction.url : scrubbedPageUrl.value || active.lastPageUrl;
    active.lastPageUrl = nextPageUrl;
    if (recording.metadata.startUrl === FALLBACK_PAGE_URL && nextPageUrl) {
      recording.metadata.startUrl = nextPageUrl;
    }

    const step: RecordingStep = {
      index: recording.steps.length,
      id: crypto.randomUUID(),
      timestampMs: Date.now() - active.startedAtMs,
      action: safeAction,
      selectors: safeSelectors,
      screenshot: input.screenshot,
      targetSnapshot: input.targetSnapshot,
      pageUrl: nextPageUrl || FALLBACK_PAGE_URL,
      privacyAnnotations: annotations.length > 0 ? annotations : undefined,
      origin: 'user',
    };

    recording.steps.push(step);
    recording.metadata.stepCount = recording.steps.length;
    recording.metadata.durationMs = step.timestampMs;
    recording.updatedAt = new Date().toISOString();
    recording.privacyManifest.redactions.push(...annotations);
    saveRecording(recording);
    return recording;
  }

  recordToolCallComplete(taskId: string, payload: ToolCallPayload): void {
    const active = this.activeRecordings.get(taskId);
    if (!active) {
      return;
    }

    const recording = getRecording(active.recordingId);
    if (!recording) {
      this.activeRecordings.delete(taskId);
      return;
    }

    const privacyConfig = recording.privacyManifest.configSnapshot;
    const rawToolInput =
      typeof payload.toolInput === 'object' && payload.toolInput !== null
        ? (payload.toolInput as Record<string, unknown>)
        : {};
    const scrubbedToolInput = scrubUnknown(rawToolInput, 'toolInput', privacyConfig);
    const safeToolInput =
      typeof scrubbedToolInput.value === 'object' && scrubbedToolInput.value !== null
        ? (scrubbedToolInput.value as Record<string, unknown>)
        : {};
    const selectors = buildSelectors(safeToolInput);
    const scrubbedAction = scrubAction(
      inferAction(payload.toolName, safeToolInput, payload.toolOutput),
      selectors,
      privacyConfig,
    );
    const action = scrubbedAction.action;
    const inferredPageUrl = inferPageUrl(action, safeToolInput, active.lastPageUrl);
    const annotations = [...scrubbedToolInput.annotations, ...scrubbedAction.annotations];

    if (action.type === 'navigate') {
      const scrubbedUrl = scrubUrl(action.url, privacyConfig);
      action.url = scrubbedUrl.value;
      annotations.push(...scrubbedUrl.annotations);
      active.lastPageUrl = action.url;
      if (recording.metadata.startUrl === FALLBACK_PAGE_URL) {
        recording.metadata.startUrl = action.url;
      }
    } else if (typeof safeToolInput.url === 'string') {
      const scrubbedUrl = scrubUrl(safeToolInput.url, privacyConfig);
      annotations.push(...scrubbedUrl.annotations);
      active.lastPageUrl = scrubbedUrl.value;
    }

    const step: RecordingStep = {
      index: recording.steps.length,
      id: crypto.randomUUID(),
      timestampMs: Date.now() - active.startedAtMs,
      action,
      selectors,
      pageUrl: active.lastPageUrl || inferredPageUrl || FALLBACK_PAGE_URL,
      privacyAnnotations: annotations.length > 0 ? annotations : undefined,
      origin: 'agent' as RecordingOrigin,
      agentContext: {
        toolName: payload.toolName,
        toolInput: safeToolInput,
        reasoning: active.pendingReasoning,
      },
    };

    recording.steps.push(step);
    recording.metadata.stepCount = recording.steps.length;
    recording.metadata.durationMs = step.timestampMs;
    recording.updatedAt = new Date().toISOString();
    recording.privacyManifest.redactions.push(...annotations);

    active.pendingReasoning = undefined;
    saveRecording(recording);
  }

  finalizeTaskRecording(taskId: string, status: 'completed' | 'failed' = 'completed'): Recording {
    const active = this.activeRecordings.get(taskId);
    if (!active) {
      const existing = getActiveRecordingForTaskRecord(taskId);
      if (!existing) {
        throw new Error(`No active recording for task ${taskId}`);
      }
      existing.status = status;
      existing.updatedAt = new Date().toISOString();
      saveRecording(existing);
      return existing;
    }

    const recording = getRecording(active.recordingId);
    if (!recording) {
      this.activeRecordings.delete(taskId);
      throw new Error(`Recording ${active.recordingId} not found`);
    }

    recording.status = status;
    recording.metadata.durationMs = Date.now() - active.startedAtMs;
    recording.metadata.stepCount = recording.steps.length;
    recording.updatedAt = new Date().toISOString();
    saveRecording(recording);
    this.activeRecordings.delete(taskId);

    return recording;
  }

  finalizeManualRecording(
    recordingId: string,
    status: 'completed' | 'failed' = 'completed',
  ): Recording {
    const active = this.manualRecordings.get(recordingId);
    const recording = getRecording(recordingId);
    if (!recording) {
      this.manualRecordings.delete(recordingId);
      throw new Error(`Recording ${recordingId} not found`);
    }

    recording.status = status;
    if (active) {
      recording.metadata.durationMs = Date.now() - active.startedAtMs;
      this.manualRecordings.delete(recordingId);
    }
    recording.metadata.stepCount = recording.steps.length;
    recording.updatedAt = new Date().toISOString();
    saveRecording(recording);

    return recording;
  }

  deleteRecording(recordingId: string): void {
    for (const [taskId, active] of this.activeRecordings.entries()) {
      if (active.recordingId === recordingId) {
        this.activeRecordings.delete(taskId);
      }
    }
    this.manualRecordings.delete(recordingId);
    deleteRecordingRecord(recordingId);
  }

  getSuggestedExportFileName(recordingId: string, format: 'json' | 'zip' = 'zip'): string {
    const recording = getRecording(recordingId);
    if (!recording) {
      throw new Error(`Recording ${recordingId} not found`);
    }

    return `${buildExportBaseName(recording)}.accomplish-recording.${format}`;
  }

  async exportRecording(recordingId: string, filePath: string): Promise<string> {
    const recording = getRecording(recordingId);
    if (!recording) {
      throw new Error(`Recording ${recordingId} not found`);
    }

    return exportRecordingToFile(recording, filePath);
  }

  async importRecording(filePath: string): Promise<Recording> {
    const { recording } = await importRecordingFromFile(filePath);
    saveRecording(recording);
    log.info(`[RecordingManager] Imported recording from ${filePath}`);
    return recording;
  }
}

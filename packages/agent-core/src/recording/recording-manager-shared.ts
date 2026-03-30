import type {
  PrivacyAnnotation,
  RecordingAction,
  RecordingStep,
  SelectorStrategy,
} from '../common/types/recording.js';

export const FALLBACK_PAGE_URL = 'about:blank';
export const DEFAULT_USER_AGENT = 'Accomplish Recording';
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
export const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_IMPORTED_STEPS = 5_000;
export const MAX_IMPORTED_PARAMETERS = 500;
export const MAX_IMPORTED_TAGS = 100;
export const MAX_SCREENSHOT_BASE64_LENGTH = 8 * 1024 * 1024;
export const MAX_TEXT_FIELD_LENGTH = 100_000;

export interface ActiveRecordingState {
  recordingId: string;
  taskId: string;
  startedAtMs: number;
  lastPageUrl: string;
  pendingReasoning?: string;
}

export interface ManualRecordingState {
  recordingId: string;
  startedAtMs: number;
  lastPageUrl: string;
}

export interface ManualStepInput {
  action: RecordingAction;
  selectors?: SelectorStrategy[];
  pageUrl?: string;
  screenshot?: string;
  targetSnapshot?: RecordingStep['targetSnapshot'];
  privacyAnnotations?: PrivacyAnnotation[];
}

export interface ToolCallPayload {
  toolName: string;
  toolInput: unknown;
  toolOutput: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

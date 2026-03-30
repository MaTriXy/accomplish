export type RecordingSource = 'agent' | 'user' | 'mixed';
export type RecordingStatus = 'recording' | 'completed' | 'failed';
export type RecordingOrigin = 'agent' | 'user';
export type ReplayStatus = 'running' | 'paused' | 'completed' | 'failed' | 'cancelled';
export type ReplayErrorStrategy = 'abort' | 'skip' | 'retry';

export interface Recording {
  id: string;
  schemaVersion: number;
  name: string;
  description?: string;
  status: RecordingStatus;
  metadata: RecordingMetadata;
  steps: RecordingStep[];
  privacyManifest: PrivacyManifest;
  parameters: RecordingParameter[];
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface RecordingMetadata {
  source: RecordingSource;
  sourceTaskId?: string;
  originalRecordingId?: string;
  importedFromBundleId?: string;
  importedAt?: string;
  durationMs: number;
  stepCount: number;
  startUrl: string;
  viewport: { width: number; height: number };
  userAgent: string;
  appVersion: string;
  platform: string;
}

export interface RecordingStep {
  index: number;
  id: string;
  timestampMs: number;
  action: RecordingAction;
  selectors?: SelectorStrategy[];
  screenshot?: string;
  targetSnapshot?: ElementSnapshot;
  pageUrl: string;
  privacyAnnotations?: PrivacyAnnotation[];
  origin: RecordingOrigin;
  agentContext?: {
    toolName: string;
    toolInput: Record<string, unknown>;
    reasoning?: string;
  };
}

export type RecordingAction =
  | { type: 'navigate'; url: string; navigationType: 'goto' | 'back' | 'forward' | 'reload' }
  | {
      type: 'click';
      button: 'left' | 'right' | 'middle';
      clickCount: number;
      x?: number;
      y?: number;
    }
  | { type: 'fill'; value: string; clearFirst: boolean }
  | { type: 'type'; text: string; delay?: number }
  | { type: 'keypress'; key: string; modifiers: string[] }
  | { type: 'select'; values: string[] }
  | { type: 'scroll'; deltaX: number; deltaY: number; target: 'viewport' | 'element' }
  | { type: 'hover' }
  | { type: 'upload'; fileNames: string[]; mimeTypes: string[] }
  | { type: 'wait'; condition: WaitCondition; durationMs: number }
  | { type: 'tool-call'; toolName: string; outputSummary?: string };

export interface SelectorStrategy {
  type: 'css' | 'xpath' | 'text' | 'aria-label' | 'aria-role' | 'test-id' | 'ref';
  value: string;
  confidence: number;
}

export interface WaitCondition {
  type: 'networkIdle' | 'selectorVisible' | 'selectorHidden' | 'timeout' | 'navigation' | 'custom';
  value?: string;
  timeoutMs: number;
}

export interface ElementSnapshot {
  role: string;
  name: string;
  tagName: string;
  innerText?: string;
  attributes: Record<string, string>;
  boundingBox: { x: number; y: number; width: number; height: number };
}

export interface PrivacyConfig {
  enabled: boolean;
  recordAgentReasoning: boolean;
  redactEmails: boolean;
  redactSecrets: boolean;
  redactUrlQueryParams: boolean;
  redactAllFormInputs: boolean;
  captureScreenshots: boolean;
  blurAllScreenshots: boolean;
  maxScreenshotWidth: number;
  maxScreenshotHeight: number;
  customSensitiveKeys: string[];
}

export interface PrivacyAnnotation {
  type: 'email' | 'secret' | 'url-query' | 'custom';
  path: string;
  replacement: string;
}

export interface PrivacyManifest {
  configSnapshot: PrivacyConfig;
  redactions: PrivacyAnnotation[];
}

export interface RecordingParameter {
  id: string;
  name: string;
  description: string;
  defaultValue: string;
  type: 'text' | 'url' | 'email' | 'number' | 'password' | 'file-path';
}

export interface RecordingUpdateInput {
  name?: string;
  description?: string;
  parameters?: RecordingParameter[];
  tags?: string[];
}

export interface ReplayOptions {
  speed: number;
  parameters: Record<string, string>;
  errorStrategy: ReplayErrorStrategy;
  stepTimeoutMs: number;
  maxRetries: number;
}

export interface ReplayStepState {
  index: number;
  stepId: string;
  actionType: RecordingAction['type'];
  pageUrl: string;
}

export interface ReplayRun {
  id: string;
  recordingId: string;
  recordingName: string;
  status: ReplayStatus;
  currentStepIndex: number;
  totalSteps: number;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  options: ReplayOptions;
  currentStep?: ReplayStepState;
}

export const RECORDING_SCHEMA_VERSION = 1;

export const DEFAULT_PRIVACY_CONFIG: PrivacyConfig = {
  enabled: true,
  recordAgentReasoning: true,
  redactEmails: true,
  redactSecrets: true,
  redactUrlQueryParams: true,
  redactAllFormInputs: false,
  captureScreenshots: false,
  blurAllScreenshots: false,
  maxScreenshotWidth: 960,
  maxScreenshotHeight: 540,
  customSensitiveKeys: ['token', 'auth', 'password', 'secret', 'code', 'key', 'session'],
};

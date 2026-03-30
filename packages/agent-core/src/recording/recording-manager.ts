import { EventEmitter } from 'events';
import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import {
  DEFAULT_PRIVACY_CONFIG,
  RECORDING_SCHEMA_VERSION,
  type PrivacyAnnotation,
  type PrivacyConfig,
  type Recording,
  type RecordingAction,
  type RecordingOrigin,
  type RecordingSource,
  type RecordingUpdateInput,
  type RecordingStep,
  type ReplayRun,
  type SelectorStrategy,
} from '../common/types/recording.js';
import {
  deleteRecording as deleteRecordingRecord,
  getActiveRecordingForTask as getActiveRecordingForTaskRecord,
  getRecording,
  getRecordingPrivacyConfig,
  getReplayRun,
  listReplayRunsForRecording,
  markIncompleteReplayRunsAsFailed,
  listRecordings,
  saveRecording,
  saveReplayRun as saveReplayRunRecord,
  setRecordingPrivacyConfig,
} from '../storage/repositories/recordings.js';
import { isDatabaseInitialized } from '../storage/database.js';
import { createConsoleLogger } from '../utils/logging.js';
import { createRecordingBundle, parseRecordingBundle } from './recording-bundle.js';

const log = createConsoleLogger({ prefix: 'RecordingManager' });
const FALLBACK_PAGE_URL = 'about:blank';
const DEFAULT_USER_AGENT = 'Accomplish Recording';
const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MAX_IMPORT_FILE_BYTES = 25 * 1024 * 1024;
const MAX_IMPORTED_STEPS = 5_000;
const MAX_IMPORTED_PARAMETERS = 500;
const MAX_IMPORTED_TAGS = 100;
const MAX_SCREENSHOT_BASE64_LENGTH = 8 * 1024 * 1024;
const MAX_TEXT_FIELD_LENGTH = 100_000;

interface ActiveRecordingState {
  recordingId: string;
  taskId: string;
  startedAtMs: number;
  lastPageUrl: string;
  pendingReasoning?: string;
}

interface ManualRecordingState {
  recordingId: string;
  startedAtMs: number;
  lastPageUrl: string;
}

interface ManualStepInput {
  action: RecordingAction;
  selectors?: SelectorStrategy[];
  pageUrl?: string;
  screenshot?: string;
  targetSnapshot?: RecordingStep['targetSnapshot'];
  privacyAnnotations?: PrivacyAnnotation[];
}

interface ToolCallPayload {
  toolName: string;
  toolInput: unknown;
  toolOutput: string;
}

type SensitiveFieldKind = 'email' | 'secret' | 'custom';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength - 3)}...`;
}

function scrubString(
  value: string,
  pathLabel: string,
  config: PrivacyConfig,
): { value: string; annotations: PrivacyAnnotation[] } {
  if (!config.enabled) {
    return { value, annotations: [] };
  }

  let nextValue = value;
  const annotations: PrivacyAnnotation[] = [];

  if (config.redactEmails) {
    nextValue = nextValue.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (match) => {
      const replacement = `[EMAIL_${crypto.createHash('sha256').update(match).digest('hex').slice(0, 8)}]`;
      annotations.push({ type: 'email', path: pathLabel, replacement });
      return replacement;
    });
  }

  if (config.redactSecrets) {
    nextValue = nextValue.replace(
      /\b(?:sk|pk|ghp|xoxb|token|secret|bearer)[-_]?[a-zA-Z0-9]{12,}\b/gi,
      () => {
        const replacement = '[SECRET_REDACTED]';
        annotations.push({ type: 'secret', path: pathLabel, replacement });
        return replacement;
      },
    );
  }

  return { value: nextValue, annotations };
}

function scrubUrl(
  value: string,
  config: PrivacyConfig,
): { value: string; annotations: PrivacyAnnotation[] } {
  if (!config.enabled || !config.redactUrlQueryParams) {
    return { value, annotations: [] };
  }

  try {
    const parsed = new URL(value);
    const annotations: PrivacyAnnotation[] = [];

    for (const key of [...parsed.searchParams.keys()]) {
      if (
        config.customSensitiveKeys.some((candidate) =>
          key.toLowerCase().includes(candidate.toLowerCase()),
        )
      ) {
        parsed.searchParams.set(key, '[REDACTED]');
        annotations.push({ type: 'url-query', path: `url.${key}`, replacement: '[REDACTED]' });
      }
    }

    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      annotations.push({ type: 'secret', path: 'url.credentials', replacement: '' });
    }

    return { value: parsed.toString(), annotations };
  } catch {
    return scrubString(value, 'url', config);
  }
}

function scrubUnknown(
  value: unknown,
  pathLabel: string,
  config: PrivacyConfig,
): { value: unknown; annotations: PrivacyAnnotation[] } {
  if (typeof value === 'string') {
    return scrubString(value, pathLabel, config);
  }

  if (Array.isArray(value)) {
    const annotations: PrivacyAnnotation[] = [];
    const nextValue = value.map((entry, index) => {
      const scrubbed = scrubUnknown(entry, `${pathLabel}[${index}]`, config);
      annotations.push(...scrubbed.annotations);
      return scrubbed.value;
    });
    return { value: nextValue, annotations };
  }

  if (isRecord(value)) {
    const annotations: PrivacyAnnotation[] = [];
    const nextValue: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const scrubbed =
        key.toLowerCase().includes('url') && typeof entry === 'string'
          ? scrubUrl(entry, config)
          : scrubUnknown(entry, `${pathLabel}.${key}`, config);
      nextValue[key] = scrubbed.value;
      annotations.push(...scrubbed.annotations);
    }
    return { value: nextValue, annotations };
  }

  return { value, annotations: [] };
}

function normalizeSelectorHints(selectors?: SelectorStrategy[]): string[] {
  if (!selectors?.length) {
    return [];
  }

  return selectors
    .map((selector) => selector.value)
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
    .flatMap((value) => {
      const values = [value.toLowerCase()];
      if (value.startsWith('{')) {
        try {
          const parsed = JSON.parse(value) as { role?: string; name?: string };
          if (typeof parsed.role === 'string') {
            values.push(parsed.role.toLowerCase());
          }
          if (typeof parsed.name === 'string') {
            values.push(parsed.name.toLowerCase());
          }
        } catch {
          // Ignore malformed aria-role payloads.
        }
      }
      return values;
    });
}

function inferSensitiveFieldKind(
  action: RecordingAction,
  selectors: SelectorStrategy[] | undefined,
  config: PrivacyConfig,
): SensitiveFieldKind | null {
  if (action.type !== 'fill' && action.type !== 'select') {
    return null;
  }

  if (config.redactAllFormInputs) {
    return 'custom';
  }

  const hints = normalizeSelectorHints(selectors);
  if (hints.some((hint) => hint.includes('email') || hint.includes('e-mail'))) {
    return config.redactEmails ? 'email' : null;
  }

  const defaultSensitiveKeys = [
    'pass',
    'password',
    'otp',
    'pin',
    'token',
    'secret',
    'session',
    'auth',
    'api-key',
    'apikey',
    'verification',
    'code',
  ];
  const configuredKeys = config.customSensitiveKeys.map((key) => key.toLowerCase());
  const keys = [...new Set([...defaultSensitiveKeys, ...configuredKeys])];

  const matchingKey = keys.find((key) => hints.some((hint) => hint.includes(key)));
  if (!matchingKey) {
    return null;
  }

  if (config.redactSecrets) {
    return 'secret';
  }

  return configuredKeys.includes(matchingKey) ? 'custom' : null;
}

function redactFieldValue(value: string, kind: SensitiveFieldKind): string {
  if (kind === 'email') {
    return value
      ? `[EMAIL_${crypto.createHash('sha256').update(value).digest('hex').slice(0, 8)}]`
      : '[EMAIL_REDACTED]';
  }

  if (kind === 'custom') {
    return '[CUSTOM_FIELD_REDACTED]';
  }

  return '[SECRET_FIELD_REDACTED]';
}

function scrubAction(
  action: RecordingAction,
  selectors: SelectorStrategy[] | undefined,
  config: PrivacyConfig,
): { action: RecordingAction; annotations: PrivacyAnnotation[] } {
  const scrubbed = scrubUnknown(action, 'action', config);
  let safeAction = scrubbed.value as RecordingAction;
  const annotations = [...scrubbed.annotations];
  const sensitiveKind = inferSensitiveFieldKind(safeAction, selectors, config);

  if (!sensitiveKind) {
    return { action: safeAction, annotations };
  }

  if (safeAction.type === 'fill') {
    const replacement = redactFieldValue(safeAction.value, sensitiveKind);
    if (safeAction.value !== replacement) {
      annotations.push({
        type:
          sensitiveKind === 'email' ? 'email' : sensitiveKind === 'custom' ? 'custom' : 'secret',
        path: 'action.value',
        replacement,
      });
      safeAction = {
        ...safeAction,
        value: replacement,
      };
    }
  }

  if (safeAction.type === 'select') {
    safeAction = {
      ...safeAction,
      values: safeAction.values.map((value, index) => {
        const replacement = redactFieldValue(value, sensitiveKind);
        if (value !== replacement) {
          annotations.push({
            type:
              sensitiveKind === 'email'
                ? 'email'
                : sensitiveKind === 'custom'
                  ? 'custom'
                  : 'secret',
            path: `action.values[${index}]`,
            replacement,
          });
        }
        return replacement;
      }),
    };
  }

  return { action: safeAction, annotations };
}

function normalizeToolName(toolName: string): string {
  const knownPrefixes = ['dev-browser-mcp_', 'dev_browser_mcp_'];
  for (const prefix of knownPrefixes) {
    if (toolName.startsWith(prefix)) {
      return toolName.slice(prefix.length);
    }
  }
  return toolName;
}

function buildSelectors(toolInput: Record<string, unknown>): SelectorStrategy[] | undefined {
  const selectors: SelectorStrategy[] = [];
  const pushSelector = (type: SelectorStrategy['type'], key: string, confidence: number): void => {
    const value = toolInput[key];
    if (typeof value === 'string' && value.trim().length > 0) {
      selectors.push({ type, value, confidence });
    }
  };

  pushSelector('css', 'selector', 0.95);
  pushSelector('xpath', 'xpath', 0.9);
  pushSelector('ref', 'ref', 0.9);
  pushSelector('text', 'text', 0.75);
  pushSelector('aria-label', 'ariaLabel', 0.8);
  pushSelector('test-id', 'testId', 0.85);

  const role = typeof toolInput.role === 'string' ? toolInput.role.trim() : '';
  const roleNameCandidates = [toolInput.name, toolInput.ariaName, toolInput.ariaLabel];
  const roleName = roleNameCandidates.find(
    (candidate): candidate is string =>
      typeof candidate === 'string' && candidate.trim().length > 0,
  );
  if (role) {
    selectors.push({
      type: 'aria-role',
      value: JSON.stringify({ role, name: roleName?.trim() || null }),
      confidence: roleName ? 0.84 : 0.72,
    });
  }

  return selectors.length > 0 ? selectors : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return typeof value === 'string' ? [value] : [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function parseKeyboardShortcut(value: string): { key: string; modifiers: string[] } {
  const segments = value
    .split('+')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);

  if (segments.length === 0) {
    return { key: value, modifiers: [] };
  }

  if (segments.length === 1) {
    return { key: segments[0], modifiers: [] };
  }

  return {
    key: segments[segments.length - 1],
    modifiers: segments.slice(0, -1),
  };
}

function inferPageUrl(
  action: RecordingAction,
  toolInput: Record<string, unknown>,
  fallback: string,
): string {
  if (action.type === 'navigate') {
    return action.url;
  }
  const candidateUrl = toolInput.url;
  return typeof candidateUrl === 'string' && candidateUrl.trim().length > 0
    ? candidateUrl
    : fallback;
}

function inferAction(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
): RecordingAction {
  const normalizedToolName = normalizeToolName(toolName);

  switch (normalizedToolName) {
    case 'browser_goto':
      return {
        type: 'navigate',
        url: typeof toolInput.url === 'string' ? toolInput.url : FALLBACK_PAGE_URL,
        navigationType: 'goto',
      };
    case 'browser_click':
      return {
        type: 'click',
        button:
          toolInput.button === 'right' || toolInput.button === 'middle' ? toolInput.button : 'left',
        clickCount:
          typeof toolInput.clickCount === 'number'
            ? toolInput.clickCount
            : typeof toolInput.click_count === 'number'
              ? toolInput.click_count
              : 1,
        x: typeof toolInput.x === 'number' ? toolInput.x : undefined,
        y: typeof toolInput.y === 'number' ? toolInput.y : undefined,
      };
    case 'browser_type':
      return {
        type: 'fill',
        value: typeof toolInput.text === 'string' ? toolInput.text : '',
        clearFirst: toolInput.clear !== false,
      };
    case 'browser_scroll':
      if (toolInput.position === 'top' || toolInput.position === 'bottom') {
        return {
          type: 'scroll',
          deltaX: 0,
          deltaY: toolInput.position === 'top' ? -100_000 : 100_000,
          target: 'viewport',
        };
      }

      return {
        type: 'scroll',
        deltaX:
          toolInput.direction === 'left'
            ? -Math.abs(typeof toolInput.amount === 'number' ? toolInput.amount : 500)
            : toolInput.direction === 'right'
              ? Math.abs(typeof toolInput.amount === 'number' ? toolInput.amount : 500)
              : 0,
        deltaY:
          toolInput.direction === 'up'
            ? -Math.abs(typeof toolInput.amount === 'number' ? toolInput.amount : 500)
            : toolInput.direction === 'down'
              ? Math.abs(typeof toolInput.amount === 'number' ? toolInput.amount : 500)
              : typeof toolInput.deltaY === 'number'
                ? toolInput.deltaY
                : 0,
        target:
          typeof toolInput.selector === 'string' || typeof toolInput.ref === 'string'
            ? 'element'
            : 'viewport',
      };
    case 'browser_keyboard': {
      if (toolInput.action === 'type') {
        return {
          type: 'type',
          text: typeof toolInput.text === 'string' ? toolInput.text : '',
          delay: typeof toolInput.typing_delay === 'number' ? toolInput.typing_delay : undefined,
        };
      }

      const { key, modifiers } = parseKeyboardShortcut(
        typeof toolInput.key === 'string' ? toolInput.key : '',
      );
      return {
        type: 'keypress',
        key,
        modifiers,
      };
    }
    case 'browser_select':
      return {
        type: 'select',
        values: toStringArray(toolInput.values ?? toolInput.value ?? toolInput.label),
      };
    case 'browser_hover':
      return { type: 'hover' };
    case 'browser_wait':
      return {
        type: 'wait',
        condition: {
          type:
            toolInput.condition === 'selector'
              ? 'selectorVisible'
              : toolInput.condition === 'hidden'
                ? 'selectorHidden'
                : toolInput.condition === 'navigation'
                  ? 'navigation'
                  : toolInput.condition === 'network_idle'
                    ? 'networkIdle'
                    : toolInput.condition === 'function'
                      ? 'custom'
                      : 'timeout',
          value:
            typeof toolInput.selector === 'string'
              ? toolInput.selector
              : typeof toolInput.script === 'string'
                ? toolInput.script
                : typeof toolInput.timeout === 'number'
                  ? String(toolInput.timeout)
                  : typeof toolInput.timeoutMs === 'number'
                    ? String(toolInput.timeoutMs)
                    : undefined,
          timeoutMs:
            typeof toolInput.timeoutMs === 'number'
              ? toolInput.timeoutMs
              : typeof toolInput.timeout === 'number'
                ? toolInput.timeout
                : 1000,
        },
        durationMs:
          typeof toolInput.timeoutMs === 'number'
            ? toolInput.timeoutMs
            : typeof toolInput.timeout === 'number'
              ? toolInput.timeout
              : 1000,
      };
    case 'browser_batch_actions':
      return {
        type: 'tool-call',
        toolName,
        outputSummary: truncate(toolOutput.trim(), 240),
      };
    case 'browser_upload_file':
    case 'browser_file_upload':
      return {
        type: 'upload',
        fileNames: toStringArray(toolInput.fileNames ?? toolInput.files),
        mimeTypes: toStringArray(toolInput.mimeTypes),
      };
    default:
      return {
        type: 'tool-call',
        toolName,
        outputSummary: truncate(toolOutput.trim(), 240),
      };
  }
}

function createEmptyRecording(taskId: string, name?: string): Recording {
  return createRecording({
    source: 'agent',
    name,
    sourceTaskId: taskId,
    startUrl: FALLBACK_PAGE_URL,
  });
}

function sanitizeFileNameSegment(value: string): string {
  const sanitized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
  return sanitized || 'recording';
}

function formatFileTimestamp(value: string): string {
  try {
    return new Date(value)
      .toISOString()
      .replace(/:/g, '-')
      .replace(/\.\d{3}Z$/, 'Z');
  } catch {
    return new Date()
      .toISOString()
      .replace(/:/g, '-')
      .replace(/\.\d{3}Z$/, 'Z');
  }
}

function buildExportBaseName(recording: Recording): string {
  const originalId = recording.metadata.originalRecordingId ?? recording.id;
  return `${sanitizeFileNameSegment(recording.name)}-${formatFileTimestamp(
    recording.createdAt,
  )}-${originalId.slice(0, 8)}`;
}

function createRecording(options: {
  source: RecordingSource;
  name?: string;
  sourceTaskId?: string;
  startUrl?: string;
}): Recording {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID(),
    schemaVersion: RECORDING_SCHEMA_VERSION,
    name:
      options.name?.trim() ||
      (options.sourceTaskId
        ? `Recording ${options.sourceTaskId.slice(0, 8)}`
        : `Manual Recording ${now.slice(11, 19)}`),
    status: 'recording',
    metadata: {
      source: options.source,
      sourceTaskId: options.sourceTaskId,
      durationMs: 0,
      stepCount: 0,
      startUrl: options.startUrl || FALLBACK_PAGE_URL,
      viewport: DEFAULT_VIEWPORT,
      userAgent: DEFAULT_USER_AGENT,
      appVersion: process.env.npm_package_version ?? 'unknown',
      platform: process.platform,
    },
    steps: [],
    privacyManifest: {
      configSnapshot: DEFAULT_PRIVACY_CONFIG,
      redactions: [],
    },
    parameters: [],
    tags: [],
    createdAt: now,
    updatedAt: now,
  };
}

function isRecording(value: unknown): value is Recording {
  if (!isRecord(value)) {
    return false;
  }

  const metadata = value.metadata;
  const privacyManifest = value.privacyManifest;
  const parameters = value.parameters;
  const tags = value.tags;
  const status = value.status;
  const schemaVersion = value.schemaVersion;

  return (
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.description === undefined || typeof value.description === 'string') &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof schemaVersion === 'number' &&
    (status === 'recording' || status === 'completed' || status === 'failed') &&
    isValidRecordingMetadata(metadata) &&
    isValidRecordingSteps(value.steps) &&
    isValidPrivacyManifest(privacyManifest) &&
    isValidRecordingParameters(parameters) &&
    Array.isArray(tags) &&
    tags.length <= MAX_IMPORTED_TAGS &&
    tags.every((tag) => typeof tag === 'string' && tag.length <= 200)
  );
}

function isValidRecordingMetadata(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  const { source, durationMs, stepCount, startUrl, viewport, userAgent, appVersion, platform } =
    value;
  if (source !== 'agent' && source !== 'user' && source !== 'mixed') {
    return false;
  }
  if (
    typeof durationMs !== 'number' ||
    durationMs < 0 ||
    typeof stepCount !== 'number' ||
    stepCount < 0 ||
    typeof startUrl !== 'string' ||
    typeof userAgent !== 'string' ||
    typeof appVersion !== 'string' ||
    typeof platform !== 'string'
  ) {
    return false;
  }

  if (!isRecord(viewport)) {
    return false;
  }

  return (
    typeof viewport.width === 'number' &&
    typeof viewport.height === 'number' &&
    (value.sourceTaskId === undefined || typeof value.sourceTaskId === 'string') &&
    (value.originalRecordingId === undefined || typeof value.originalRecordingId === 'string') &&
    (value.importedFromBundleId === undefined || typeof value.importedFromBundleId === 'string') &&
    (value.importedAt === undefined || typeof value.importedAt === 'string')
  );
}

function isValidPrivacyAnnotation(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.type === 'email' ||
      value.type === 'secret' ||
      value.type === 'url-query' ||
      value.type === 'custom') &&
    typeof value.path === 'string' &&
    typeof value.replacement === 'string'
  );
}

function isValidPrivacyConfig(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    typeof value.recordAgentReasoning === 'boolean' &&
    typeof value.redactEmails === 'boolean' &&
    typeof value.redactSecrets === 'boolean' &&
    typeof value.redactUrlQueryParams === 'boolean' &&
    typeof value.redactAllFormInputs === 'boolean' &&
    typeof value.captureScreenshots === 'boolean' &&
    typeof value.blurAllScreenshots === 'boolean' &&
    typeof value.maxScreenshotWidth === 'number' &&
    typeof value.maxScreenshotHeight === 'number' &&
    Array.isArray(value.customSensitiveKeys) &&
    value.customSensitiveKeys.every((entry) => typeof entry === 'string' && entry.length <= 200)
  );
}

function isValidPrivacyManifest(value: unknown): boolean {
  return (
    isRecord(value) &&
    isValidPrivacyConfig(value.configSnapshot) &&
    Array.isArray(value.redactions) &&
    value.redactions.every(isValidPrivacyAnnotation)
  );
}

function isValidSelectorStrategy(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.type === 'css' ||
      value.type === 'xpath' ||
      value.type === 'text' ||
      value.type === 'aria-label' ||
      value.type === 'aria-role' ||
      value.type === 'test-id' ||
      value.type === 'ref') &&
    typeof value.value === 'string' &&
    value.value.length <= MAX_TEXT_FIELD_LENGTH &&
    typeof value.confidence === 'number'
  );
}

function isValidWaitCondition(value: unknown): boolean {
  return (
    isRecord(value) &&
    (value.type === 'networkIdle' ||
      value.type === 'selectorVisible' ||
      value.type === 'selectorHidden' ||
      value.type === 'timeout' ||
      value.type === 'navigation' ||
      value.type === 'custom') &&
    (value.value === undefined ||
      (typeof value.value === 'string' && value.value.length <= MAX_TEXT_FIELD_LENGTH)) &&
    typeof value.timeoutMs === 'number'
  );
}

function isValidElementSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.attributes) || !isRecord(value.boundingBox)) {
    return false;
  }

  return (
    typeof value.role === 'string' &&
    typeof value.name === 'string' &&
    typeof value.tagName === 'string' &&
    (value.innerText === undefined || typeof value.innerText === 'string') &&
    Object.values(value.attributes).every((entry) => typeof entry === 'string') &&
    typeof value.boundingBox.x === 'number' &&
    typeof value.boundingBox.y === 'number' &&
    typeof value.boundingBox.width === 'number' &&
    typeof value.boundingBox.height === 'number'
  );
}

function isValidRecordingAction(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'navigate':
      return (
        typeof value.url === 'string' &&
        (value.navigationType === 'goto' ||
          value.navigationType === 'back' ||
          value.navigationType === 'forward' ||
          value.navigationType === 'reload')
      );
    case 'click':
      return (
        (value.button === 'left' || value.button === 'right' || value.button === 'middle') &&
        typeof value.clickCount === 'number' &&
        (value.x === undefined || typeof value.x === 'number') &&
        (value.y === undefined || typeof value.y === 'number')
      );
    case 'fill':
      return typeof value.value === 'string' && typeof value.clearFirst === 'boolean';
    case 'type':
      return (
        typeof value.text === 'string' &&
        (value.delay === undefined || typeof value.delay === 'number')
      );
    case 'keypress':
      return (
        typeof value.key === 'string' &&
        Array.isArray(value.modifiers) &&
        value.modifiers.every((entry) => typeof entry === 'string')
      );
    case 'select':
      return (
        Array.isArray(value.values) && value.values.every((entry) => typeof entry === 'string')
      );
    case 'scroll':
      return (
        typeof value.deltaX === 'number' &&
        typeof value.deltaY === 'number' &&
        (value.target === 'viewport' || value.target === 'element')
      );
    case 'hover':
      return true;
    case 'upload':
      return (
        Array.isArray(value.fileNames) &&
        value.fileNames.every((entry) => typeof entry === 'string') &&
        Array.isArray(value.mimeTypes) &&
        value.mimeTypes.every((entry) => typeof entry === 'string')
      );
    case 'wait':
      return typeof value.durationMs === 'number' && isValidWaitCondition(value.condition);
    case 'tool-call':
      return (
        typeof value.toolName === 'string' &&
        (value.outputSummary === undefined || typeof value.outputSummary === 'string')
      );
    default:
      return false;
  }
}

function isValidRecordingStep(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.index === 'number' &&
    typeof value.id === 'string' &&
    typeof value.timestampMs === 'number' &&
    isValidRecordingAction(value.action) &&
    (value.selectors === undefined ||
      (Array.isArray(value.selectors) && value.selectors.every(isValidSelectorStrategy))) &&
    (value.screenshot === undefined ||
      (typeof value.screenshot === 'string' &&
        value.screenshot.length <= MAX_SCREENSHOT_BASE64_LENGTH)) &&
    (value.targetSnapshot === undefined || isValidElementSnapshot(value.targetSnapshot)) &&
    typeof value.pageUrl === 'string' &&
    (value.origin === 'agent' || value.origin === 'user') &&
    (value.privacyAnnotations === undefined ||
      (Array.isArray(value.privacyAnnotations) &&
        value.privacyAnnotations.every(isValidPrivacyAnnotation))) &&
    (value.agentContext === undefined ||
      (isRecord(value.agentContext) &&
        typeof value.agentContext.toolName === 'string' &&
        isRecord(value.agentContext.toolInput) &&
        (value.agentContext.reasoning === undefined ||
          typeof value.agentContext.reasoning === 'string')))
  );
}

function isValidRecordingSteps(value: unknown): value is RecordingStep[] {
  return (
    Array.isArray(value) && value.length <= MAX_IMPORTED_STEPS && value.every(isValidRecordingStep)
  );
}

function isValidRecordingParameter(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.defaultValue === 'string' &&
    (value.type === 'text' ||
      value.type === 'url' ||
      value.type === 'email' ||
      value.type === 'number' ||
      value.type === 'password' ||
      value.type === 'file-path')
  );
}

function isValidRecordingParameters(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.length <= MAX_IMPORTED_PARAMETERS &&
    value.every(isValidRecordingParameter)
  );
}

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
    if (!this.getPrivacyConfig().enabled) {
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
    recording.privacyManifest.configSnapshot = this.getPrivacyConfig();
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
    if (!this.getPrivacyConfig().enabled) {
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
    recording.privacyManifest.configSnapshot = this.getPrivacyConfig();
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

    if (!this.getPrivacyConfig().recordAgentReasoning) {
      active.pendingReasoning = undefined;
      return;
    }

    const scrubbed = scrubUnknown(text, 'reasoning', this.getPrivacyConfig());
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

    const privacyConfig = this.getPrivacyConfig();
    const scrubbedSelectors = input.selectors
      ? scrubUnknown(input.selectors, 'selectors', privacyConfig)
      : { value: undefined, annotations: [] as PrivacyAnnotation[] };
    const safeSelectors = Array.isArray(scrubbedSelectors.value)
      ? (scrubbedSelectors.value as SelectorStrategy[])
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

    const privacyConfig = this.getPrivacyConfig();
    const rawToolInput = isRecord(payload.toolInput) ? payload.toolInput : {};
    const scrubbedToolInput = scrubUnknown(rawToolInput, 'toolInput', privacyConfig);
    const safeToolInput = isRecord(scrubbedToolInput.value) ? scrubbedToolInput.value : {};
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

    const extension = path.extname(filePath).toLowerCase();
    const targetPath =
      extension === '.json' || extension === '.zip'
        ? filePath
        : `${filePath}.accomplish-recording.zip`;

    if (path.extname(targetPath).toLowerCase() === '.json') {
      const exportRecording: Recording = {
        ...recording,
        metadata: {
          ...recording.metadata,
          originalRecordingId: recording.metadata.originalRecordingId ?? recording.id,
        },
      };
      await fs.writeFile(targetPath, JSON.stringify(exportRecording, null, 2), 'utf8');
      return targetPath;
    }

    await fs.writeFile(targetPath, createRecordingBundle(recording));
    return targetPath;
  }

  async importRecording(filePath: string): Promise<Recording> {
    const stat = await fs.stat(filePath);
    if (stat.size > MAX_IMPORT_FILE_BYTES) {
      throw new Error(`Recording import exceeds the ${MAX_IMPORT_FILE_BYTES} byte file size limit`);
    }

    const extension = path.extname(filePath).toLowerCase();
    const parsed =
      extension === '.zip'
        ? parseRecordingBundle(await fs.readFile(filePath))
        : { recording: JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown, manifest: null };
    const imported = parsed.recording as unknown;
    if (!isRecording(imported)) {
      throw new Error('Invalid recording file');
    }

    const originalRecordingId = imported.metadata.originalRecordingId ?? imported.id;
    const importedAt = new Date().toISOString();
    const recording: Recording = {
      ...imported,
      id: crypto.randomUUID(),
      status: imported.status === 'recording' ? 'completed' : imported.status,
      createdAt: importedAt,
      updatedAt: importedAt,
      metadata: {
        ...imported.metadata,
        sourceTaskId: undefined,
        originalRecordingId,
        importedFromBundleId: parsed.manifest?.bundleId,
        importedAt,
      },
    };

    saveRecording(recording);
    log.info(`[RecordingManager] Imported recording from ${filePath}`);
    return recording;
  }
}

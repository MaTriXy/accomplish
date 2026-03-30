import crypto from 'crypto';
import type {
  Recording,
  RecordingAction,
  RecordingSource,
  SelectorStrategy,
  WaitCondition,
} from '../common/types/recording.js';
import { DEFAULT_PRIVACY_CONFIG, RECORDING_SCHEMA_VERSION } from '../common/types/recording.js';
import {
  DEFAULT_USER_AGENT,
  DEFAULT_VIEWPORT,
  FALLBACK_PAGE_URL,
  truncate,
} from './recording-manager-shared.js';

function normalizeToolName(toolName: string): string {
  const knownPrefixes = ['dev-browser-mcp_', 'browser_'];
  for (const prefix of knownPrefixes) {
    if (toolName.startsWith(prefix)) {
      return toolName.slice(prefix.length);
    }
  }
  return toolName;
}

export function buildSelectors(toolInput: Record<string, unknown>): SelectorStrategy[] | undefined {
  const selectors: SelectorStrategy[] = [];

  const pushSelector = (type: SelectorStrategy['type'], key: string, confidence: number): void => {
    if (typeof toolInput[key] === 'string' && toolInput[key].trim()) {
      selectors.push({ type, value: toolInput[key].trim() as string, confidence });
    }
  };

  pushSelector('css', 'selector', 0.95);
  pushSelector('xpath', 'xpath', 0.9);
  pushSelector('ref', 'ref', 0.9);
  pushSelector('text', 'text', 0.75);
  pushSelector('aria-label', 'ariaLabel', 0.8);
  pushSelector('test-id', 'testId', 0.85);

  const role = typeof toolInput.role === 'string' ? toolInput.role.trim() : '';
  const roleNameCandidates = ['name', 'label', 'ariaLabel']
    .map((key) => toolInput[key])
    .filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
  const roleName = roleNameCandidates.find((value) => Boolean(value.trim()));
  if (role) {
    selectors.push({
      type: 'aria-role',
      value: JSON.stringify({ role, name: roleName ?? null }),
      confidence: roleName ? 0.82 : 0.76,
    });
  }

  return selectors.length > 0 ? selectors : undefined;
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is string => typeof entry === 'string');
}

function parseKeyboardShortcut(value: string): { key: string; modifiers: string[] } {
  const segments = value
    .split('+')
    .map((segment) => segment.trim())
    .filter(Boolean);
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

export function inferPageUrl(
  action: RecordingAction,
  toolInput: Record<string, unknown>,
  candidateUrl: string,
): string {
  if (action.type === 'navigate') {
    return action.url;
  }
  return typeof candidateUrl === 'string' && candidateUrl.trim().length > 0
    ? candidateUrl
    : typeof toolInput.url === 'string' && toolInput.url.trim().length > 0
      ? toolInput.url
      : FALLBACK_PAGE_URL;
}

export function inferAction(
  toolName: string,
  toolInput: Record<string, unknown>,
  toolOutput: string,
): RecordingAction {
  const normalizedToolName = normalizeToolName(toolName);

  switch (normalizedToolName) {
    case 'navigate':
    case 'goto':
    case 'browser_navigate':
      return {
        type: 'navigate',
        url: typeof toolInput.url === 'string' ? toolInput.url : FALLBACK_PAGE_URL,
        navigationType: 'goto',
      };
    case 'click':
    case 'browser_click':
      return {
        type: 'click',
        button: 'left',
        clickCount: 1,
      };
    case 'type':
    case 'browser_type':
      return {
        type: 'type',
        text: typeof toolInput.text === 'string' ? toolInput.text : '',
      };
    case 'fill':
    case 'browser_fill':
      return {
        type: 'fill',
        value: typeof toolInput.value === 'string' ? toolInput.value : '',
        clearFirst: true,
      };
    case 'select':
    case 'browser_select':
      return {
        type: 'select',
        values:
          toStringArray(toolInput.values).length > 0
            ? toStringArray(toolInput.values)
            : typeof toolInput.value === 'string'
              ? [toolInput.value]
              : [],
      };
    case 'hover':
    case 'browser_hover':
      return { type: 'hover' };
    case 'scroll':
    case 'browser_scroll':
      return {
        type: 'scroll',
        deltaX: typeof toolInput.deltaX === 'number' ? toolInput.deltaX : 0,
        deltaY: typeof toolInput.deltaY === 'number' ? toolInput.deltaY : 0,
        target:
          typeof toolInput.target === 'string' && toolInput.target === 'element'
            ? 'element'
            : 'viewport',
      };
    case 'press_key':
    case 'browser_press_key': {
      const shortcut = typeof toolInput.key === 'string' ? toolInput.key : '';
      const parsed = parseKeyboardShortcut(shortcut);
      return {
        type: 'keypress',
        key: parsed.key,
        modifiers: parsed.modifiers,
      };
    }
    case 'wait':
    case 'browser_wait': {
      const conditionType =
        typeof toolInput.conditionType === 'string' ? toolInput.conditionType : 'timeout';
      const waitConditionType: WaitCondition['type'] =
        conditionType === 'networkIdle' ||
        conditionType === 'selectorVisible' ||
        conditionType === 'selectorHidden' ||
        conditionType === 'timeout' ||
        conditionType === 'navigation' ||
        conditionType === 'custom'
          ? conditionType
          : 'timeout';
      return {
        type: 'wait',
        durationMs: typeof toolInput.durationMs === 'number' ? toolInput.durationMs : 500,
        condition: {
          type: waitConditionType,
          value:
            typeof toolInput.conditionValue === 'string' ? toolInput.conditionValue : undefined,
          timeoutMs:
            typeof toolInput.timeoutMs === 'number'
              ? toolInput.timeoutMs
              : typeof toolInput.durationMs === 'number'
                ? toolInput.durationMs
                : 500,
        },
      };
    }
    case 'upload':
    case 'browser_upload':
      return {
        type: 'upload',
        fileNames: toStringArray(toolInput.fileNames),
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

export function createEmptyRecording(taskId: string, name?: string): Recording {
  return createRecording({
    source: 'agent',
    name,
    sourceTaskId: taskId,
    startUrl: FALLBACK_PAGE_URL,
  });
}

export function createRecording(options: {
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
    createdAt: now,
    updatedAt: now,
    status: 'recording',
    tags: [],
    steps: [],
    parameters: [],
    metadata: {
      source: options.source,
      sourceTaskId: options.sourceTaskId,
      startUrl: options.startUrl || FALLBACK_PAGE_URL,
      stepCount: 0,
      durationMs: 0,
      viewport: { ...DEFAULT_VIEWPORT },
      userAgent: DEFAULT_USER_AGENT,
      appVersion: process.env.npm_package_version ?? 'unknown',
      platform: process.platform,
    },
    privacyManifest: {
      configSnapshot: {
        ...DEFAULT_PRIVACY_CONFIG,
        customSensitiveKeys: [...DEFAULT_PRIVACY_CONFIG.customSensitiveKeys],
      },
      redactions: [],
    },
  };
}

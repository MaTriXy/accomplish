import type { RecordingAction, WaitCondition } from '../common/types/recording.js';
import { FALLBACK_PAGE_URL, truncate } from './recording-manager-shared.js';

function normalizeToolName(toolName: string): string {
  const knownPrefixes = ['dev-browser-mcp_', 'browser_'];
  for (const prefix of knownPrefixes) {
    if (toolName.startsWith(prefix)) {
      return toolName.slice(prefix.length);
    }
  }
  return toolName;
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

function inferWaitConditionType(value: unknown): WaitCondition['type'] {
  if (typeof value !== 'string') {
    return 'timeout';
  }

  if (
    value === 'networkIdle' ||
    value === 'selectorVisible' ||
    value === 'selectorHidden' ||
    value === 'timeout' ||
    value === 'navigation' ||
    value === 'custom'
  ) {
    return value;
  }

  return 'timeout';
}

function inferSelectValues(toolInput: Record<string, unknown>): string[] {
  const values = toStringArray(toolInput.values);
  if (values.length > 0) {
    return values;
  }
  if (typeof toolInput.value === 'string') {
    return [toolInput.value];
  }
  return [];
}

function inferScrollTarget(toolInput: Record<string, unknown>): 'viewport' | 'element' {
  if (typeof toolInput.target === 'string' && toolInput.target === 'element') {
    return 'element';
  }
  return 'viewport';
}

function inferWaitTimeout(toolInput: Record<string, unknown>): number {
  if (typeof toolInput.timeoutMs === 'number') {
    return toolInput.timeoutMs;
  }
  if (typeof toolInput.durationMs === 'number') {
    return toolInput.durationMs;
  }
  return 500;
}

export function inferPageUrl(
  action: RecordingAction,
  toolInput: Record<string, unknown>,
  candidateUrl: string,
): string {
  if (action.type === 'navigate') {
    return action.url;
  }

  if (typeof candidateUrl === 'string' && candidateUrl.trim().length > 0) {
    return candidateUrl;
  }

  if (typeof toolInput.url === 'string' && toolInput.url.trim().length > 0) {
    return toolInput.url;
  }

  return FALLBACK_PAGE_URL;
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
        values: inferSelectValues(toolInput),
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
        target: inferScrollTarget(toolInput),
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
    case 'browser_wait':
      return {
        type: 'wait',
        durationMs: typeof toolInput.durationMs === 'number' ? toolInput.durationMs : 500,
        condition: {
          type: inferWaitConditionType(toolInput.conditionType),
          value:
            typeof toolInput.conditionValue === 'string' ? toolInput.conditionValue : undefined,
          timeoutMs: inferWaitTimeout(toolInput),
        },
      };
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

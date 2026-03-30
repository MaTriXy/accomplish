import type { RecordingAction } from '@accomplish_ai/agent-core/common';
import type { ManualRawEvent, ManualStepInput } from './manual-recording-types';

function isLikelyLocalAddress(value: string): boolean {
  return /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d+)?(?:\/|$)/i.test(value);
}

export function normalizeStartUrl(startUrl?: string): string | undefined {
  const trimmed = startUrl?.trim();
  if (!trimmed) {
    return undefined;
  }

  const hasProtocol = /^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed);
  const candidate = hasProtocol
    ? trimmed
    : `${isLikelyLocalAddress(trimmed) ? 'http' : 'https'}://${trimmed}`;

  try {
    return new URL(candidate).toString();
  } catch {
    throw new Error(`Invalid start URL: ${trimmed}`);
  }
}

export function isMissingSessionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('session with given id not found') ||
    message.includes('session closed') ||
    message.includes('target closed')
  );
}

function mapMouseButton(button?: number): 'left' | 'right' | 'middle' {
  if (button === 2) {
    return 'right';
  }
  if (button === 1) {
    return 'middle';
  }
  return 'left';
}

export function mapManualEventToStepInput(event: ManualRawEvent): ManualStepInput | null {
  switch (event.kind) {
    case 'click':
      return {
        action: {
          type: 'click',
          button: mapMouseButton(event.button),
          clickCount: Math.max(1, event.clickCount ?? 1),
          x: event.x,
          y: event.y,
        },
        selectors: event.selectors,
        pageUrl: event.pageUrl,
      };
    case 'fill':
      return event.value === undefined
        ? null
        : {
            action: {
              type: 'fill',
              value: event.value,
              clearFirst: true,
            },
            selectors: event.selectors,
            pageUrl: event.pageUrl,
          };
    case 'select':
      return event.value === undefined
        ? null
        : {
            action: {
              type: 'select',
              values: [event.value],
            },
            selectors: event.selectors,
            pageUrl: event.pageUrl,
          };
    case 'keypress':
      return event.key
        ? {
            action: {
              type: 'keypress',
              key: event.key,
              modifiers: event.modifiers ?? [],
            },
            selectors: event.selectors,
            pageUrl: event.pageUrl,
          }
        : null;
    case 'scroll':
      return {
        action: {
          type: 'scroll',
          deltaX: event.deltaX ?? 0,
          deltaY: event.deltaY ?? 0,
          target: event.selectors?.length ? 'element' : 'viewport',
        },
        selectors: event.selectors,
        pageUrl: event.pageUrl,
      };
    case 'upload': {
      if (!event.value) {
        return null;
      }
      try {
        const parsed = JSON.parse(event.value) as {
          fileNames?: string[];
          mimeTypes?: string[];
        };
        return {
          action: {
            type: 'upload',
            fileNames: Array.isArray(parsed.fileNames) ? parsed.fileNames : [],
            mimeTypes: Array.isArray(parsed.mimeTypes) ? parsed.mimeTypes : [],
          },
          selectors: event.selectors,
          pageUrl: event.pageUrl,
        };
      } catch {
        return null;
      }
    }
    default:
      return null;
  }
}

export function shouldCaptureScreenshot(action: RecordingAction): boolean {
  return (
    action.type === 'navigate' ||
    action.type === 'click' ||
    action.type === 'fill' ||
    action.type === 'select'
  );
}

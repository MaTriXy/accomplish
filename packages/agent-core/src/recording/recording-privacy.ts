import crypto from 'crypto';
import type {
  PrivacyAnnotation,
  PrivacyConfig,
  RecordingAction,
  SelectorStrategy,
} from '../common/types/recording.js';
import { isRecord } from './recording-manager-shared.js';

type SensitiveFieldKind = 'email' | 'secret' | 'custom';

export function scrubString(
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

export function scrubUrl(
  value: string,
  config: PrivacyConfig,
): { value: string; annotations: PrivacyAnnotation[] } {
  if (!config.enabled || !config.redactUrlQueryParams) {
    return { value, annotations: [] };
  }

  try {
    const url = new URL(value);
    const annotations: PrivacyAnnotation[] = [];
    const sensitiveKeys = new Set([
      'token',
      'auth',
      'password',
      'pass',
      'session',
      ...config.customSensitiveKeys.map((key) => key.toLowerCase()),
    ]);

    for (const [key] of url.searchParams.entries()) {
      if (sensitiveKeys.has(key.toLowerCase())) {
        url.searchParams.set(key, '[REDACTED]');
        annotations.push({ type: 'url-query', path: key, replacement: '[REDACTED]' });
      }
    }

    return { value: url.toString(), annotations };
  } catch {
    return scrubString(value, 'url', config);
  }
}

export function scrubUnknown(
  value: unknown,
  pathLabel: string,
  config: PrivacyConfig,
): { value: unknown; annotations: PrivacyAnnotation[] } {
  if (typeof value === 'string') {
    return scrubString(value, pathLabel, config);
  }

  if (Array.isArray(value)) {
    const nextAnnotations: PrivacyAnnotation[] = [];
    const nextValue = value.map((entry, index) => {
      const scrubbed = scrubUnknown(entry, `${pathLabel}[${index}]`, config);
      nextAnnotations.push(...scrubbed.annotations);
      return scrubbed.value;
    });
    return { value: nextValue, annotations: nextAnnotations };
  }

  if (isRecord(value)) {
    const nextAnnotations: PrivacyAnnotation[] = [];
    const nextValue: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      const scrubbed = scrubUnknown(entry, `${pathLabel}.${key}`, config);
      nextAnnotations.push(...scrubbed.annotations);
      nextValue[key] = scrubbed.value;
    }
    return { value: nextValue, annotations: nextAnnotations };
  }

  return { value, annotations: [] };
}

export function normalizeSelectorHints(selectors?: SelectorStrategy[]): string[] {
  if (!selectors?.length) {
    return [];
  }

  return selectors.flatMap((selector) => {
    if (selector.type === 'aria-role') {
      try {
        const parsed = JSON.parse(selector.value) as { role?: string; name?: string };
        return [parsed.role, parsed.name, selector.value].filter(Boolean) as string[];
      } catch {
        return [selector.value];
      }
    }

    return [selector.value];
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
    'token',
    'auth',
    'password',
    'pass',
    'session',
    'secret',
    'api',
    'bearer',
    'otp',
    'pin',
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
    return '[EMAIL_REDACTED]';
  }
  if (kind === 'custom') {
    return '[REDACTED]';
  }
  return '[SECRET_REDACTED]';
}

export function scrubAction(
  action: RecordingAction,
  selectors: SelectorStrategy[] | undefined,
  config: PrivacyConfig,
): { action: RecordingAction; annotations: PrivacyAnnotation[] } {
  const scrubbed = scrubUnknown(action, 'action', config);
  const safeAction = scrubbed.value as RecordingAction;
  const annotations = [...scrubbed.annotations];
  const sensitiveKind = inferSensitiveFieldKind(safeAction, selectors, config);

  if (!sensitiveKind) {
    return { action: safeAction, annotations };
  }

  if (safeAction.type === 'fill') {
    safeAction.value = redactFieldValue(safeAction.value, sensitiveKind);
    annotations.push({
      type: sensitiveKind,
      path: 'action.value',
      replacement: safeAction.value,
    });
  }

  if (safeAction.type === 'select') {
    safeAction.values = safeAction.values.map((value) => redactFieldValue(value, sensitiveKind));
    annotations.push({
      type: sensitiveKind,
      path: 'action.values',
      replacement: safeAction.values.join(','),
    });
  }

  return { action: safeAction, annotations };
}

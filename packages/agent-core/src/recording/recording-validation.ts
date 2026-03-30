import type {
  ElementSnapshot,
  PrivacyAnnotation,
  PrivacyConfig,
  PrivacyManifest,
  Recording,
  RecordingAction,
  RecordingMetadata,
  RecordingParameter,
  RecordingStep,
  SelectorStrategy,
  WaitCondition,
} from '../common/types/recording.js';
import {
  MAX_IMPORTED_PARAMETERS,
  MAX_IMPORTED_STEPS,
  MAX_IMPORTED_TAGS,
  MAX_SCREENSHOT_BASE64_LENGTH,
  MAX_TEXT_FIELD_LENGTH,
  isRecord,
} from './recording-manager-shared.js';

function isValidRecordingMetadata(value: unknown): value is RecordingMetadata {
  if (!isRecord(value)) {
    return false;
  }

  if (typeof value.source !== 'string') {
    return false;
  }

  const sourceTaskId = value.sourceTaskId;
  if (sourceTaskId !== undefined && typeof sourceTaskId !== 'string') {
    return false;
  }

  const viewport = value.viewport;
  if (!isRecord(viewport)) {
    return false;
  }

  return (
    typeof value.startUrl === 'string' &&
    typeof value.stepCount === 'number' &&
    typeof value.durationMs === 'number' &&
    typeof viewport.width === 'number' &&
    typeof viewport.height === 'number' &&
    typeof value.userAgent === 'string'
  );
}

function isValidPrivacyAnnotation(value: unknown): value is PrivacyAnnotation {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.path === 'string' &&
    typeof value.replacement === 'string'
  );
}

function isValidPrivacyConfig(value: unknown): value is PrivacyConfig {
  return (
    isRecord(value) &&
    typeof value.enabled === 'boolean' &&
    typeof value.redactEmails === 'boolean' &&
    typeof value.redactSecrets === 'boolean' &&
    typeof value.redactUrlQueryParams === 'boolean' &&
    Array.isArray(value.customSensitiveKeys) &&
    value.customSensitiveKeys.every((entry) => typeof entry === 'string') &&
    typeof value.recordAgentReasoning === 'boolean' &&
    typeof value.redactAllFormInputs === 'boolean' &&
    typeof value.captureScreenshots === 'boolean' &&
    typeof value.blurAllScreenshots === 'boolean' &&
    typeof value.maxScreenshotWidth === 'number' &&
    typeof value.maxScreenshotHeight === 'number'
  );
}

function isValidPrivacyManifest(value: unknown): value is PrivacyManifest {
  return (
    isRecord(value) &&
    isValidPrivacyConfig(value.configSnapshot) &&
    Array.isArray(value.redactions) &&
    value.redactions.every(isValidPrivacyAnnotation)
  );
}

function isValidSelectorStrategy(value: unknown): value is SelectorStrategy {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    typeof value.value === 'string' &&
    typeof value.confidence === 'number'
  );
}

function isValidWaitCondition(value: unknown): value is WaitCondition {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    (value.value === undefined || typeof value.value === 'string')
  );
}

function isValidElementSnapshot(value: unknown): value is ElementSnapshot {
  if (!isRecord(value) || !isRecord(value.attributes) || !isRecord(value.boundingBox)) {
    return false;
  }

  return (
    typeof value.role === 'string' &&
    typeof value.name === 'string' &&
    typeof value.tagName === 'string' &&
    (value.innerText === undefined || typeof value.innerText === 'string') &&
    typeof value.boundingBox.x === 'number' &&
    typeof value.boundingBox.y === 'number' &&
    typeof value.boundingBox.width === 'number' &&
    typeof value.boundingBox.height === 'number'
  );
}

function isValidRecordingAction(value: unknown): value is RecordingAction {
  if (!isRecord(value) || typeof value.type !== 'string') {
    return false;
  }

  switch (value.type) {
    case 'navigate':
      return typeof value.url === 'string' && typeof value.navigationType === 'string';
    case 'click':
      return (
        typeof value.button === 'string' &&
        typeof value.clickCount === 'number' &&
        (value.x === undefined || typeof value.x === 'number') &&
        (value.y === undefined || typeof value.y === 'number')
      );
    case 'type':
      return typeof value.text === 'string';
    case 'fill':
      return typeof value.value === 'string' && typeof value.clearFirst === 'boolean';
    case 'select':
      return (
        Array.isArray(value.values) && value.values.every((entry) => typeof entry === 'string')
      );
    case 'hover':
      return true;
    case 'scroll':
      return (
        typeof value.deltaX === 'number' &&
        typeof value.deltaY === 'number' &&
        typeof value.target === 'string'
      );
    case 'wait':
      return typeof value.durationMs === 'number' && isValidWaitCondition(value.condition);
    case 'keypress':
      return (
        typeof value.key === 'string' &&
        Array.isArray(value.modifiers) &&
        value.modifiers.every((entry) => typeof entry === 'string')
      );
    case 'tool-call':
      return (
        typeof value.toolName === 'string' &&
        (value.outputSummary === undefined || typeof value.outputSummary === 'string')
      );
    case 'upload':
      return (
        Array.isArray(value.fileNames) &&
        value.fileNames.every((entry) => typeof entry === 'string') &&
        Array.isArray(value.mimeTypes) &&
        value.mimeTypes.every((entry) => typeof entry === 'string')
      );
    default:
      return false;
  }
}

function isValidRecordingStep(value: unknown): value is RecordingStep {
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
    (value.privacyAnnotations === undefined ||
      (Array.isArray(value.privacyAnnotations) &&
        value.privacyAnnotations.every(isValidPrivacyAnnotation))) &&
    typeof value.origin === 'string'
  );
}

function isValidRecordingSteps(value: unknown): value is RecordingStep[] {
  return (
    Array.isArray(value) && value.length <= MAX_IMPORTED_STEPS && value.every(isValidRecordingStep)
  );
}

function isValidRecordingParameter(value: unknown): value is RecordingParameter {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    typeof value.description === 'string' &&
    typeof value.required === 'boolean' &&
    (value.defaultValue === undefined || typeof value.defaultValue === 'string')
  );
}

function isValidRecordingParameters(value: unknown): value is RecordingParameter[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_IMPORTED_PARAMETERS &&
    value.every(isValidRecordingParameter)
  );
}

export function isRecording(value: unknown): value is Recording {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.schemaVersion === 'number' &&
    typeof value.name === 'string' &&
    value.name.length <= MAX_TEXT_FIELD_LENGTH &&
    (value.description === undefined ||
      (typeof value.description === 'string' &&
        value.description.length <= MAX_TEXT_FIELD_LENGTH)) &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string' &&
    typeof value.status === 'string' &&
    Array.isArray(value.tags) &&
    value.tags.length <= MAX_IMPORTED_TAGS &&
    value.tags.every((entry) => typeof entry === 'string') &&
    isValidRecordingSteps(value.steps) &&
    isValidRecordingParameters(value.parameters) &&
    isValidRecordingMetadata(value.metadata) &&
    isValidPrivacyManifest(value.privacyManifest)
  );
}

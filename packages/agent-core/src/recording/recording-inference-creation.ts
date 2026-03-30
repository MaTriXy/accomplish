import crypto from 'crypto';
import type { Recording, RecordingSource } from '../common/types/recording.js';
import { DEFAULT_PRIVACY_CONFIG, RECORDING_SCHEMA_VERSION } from '../common/types/recording.js';
import {
  DEFAULT_USER_AGENT,
  DEFAULT_VIEWPORT,
  FALLBACK_PAGE_URL,
} from './recording-manager-shared.js';

function buildRecordingName(
  source: RecordingSource,
  sourceTaskId: string | undefined,
  providedName: string | undefined,
  now: string,
): string {
  const trimmedName = providedName?.trim();
  if (trimmedName) {
    return trimmedName;
  }

  if (sourceTaskId) {
    return `Recording ${sourceTaskId.slice(0, 8)}`;
  }

  if (source === 'user') {
    return `Manual Recording ${now.slice(11, 19)}`;
  }

  return `Recording ${now.slice(11, 19)}`;
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
    name: buildRecordingName(options.source, options.sourceTaskId, options.name, now),
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

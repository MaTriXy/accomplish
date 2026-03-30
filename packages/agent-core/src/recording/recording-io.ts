import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import type { Recording } from '../common/types/recording.js';
import { createRecordingBundle, parseRecordingBundle } from './recording-bundle.js';
import { isRecording } from './recording-validation.js';
import { MAX_IMPORT_FILE_BYTES, truncate } from './recording-manager-shared.js';

function sanitizeFileNameSegment(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'recording';
}

function formatFileTimestamp(value: string): string {
  return value.replace(/[:.]/g, '-');
}

export function buildExportBaseName(recording: Recording): string {
  return `${sanitizeFileNameSegment(recording.name)}-${formatFileTimestamp(
    recording.createdAt,
  )}-${recording.id.slice(0, 8)}`;
}

export async function exportRecordingToFile(
  recording: Recording,
  filePath: string,
): Promise<string> {
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

export async function importRecordingFromFile(
  filePath: string,
): Promise<{ recording: Recording; bundleId?: string }> {
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
    throw new Error(`Invalid recording file: ${truncate(filePath, 120)}`);
  }

  const originalRecordingId = imported.metadata.originalRecordingId ?? imported.id;
  const importedAt = new Date().toISOString();
  return {
    bundleId: parsed.manifest?.bundleId,
    recording: {
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
    },
  };
}

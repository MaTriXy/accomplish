import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { Recording } from '../../common/types/recording.js';
import { getDatabasePath } from '../database.js';

const RECORDING_PAYLOADS_DIRNAME = '.recordings';
const RECORDING_PAYLOAD_FILENAME = 'recording.json';

function getRecordingPayloadRoot(): string {
  const databasePath = getDatabasePath();
  const storageRoot = databasePath ? path.dirname(databasePath) : process.cwd();
  return path.join(storageRoot, RECORDING_PAYLOADS_DIRNAME);
}

function getRecordingPayloadDirectory(recordingId: string): string {
  return path.join(getRecordingPayloadRoot(), recordingId);
}

function getRecordingPayloadAbsolutePath(recordingId: string): string {
  return path.join(getRecordingPayloadDirectory(recordingId), RECORDING_PAYLOAD_FILENAME);
}

export function buildRecordingPayloadRelativePath(recordingId: string): string {
  return path.join(RECORDING_PAYLOADS_DIRNAME, recordingId, RECORDING_PAYLOAD_FILENAME);
}

export function resolveRecordingPayloadPath(relativePath: string): string {
  const databasePath = getDatabasePath();
  const storageRoot = databasePath ? path.dirname(databasePath) : process.cwd();
  return path.join(storageRoot, relativePath);
}

export function serializeRecordingPayload(recording: Recording): string {
  return JSON.stringify(recording, null, 2);
}

export function computePayloadSha256(payload: string | Buffer): string {
  return crypto.createHash('sha256').update(payload).digest('hex');
}

export function writeRecordingPayload(recording: Recording): {
  payloadPath: string;
  payloadSha256: string;
  payloadSize: number;
} {
  const payload = serializeRecordingPayload(recording);
  const payloadPath = buildRecordingPayloadRelativePath(recording.id);
  const absolutePath = getRecordingPayloadAbsolutePath(recording.id);
  const directory = path.dirname(absolutePath);
  const tempPath = `${absolutePath}.tmp`;

  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(tempPath, payload, 'utf8');
  fs.renameSync(tempPath, absolutePath);

  return {
    payloadPath,
    payloadSha256: computePayloadSha256(payload),
    payloadSize: Buffer.byteLength(payload, 'utf8'),
  };
}

export function readRecordingPayload(relativePath: string): {
  payload: string;
  payloadSha256: string;
  payloadSize: number;
} {
  const absolutePath = resolveRecordingPayloadPath(relativePath);
  const payload = fs.readFileSync(absolutePath, 'utf8');
  return {
    payload,
    payloadSha256: computePayloadSha256(payload),
    payloadSize: Buffer.byteLength(payload, 'utf8'),
  };
}

export function deleteRecordingPayload(recordingId: string, relativePath?: string | null): void {
  const absolutePath = relativePath
    ? resolveRecordingPayloadPath(relativePath)
    : getRecordingPayloadAbsolutePath(recordingId);
  const directory = path.dirname(absolutePath);

  if (fs.existsSync(directory)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

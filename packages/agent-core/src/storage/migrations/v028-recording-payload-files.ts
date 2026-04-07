import fs from 'fs';
import path from 'path';
import type { Database } from 'better-sqlite3';
import type { Recording } from '../../common/types/recording.js';
import {
  buildRecordingPayloadRelativePath,
  computePayloadSha256,
  resolveRecordingPayloadPath,
} from '../repositories/recording-payloads.js';

interface RecordingMigrationRow {
  id: string;
  data: string;
}

const EXTERNALIZED_RECORDING_DATA = '{"externalized":true}';

function hasColumn(db: Database, tableName: string, columnName: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function addColumnIfMissing(db: Database, tableName: string, columnDefinition: string): void {
  const columnName = columnDefinition.trim().split(/\s+/)[0];
  if (!hasColumn(db, tableName, columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnDefinition}`);
  }
}

function writePayloadFile(
  recordingId: string,
  payload: string,
): {
  payloadPath: string;
  payloadSha256: string;
  payloadSize: number;
} {
  const payloadPath = buildRecordingPayloadRelativePath(recordingId);
  const absolutePath = resolveRecordingPayloadPath(payloadPath);
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

function inferMetadata(payload: string): { stepCount: number; durationMs: number } {
  const parsed = JSON.parse(payload) as Partial<Recording>;
  const stepCount =
    typeof parsed.metadata?.stepCount === 'number'
      ? parsed.metadata.stepCount
      : Array.isArray(parsed.steps)
        ? parsed.steps.length
        : 0;
  const durationMs =
    typeof parsed.metadata?.durationMs === 'number'
      ? parsed.metadata.durationMs
      : Array.isArray(parsed.steps) && parsed.steps.length > 0
        ? (parsed.steps[parsed.steps.length - 1]?.timestampMs ?? 0)
        : 0;
  return { stepCount, durationMs };
}

export const migration = {
  version: 28,
  up: (db: Database) => {
    addColumnIfMissing(db, 'recordings', 'step_count INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'recordings', 'duration_ms INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing(db, 'recordings', 'payload_path TEXT');
    addColumnIfMissing(db, 'recordings', 'payload_sha256 TEXT');
    addColumnIfMissing(db, 'recordings', 'payload_size INTEGER NOT NULL DEFAULT 0');

    const rows = db.prepare('SELECT id, data FROM recordings').all() as RecordingMigrationRow[];

    const updateRow = db.prepare(`
      UPDATE recordings
      SET
        step_count = ?,
        duration_ms = ?,
        payload_path = ?,
        payload_sha256 = ?,
        payload_size = ?,
        data = ?
      WHERE id = ?
    `);

    for (const row of rows) {
      const payload = row.data;
      if (payload === EXTERNALIZED_RECORDING_DATA) {
        continue;
      }

      const { stepCount, durationMs } = inferMetadata(payload);
      const payloadFile = writePayloadFile(row.id, payload);

      updateRow.run(
        stepCount,
        durationMs,
        payloadFile.payloadPath,
        payloadFile.payloadSha256,
        payloadFile.payloadSize,
        EXTERNALIZED_RECORDING_DATA,
        row.id,
      );
    }
  },
};

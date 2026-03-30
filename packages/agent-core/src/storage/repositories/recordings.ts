import { getDatabase } from '../database.js';
import type {
  PrivacyConfig,
  Recording,
  RecordingStatus,
  ReplayRun,
  ReplayStatus,
} from '../../common/types/recording.js';
import { DEFAULT_PRIVACY_CONFIG } from '../../common/types/recording.js';
import {
  deleteRecordingPayload,
  readRecordingPayload,
  serializeRecordingPayload,
  writeRecordingPayload,
} from './recording-payloads.js';

interface RecordingRow {
  id: string;
  name: string;
  description: string | null;
  source: string;
  source_task_id: string | null;
  status: string;
  created_at: string;
  updated_at: string;
  step_count: number;
  duration_ms: number;
  payload_path: string | null;
  payload_sha256: string | null;
  payload_size: number;
  data: string;
}

interface ReplayRunRow {
  id: string;
  recording_id: string;
  status: string;
  started_at: string;
  updated_at: string;
  completed_at: string | null;
  data: string;
}

const MAX_RECORDING_STORAGE_BYTES = 25 * 1024 * 1024;
const MAX_REPLAY_RUN_STORAGE_BYTES = 2 * 1024 * 1024;
const EXTERNALIZED_RECORDING_DATA = '{"externalized":true}';

function buildRecordingSummary(row: RecordingRow): Recording {
  return {
    id: row.id,
    schemaVersion: 1,
    name: row.name,
    description: row.description ?? undefined,
    status: row.status as RecordingStatus,
    metadata: {
      source: row.source as Recording['metadata']['source'],
      sourceTaskId: row.source_task_id ?? undefined,
      durationMs: row.duration_ms,
      stepCount: row.step_count,
      startUrl: 'about:blank',
      viewport: { width: 1280, height: 720 },
      userAgent: 'Accomplish Recording',
      appVersion: 'unknown',
      platform: process.platform,
    },
    steps: [],
    privacyManifest: {
      configSnapshot: DEFAULT_PRIVACY_CONFIG,
      redactions: [],
    },
    parameters: [],
    tags: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseRecordingRow(row: RecordingRow): Recording {
  const parsed = readRecordingPayloadForRow(row);

  return {
    ...parsed,
    id: row.id,
    name: row.name,
    description: row.description ?? parsed.description,
    status: row.status as RecordingStatus,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: {
      ...parsed.metadata,
      source: row.source as Recording['metadata']['source'],
      sourceTaskId: row.source_task_id ?? parsed.metadata.sourceTaskId,
      durationMs: row.duration_ms,
      stepCount: row.step_count,
    },
  };
}

function readRecordingPayloadForRow(row: RecordingRow): Recording {
  if (row.payload_path) {
    const payload = readRecordingPayload(row.payload_path);
    if (row.payload_sha256 && payload.payloadSha256 !== row.payload_sha256) {
      throw new Error(`Recording payload checksum mismatch for ${row.id}`);
    }
    if (row.payload_size > 0 && payload.payloadSize !== row.payload_size) {
      throw new Error(`Recording payload size mismatch for ${row.id}`);
    }
    return JSON.parse(payload.payload) as Recording;
  }

  return JSON.parse(row.data) as Recording;
}

function parseReplayRunRow(row: ReplayRunRow): ReplayRun {
  const parsed = JSON.parse(row.data) as ReplayRun;

  return {
    ...parsed,
    id: row.id,
    recordingId: row.recording_id,
    status: row.status as ReplayStatus,
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? parsed.completedAt,
  };
}

export function listRecordings(): Recording[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT
          id,
          name,
          description,
          source,
          source_task_id,
          status,
          created_at,
          updated_at,
          step_count,
          duration_ms,
          payload_path,
          payload_sha256,
          payload_size,
          data
        FROM recordings
        ORDER BY datetime(updated_at) DESC, rowid DESC
      `,
    )
    .all() as RecordingRow[];

  return rows.map(buildRecordingSummary);
}

export function getRecording(id: string): Recording | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          name,
          description,
          source,
          source_task_id,
          status,
          created_at,
          updated_at,
          step_count,
          duration_ms,
          payload_path,
          payload_sha256,
          payload_size,
          data
        FROM recordings
        WHERE id = ?
      `,
    )
    .get(id) as RecordingRow | undefined;

  return row ? parseRecordingRow(row) : null;
}

export function getActiveRecordingForTask(taskId: string): Recording | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT
          id,
          name,
          description,
          source,
          source_task_id,
          status,
          created_at,
          updated_at,
          step_count,
          duration_ms,
          payload_path,
          payload_sha256,
          payload_size,
          data
        FROM recordings
        WHERE source_task_id = ? AND status = 'recording'
        ORDER BY datetime(updated_at) DESC, rowid DESC
        LIMIT 1
      `,
    )
    .get(taskId) as RecordingRow | undefined;

  return row ? parseRecordingRow(row) : null;
}

export function saveRecording(recording: Recording): void {
  const db = getDatabase();
  const serializedPayload = serializeRecordingPayload(recording);
  const serializedSize = Buffer.byteLength(serializedPayload, 'utf8');
  if (serializedSize > MAX_RECORDING_STORAGE_BYTES) {
    throw new Error(
      `Recording ${recording.id} exceeds the ${MAX_RECORDING_STORAGE_BYTES} byte storage limit`,
    );
  }
  const payloadFile = writeRecordingPayload(recording);

  db.prepare(
    `
      INSERT INTO recordings (
        id,
        name,
        description,
        source,
        source_task_id,
        status,
        created_at,
        updated_at,
        step_count,
        duration_ms,
        payload_path,
        payload_sha256,
        payload_size,
        data
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        description = excluded.description,
        source = excluded.source,
        source_task_id = excluded.source_task_id,
        status = excluded.status,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        step_count = excluded.step_count,
        duration_ms = excluded.duration_ms,
        payload_path = excluded.payload_path,
        payload_sha256 = excluded.payload_sha256,
        payload_size = excluded.payload_size,
        data = excluded.data
    `,
  ).run(
    recording.id,
    recording.name,
    recording.description ?? null,
    recording.metadata.source,
    recording.metadata.sourceTaskId ?? null,
    recording.status,
    recording.createdAt,
    recording.updatedAt,
    recording.metadata.stepCount,
    recording.metadata.durationMs,
    payloadFile.payloadPath,
    payloadFile.payloadSha256,
    payloadFile.payloadSize,
    EXTERNALIZED_RECORDING_DATA,
  );
}

export function deleteRecording(id: string): void {
  const db = getDatabase();
  const row = db.prepare('SELECT payload_path FROM recordings WHERE id = ?').get(id) as
    | { payload_path: string | null }
    | undefined;

  deleteRecordingPayload(id, row?.payload_path ?? null);
  db.prepare('DELETE FROM recordings WHERE id = ?').run(id);
}

export function listReplayRunsForRecording(recordingId: string): ReplayRun[] {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT id, recording_id, status, started_at, updated_at, completed_at, data
        FROM replay_runs
        WHERE recording_id = ?
        ORDER BY datetime(updated_at) DESC, rowid DESC
      `,
    )
    .all(recordingId) as ReplayRunRow[];

  return rows.map(parseReplayRunRow);
}

export function getReplayRun(id: string): ReplayRun | null {
  const db = getDatabase();
  const row = db
    .prepare(
      `
        SELECT id, recording_id, status, started_at, updated_at, completed_at, data
        FROM replay_runs
        WHERE id = ?
      `,
    )
    .get(id) as ReplayRunRow | undefined;

  return row ? parseReplayRunRow(row) : null;
}

export function saveReplayRun(run: ReplayRun): void {
  const db = getDatabase();
  const serialized = JSON.stringify(run);
  const serializedSize = Buffer.byteLength(serialized, 'utf8');
  if (serializedSize > MAX_REPLAY_RUN_STORAGE_BYTES) {
    throw new Error(
      `Replay run ${run.id} exceeds the ${MAX_REPLAY_RUN_STORAGE_BYTES} byte storage limit`,
    );
  }

  db.prepare(
    `
      INSERT INTO replay_runs (
        id,
        recording_id,
        status,
        started_at,
        updated_at,
        completed_at,
        data
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        recording_id = excluded.recording_id,
        status = excluded.status,
        started_at = excluded.started_at,
        updated_at = excluded.updated_at,
        completed_at = excluded.completed_at,
        data = excluded.data
    `,
  ).run(
    run.id,
    run.recordingId,
    run.status,
    run.startedAt,
    run.updatedAt,
    run.completedAt ?? null,
    serialized,
  );
}

export function markIncompleteReplayRunsAsFailed(reason = 'Replay interrupted'): void {
  const db = getDatabase();
  const rows = db
    .prepare(
      `
        SELECT id, recording_id, status, started_at, updated_at, completed_at, data
        FROM replay_runs
        WHERE status IN ('running', 'paused')
      `,
    )
    .all() as ReplayRunRow[];

  if (rows.length === 0) {
    return;
  }

  const statement = db.prepare(
    `
      UPDATE replay_runs
      SET status = ?, updated_at = ?, completed_at = ?, data = ?
      WHERE id = ?
    `,
  );

  const now = new Date().toISOString();
  const transaction = db.transaction((staleRows: ReplayRunRow[]) => {
    for (const row of staleRows) {
      const run = parseReplayRunRow(row);
      const nextRun: ReplayRun = {
        ...run,
        status: 'failed',
        error: run.error ?? reason,
        updatedAt: now,
        completedAt: now,
      };

      statement.run(
        nextRun.status,
        nextRun.updatedAt,
        nextRun.completedAt ?? null,
        JSON.stringify(nextRun),
        nextRun.id,
      );
    }
  });

  transaction(rows);
}

export function getRecordingPrivacyConfig(): PrivacyConfig | null {
  const db = getDatabase();
  const row = db
    .prepare('SELECT config FROM recording_privacy_config WHERE id = ?')
    .get('default') as { config: string } | undefined;

  return row ? (JSON.parse(row.config) as PrivacyConfig) : null;
}

export function setRecordingPrivacyConfig(config: PrivacyConfig): void {
  const db = getDatabase();
  db.prepare(
    `
      INSERT INTO recording_privacy_config (id, config, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        config = excluded.config,
        updated_at = excluded.updated_at
    `,
  ).run('default', JSON.stringify(config), new Date().toISOString());
}

import type { Database } from 'better-sqlite3';

export const migration = {
  version: 31,
  up: (db: Database) => {
    // Replay runs are stored separately so recording data and replay execution history can evolve independently.
    db.exec(`
      CREATE TABLE IF NOT EXISTS replay_runs (
        id TEXT PRIMARY KEY,
        recording_id TEXT NOT NULL REFERENCES recordings(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_replay_runs_recording_id
        ON replay_runs(recording_id);

      CREATE INDEX IF NOT EXISTS idx_replay_runs_updated_at
        ON replay_runs(updated_at DESC);
    `);
  },
};

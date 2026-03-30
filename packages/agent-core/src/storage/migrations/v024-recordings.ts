import type { Database } from 'better-sqlite3';
import { DEFAULT_PRIVACY_CONFIG } from '../../common/types/recording.js';

export const migration = {
  version: 24,
  up: (db: Database) => {
    // Recordings need dedicated tables before any captured steps or privacy defaults can be persisted.
    db.exec(`
      CREATE TABLE IF NOT EXISTS recordings (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        source TEXT NOT NULL,
        source_task_id TEXT,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_recordings_source_task_id
        ON recordings(source_task_id);

      CREATE INDEX IF NOT EXISTS idx_recordings_updated_at
        ON recordings(updated_at DESC);

      CREATE TABLE IF NOT EXISTS recording_privacy_config (
        id TEXT PRIMARY KEY,
        config TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    db.prepare(
      `
        INSERT OR IGNORE INTO recording_privacy_config (id, config, updated_at)
        VALUES (?, ?, ?)
      `,
    ).run('default', JSON.stringify(DEFAULT_PRIVACY_CONFIG), new Date().toISOString());
  },
};

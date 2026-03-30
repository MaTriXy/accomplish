import type { Database } from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration: Migration = {
  version: 3,
  up(db: Database): void {
    db.exec(`
      ALTER TABLE app_settings
      ADD COLUMN lmstudio_config TEXT
    `);
  },
  down(db: Database): void {
    db.exec(`
      ALTER TABLE app_settings
      DROP COLUMN lmstudio_config
    `);
  },
};

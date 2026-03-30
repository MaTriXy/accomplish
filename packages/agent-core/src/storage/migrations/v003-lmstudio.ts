import type { Database } from 'better-sqlite3';
import type { Migration } from './index.js';
import { createConsoleLogger } from '../../utils/logging.js';

const log = createConsoleLogger({ prefix: 'Migration:v003' });

export const migration: Migration = {
  version: 3,
  up(db: Database): void {
    db.exec(`
      ALTER TABLE app_settings
      ADD COLUMN lmstudio_config TEXT
    `);
    log.info('Added lmstudio_config column');
  },
  down(db: Database): void {
    db.exec(`
      ALTER TABLE app_settings
      DROP COLUMN lmstudio_config
    `);
    log.info('Removed lmstudio_config column');
  },
};

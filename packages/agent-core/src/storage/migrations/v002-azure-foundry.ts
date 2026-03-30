import type { Database } from 'better-sqlite3';
import type { Migration } from './index.js';
import { createConsoleLogger } from '../../utils/logging.js';

const log = createConsoleLogger({ prefix: 'Migration:v002' });

export const migration: Migration = {
  version: 2,
  up(db: Database): void {
    db.exec(`
      ALTER TABLE app_settings
      ADD COLUMN azure_foundry_config TEXT
    `);
    log.info('Added azure_foundry_config column');
  },
  down(db: Database): void {
    db.exec(`
      ALTER TABLE app_settings
      DROP COLUMN azure_foundry_config
    `);
    log.info('Removed azure_foundry_config column');
  },
};

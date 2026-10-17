import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
export type Machine = { id: string; name: string; os: string; collector: string; ssh?: string };
/** The database file. Usage and the Alerts each keep their own tables in it. */
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL;');
  }
  close() { this.db.close(); }
}

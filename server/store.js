import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

export function openStore(path = '.data/hisab.sqlite') {
  if (path !== ':memory:') mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS owner (
      id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL,
      business_name TEXT NOT NULL, phone TEXT NOT NULL, password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS workers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, phone TEXT NOT NULL UNIQUE,
      contract TEXT NOT NULL CHECK (contract IN ('SANJYOT','TECHNOEDGE')),
      share_token TEXT NOT NULL UNIQUE, whatsapp_consent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS advances (
      id TEXT PRIMARY KEY, worker_id TEXT NOT NULL REFERENCES workers(id),
      amount_paise INTEGER NOT NULL CHECK (amount_paise > 0), date TEXT NOT NULL,
      method TEXT NOT NULL CHECK (method IN ('cash','online')), note TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL DEFAULT 1, request_key TEXT UNIQUE,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      contract TEXT NOT NULL CHECK (contract IN ('SANJYOT','TECHNOEDGE')),
      voided INTEGER NOT NULL DEFAULT 0, void_reason TEXT, voided_at TEXT
    );
    CREATE INDEX IF NOT EXISTS advances_worker_date ON advances(worker_id,date);
    CREATE TABLE IF NOT EXISTS audit (
      id TEXT PRIMARY KEY, action TEXT NOT NULL, entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL, summary TEXT NOT NULL, data TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS notifications (
      id TEXT PRIMARY KEY, advance_id TEXT NOT NULL REFERENCES advances(id),
      revision INTEGER NOT NULL, recipient TEXT NOT NULL, status TEXT NOT NULL,
      message_id TEXT, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS notifications_advance ON notifications(advance_id,revision);
    CREATE UNIQUE INDEX IF NOT EXISTS notifications_message ON notifications(message_id) WHERE message_id IS NOT NULL;
  `);
  // Preserve the contract attached to each financial entry when a worker moves sites.
  if (!db.prepare('PRAGMA table_info(advances)').all().some(c => c.name === 'contract')) {
    transaction(db, () => db.exec(`ALTER TABLE advances ADD COLUMN contract TEXT;
      UPDATE advances SET contract=(SELECT contract FROM workers WHERE workers.id=advances.worker_id);`));
  }
  if (!db.prepare('PRAGMA table_info(advances)').all().some(c => c.name === 'voided')) {
    transaction(db, () => db.exec(`ALTER TABLE advances ADD COLUMN voided INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE advances ADD COLUMN void_reason TEXT;
      ALTER TABLE advances ADD COLUMN voided_at TEXT;`));
  }
  db.exec('PRAGMA user_version = 3');
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}

import { DatabaseSync, backup } from 'node:sqlite';
import { resolve, dirname } from 'node:path';
import { mkdirSync, chmodSync, existsSync } from 'node:fs';
const source = resolve(process.env.DB_PATH || '.data/hisab.sqlite');
if (!existsSync(source)) throw new Error('No database exists yet. Start the application and set up the owner first.');
const destination = resolve(process.argv[2] || `.data/backups/hisab-${new Date().toISOString().replaceAll(':','-')}.sqlite`);
if (destination === source || existsSync(destination)) throw new Error('Choose a new backup path, different from the live database.');
mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
const db = new DatabaseSync(source, { readOnly: true });
try { await backup(db, destination); chmodSync(destination, 0o600); console.log(`Consistent SQLite backup saved: ${destination}`); }
finally { db.close(); }

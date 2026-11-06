import { PGlite } from '@electric-sql/pglite';

// PGlite executes real PostgreSQL in-process. A leased client keeps its
// transaction isolated from concurrent pool.query calls, as a pg.Pool would.
export function createTestPostgresPool(db = new PGlite()) {
  let queue = Promise.resolve();
  async function acquire() {
    const previous = queue;
    let release;
    queue = new Promise(resolve => { release = resolve; });
    await previous;
    return release;
  }
  async function query(text, values = []) {
    const result = values.length
      ? await db.query(text, values)
      : (await db.exec(text)).at(-1) || { rows: [], fields: [], affectedRows: 0 };
    return { ...result, rowCount: result.command === 'SELECT' ? result.rows.length : result.affectedRows ?? 0 };
  }
  const pool = {
    async query(text, values) {
      const release = await acquire();
      try { return await query(text, values); }
      finally { release(); }
    },
    async connect() {
      const unlock = await acquire();
      let released = false;
      return {
        query,
        release() { if (!released) { released = true; unlock(); } },
      };
    },
  };
  return { db, pool };
}

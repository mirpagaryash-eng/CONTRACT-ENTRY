// A small D1-shaped interface lets the same HTTP API use PostgreSQL on Netlify.
// Only application SQL goes through this adapter; data always remains bound.
const appTables = new Set(['owner', 'sessions', 'workers', 'advances', 'audit', 'rate_limits', 'state']);
const statementOwner = Symbol('postgres statement owner');
const executeStatement = Symbol('execute postgres statement');

function sqlTokens(source) {
  if (typeof source !== 'string' || !source.trim()) throw new TypeError('A SQL statement is required.');
  const tokens = [];
  let index = 0;
  const push = (kind, end) => { tokens.push({ kind, text: source.slice(index, end) }); index = end; };
  while (index < source.length) {
    const rest = source.slice(index);
    const whitespace = rest.match(/^\s+/);
    if (whitespace) { push('space', index + whitespace[0].length); continue; }
    if (rest.startsWith('--')) {
      const newline = source.indexOf('\n', index + 2);
      push('comment', newline < 0 ? source.length : newline + 1); continue;
    }
    if (rest.startsWith('/*')) {
      let end = index + 2; let depth = 1;
      while (end < source.length && depth) {
        if (source.startsWith('/*', end)) { depth++; end += 2; }
        else if (source.startsWith('*/', end)) { depth--; end += 2; }
        else end++;
      }
      if (depth) throw new TypeError('Unclosed SQL comment.');
      push('comment', end); continue;
    }
    const escapedString = /^[eE]'/.test(rest);
    if (rest[0] === "'" || rest[0] === '"' || escapedString) {
      const quote = escapedString ? "'" : rest[0];
      let end = index + (escapedString ? 2 : 1); let closed = false;
      while (end < source.length) {
        if (escapedString && source[end] === '\\') { end += 2; continue; }
        if (source[end] !== quote) { end++; continue; }
        if (source[end + 1] === quote) { end += 2; continue; }
        end++; closed = true; break;
      }
      if (!closed) throw new TypeError('Unclosed SQL quoted value.');
      push(quote === '"' ? 'identifier' : 'literal', end); continue;
    }
    const dollarQuote = rest.match(/^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/);
    if (dollarQuote) {
      const delimiter = dollarQuote[0];
      const end = source.indexOf(delimiter, index + delimiter.length);
      if (end < 0) throw new TypeError('Unclosed SQL dollar-quoted value.');
      push('literal', end + delimiter.length); continue;
    }
    if (/^\$\d/.test(rest)) throw new TypeError('Use question-mark placeholders for application SQL.');
    const word = rest.match(/^[A-Za-z_][A-Za-z_0-9$]*/);
    if (word) { push('word', index + word[0].length); continue; }
    push(rest[0] === '?' ? 'parameter' : 'punctuation', index + 1);
  }
  return tokens;
}

export function compilePostgresStatement(source) {
  const tokens = sqlTokens(source);
  let parameters = 0; let tablePosition = false; let ended = false;
  const text = tokens.map((item, index) => {
    if (item.kind === 'space' || item.kind === 'comment') return item.text;
    if (ended) throw new TypeError('Only one SQL statement is allowed.');
    if (item.text === ';') { ended = true; return ';'; }
    if (item.kind === 'parameter') { tablePosition = false; return `$${++parameters}`; }
    if (item.kind === 'word' || item.kind === 'identifier') {
      const name = item.kind === 'identifier' ? item.text.slice(1, -1).replaceAll('""', '"') : item.text.toLowerCase();
      const wasTablePosition = tablePosition;
      tablePosition = item.kind === 'word' && ['from', 'join', 'into', 'update'].includes(name);
      const next = tokens.slice(index + 1).find(token => token.kind !== 'space' && token.kind !== 'comment');
      if (wasTablePosition && appTables.has(name) && next?.text !== '.') return `hisab.${item.text}`;
      return item.text;
    }
    tablePosition = false;
    return item.text;
  }).join('');
  return { text, parameters };
}

function safeInteger(value) {
  if (value == null) return value;
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) throw new RangeError('A database integer exceeds the supported exact range.');
    return value;
  }
  if (typeof value !== 'bigint' && (typeof value !== 'string' || !/^-?\d+$/.test(value))) throw new TypeError('The database returned an invalid integer.');
  const integer = BigInt(value);
  if (integer < BigInt(Number.MIN_SAFE_INTEGER) || integer > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('A database integer exceeds the supported exact range.');
  return Number(integer);
}

function normalizedResult(result) {
  const int8 = new Set((result.fields || []).filter(field => field.dataTypeID === 20).map(field => field.name));
  const results = (result.rows || []).map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, int8.has(key) || typeof value === 'bigint' ? safeInteger(value) : value])));
  return { results, success: true, meta: { changes: safeInteger(result.rowCount ?? result.affectedRows ?? 0) } };
}

function databaseError(error) {
  if (error?.code === '23505' && error.constraint === 'workers_phone_key') {
    const duplicate = new Error('UNIQUE constraint failed: workers.phone');
    duplicate.code = error.code;
    return duplicate;
  }
  return error;
}

export function createPostgresStore(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw new TypeError('A PostgreSQL pool with query and connect methods is required.');
  const owner = {};
  const prepare = source => {
    const compiled = compilePostgresStatement(source);
    const statement = values => {
      const validate = () => {
        if (values.length !== compiled.parameters || values.some(value => value === undefined)) throw new TypeError('SQL bindings do not match the statement placeholders.');
      };
      const execute = async client => {
        validate();
        try { return normalizedResult(await client.query(compiled.text, values)); }
        catch (error) { throw databaseError(error); }
      };
      return {
        [statementOwner]: owner,
        [executeStatement]: execute,
        bind(...newValues) {
          if (newValues.length !== compiled.parameters || newValues.some(value => value === undefined)) throw new TypeError('SQL bindings do not match the statement placeholders.');
          return statement(newValues);
        },
        async first(column) {
          const row = (await execute(pool)).results[0] ?? null;
          return column === undefined || row === null ? row : row[column];
        },
        all: () => execute(pool),
        run: () => execute(pool),
      };
    };
    return statement([]);
  };
  return {
    dialect: 'postgres',
    prepare,
    async batch(statements) {
      if (!Array.isArray(statements) || statements.some(statement => statement?.[statementOwner] !== owner)) throw new TypeError('A batch must contain statements prepared by this database.');
      if (!statements.length) return [];
      const client = await pool.connect();
      let began = false;
      try {
        await client.query('BEGIN'); began = true;
        const results = [];
        for (const statement of statements) results.push(await statement[executeStatement](client));
        await client.query('COMMIT'); began = false;
        return results;
      } catch (error) {
        if (began) {
          try { await client.query('ROLLBACK'); } catch { /* Keep the original failure. */ }
        }
        throw databaseError(error);
      } finally { client.release(); }
    },
  };
}

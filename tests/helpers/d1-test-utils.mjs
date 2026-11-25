import { DatabaseSync } from 'node:sqlite';

function normalizeChanges(value) {
  return typeof value === 'bigint' ? Number(value) : Number(value || 0);
}

class BoundSqliteD1Statement {
  constructor(statement, values) {
    this.statement = statement;
    this.values = values;
  }

  async first(column) {
    const row = this.statement.get(...this.values) || null;
    if (!column) return row;
    return row && Object.prototype.hasOwnProperty.call(row, column) ? row[column] : null;
  }

  async all() {
    return {
      success: true,
      results: this.statement.all(...this.values),
      meta: {},
    };
  }

  async raw() {
    const rows = this.statement.all(...this.values);
    return rows.map((row) => Object.values(row));
  }

  async run() {
    const result = this.statement.run(...this.values);
    return {
      success: true,
      results: [],
      meta: {
        changes: normalizeChanges(result.changes),
        last_row_id:
          typeof result.lastInsertRowid === 'bigint'
            ? Number(result.lastInsertRowid)
            : result.lastInsertRowid,
      },
    };
  }
}

class SqliteD1Statement {
  constructor(statement) {
    this.statement = statement;
  }

  bind(...values) {
    return new BoundSqliteD1Statement(this.statement, values);
  }

  first(column) {
    return this.bind().first(column);
  }

  all() {
    return this.bind().all();
  }

  raw() {
    return this.bind().raw();
  }

  run() {
    return this.bind().run();
  }
}

export class SqliteD1 {
  constructor() {
    this.database = new DatabaseSync(':memory:');
    this.database.exec('PRAGMA foreign_keys = ON;');
    this.batchTail = Promise.resolve();
    this.sessionConsistencyModes = [];
  }

  exec(sql) {
    this.database.exec(sql);
  }

  prepare(sql) {
    return new SqliteD1Statement(this.database.prepare(sql));
  }

  withSession(firstQueryConsistency) {
    this.sessionConsistencyModes.push(firstQueryConsistency);
    return this;
  }

  async batch(statements) {
    const runBatch = async () => {
      this.database.exec('BEGIN;');
      try {
        const results = [];
        for (const statement of statements) {
          if (!statement || typeof statement.run !== 'function') {
            throw new TypeError('batch() には bind 済みの D1 statement が必要です。');
          }
          results.push(await statement.run());
        }
        this.database.exec('COMMIT;');
        return results;
      } catch (error) {
        this.database.exec('ROLLBACK;');
        throw error;
      }
    };
    const queued = this.batchTail.then(runBatch, runBatch);
    this.batchTail = queued.catch(() => undefined);
    return queued;
  }

  get(sql, ...values) {
    return this.database.prepare(sql).get(...values) || null;
  }

  all(sql, ...values) {
    return this.database.prepare(sql).all(...values);
  }

  close() {
    this.database.close();
  }
}

export class FakeKv {
  constructor() {
    this.values = new Map();
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async put(key, value) {
    this.values.set(key, value);
  }

  async delete(key) {
    this.values.delete(key);
  }
}

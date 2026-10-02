/**
 * sql.js database driver that mimics the better-sqlite3 synchronous API.
 * Used on Android where native modules (better-sqlite3) can't be compiled.
 */

import path from "path";
import fs from "fs";

// ── SqlJsStatement ────────────────────────────────────────────────────────

class SqlJsStatement {
  /** @param {SqlJsDatabase} db   @param {string} sql */
  constructor(db, sql) {
    this._db = db;
    this._sql = sql;
  }

  /** Execute the statement and return the first result row (object or undefined). */
  get(...params) {
    const stmt = this._db._inner.prepare(this._sql);
    try {
      if (params.length > 0) stmt.bind([...params]);
      if (stmt.step()) {
        return stmt.getAsObject();
      }
      return undefined;
    } finally {
      stmt.free();
    }
  }

  /** Execute the statement and return all result rows as an array. */
  all(...params) {
    const stmt = this._db._inner.prepare(this._sql);
    try {
      if (params.length > 0) stmt.bind([...params]);
      const rows = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  /** Execute the statement (INSERT/UPDATE/DELETE) and return { changes, lastInsertRowid }. */
  run(...params) {
    const stmt = this._db._inner.prepare(this._sql);
    try {
      if (params.length > 0) stmt.bind([...params]);
      stmt.step();
    } finally {
      stmt.free();
    }

    // Query metadata
    const changes = this._db._inner.getRowsModified();
    let lastInsertRowid = 0;
    {
      const rid = this._db._inner.prepare("SELECT last_insert_rowid() AS id");
      try {
        if (rid.step()) {
          const row = rid.getAsObject();
          lastInsertRowid = (row && row.id) || 0;
        }
      } finally {
        rid.free();
      }
    }

    // Schedule DB persistence to disk
    this._db._scheduleSave();

    return { changes, lastInsertRowid };
  }
}

// ── SqlJsDatabase ─────────────────────────────────────────────────────────

export class SqlJsDatabase {
  /**
   * @param {string} dbPath – filesystem path (must be accessible via fs)
   * @param {import("sql.js").SqlJsStatic} SQL – initialised sql.js module
   */
  constructor(dbPath, SQL) {
    this._dbPath = dbPath;
    this._SQL = SQL;
    this._saveTimer = null;

    // Load existing database file or start fresh
    let buffer = null;
    try {
      buffer = fs.readFileSync(dbPath);
    } catch (_) {
      // File does not exist → will create an empty database
    }
    this._inner = new SQL.Database(buffer || undefined);
  }

  /** Execute a raw SQL string (DDL / multi-statement). */
  exec(sql) {
    this._inner.exec(sql);
  }

  /** Return a prepared-statement-like object with .get() / .all() / .run(). */
  prepare(sql) {
    return new SqlJsStatement(this, sql);
  }

  /** Set a pragma.  WAL is silently ignored (sql.js is in-memory). */
  pragma(str) {
    if (str.toLowerCase().startsWith("journal_mode")) return;
    this._inner.exec(`PRAGMA ${str}`);
  }

  // ── persistence ──────────────────────────────────────────────────────────

  /** Debounced save: coalesces rapid writes into a single fsync. */
  _scheduleSave() {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => this._saveNow(), 500);
  }

  /** Force-persist the database to disk immediately. */
  _saveNow() {
    this._saveTimer = null;
    try {
      const data = this._inner.export();
      const dir = path.dirname(this._dbPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this._dbPath, Buffer.from(data));
    } catch (err) {
      console.error("[sqljs] persist error:", err.message);
    }
  }

  /** Flush pending writes and close. */
  close() {
    if (this._saveTimer) {
      clearTimeout(this._saveTimer);
      this._saveNow();
    }
    this._inner.close();
  }
}

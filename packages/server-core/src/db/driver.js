/**
 * Database driver auto-selector.
 *
 * Desktop  → better-sqlite3 (native, fast)
 * Android  → sql.js         (WASM, zero native compilation)
 *
 * Both expose the same API: new Driver(dbPath) → { exec, prepare, pragma }
 */

// Cache the resolved driver constructor so we only probe once.
let driverConstructor = null;
let driverResolved = false;

async function resolveDriver() {
  if (driverResolved) return driverConstructor;

  // Respect explicit override via environment variable
  const forced = process.env.DB_DRIVER;
  if (forced === "sqljs") {
    const mod = await import("./sqljs-driver.js");
    driverConstructor = mod.SqlJsDatabase;
    driverResolved = true;
    console.log("[db] using sql.js driver (forced)");
    return driverConstructor;
  }

  // Try better-sqlite3 first
  try {
    const better = await import("better-sqlite3");
    driverConstructor = better.default;
    driverResolved = true;
    console.log("[db] using better-sqlite3 driver");
    return driverConstructor;
  } catch (_) {
    // Not available (Android) → fall back to sql.js
    console.log("[db] better-sqlite3 unavailable, falling back to sql.js");
    const mod = await import("./sqljs-driver.js");
    driverConstructor = mod.SqlJsDatabase;
    driverResolved = true;
    return driverConstructor;
  }
}

/**
 * Open (or create) a SQLite database, auto-selecting the best driver.
 *
 * @param {string} dbPath
 * @param {object} [options]
 * @param {import("sql.js").SqlJsStatic} [options.sqlJs] – pre-initialised
 *        sql.js module (optional, for Android callers that may want to pass it)
 * @returns {Promise<{ db: any, stmts: object }>}
 *
 * The returned `db` object satisfies the same interface as a better-sqlite3
 * Database:  db.exec(), db.prepare(), db.pragma(), db[Symbol.for("stmt")]
 */
export async function openDatabase(dbPath, options = {}) {
  const Driver = await resolveDriver();

  // For sql.js we need the SQL module – if the caller passed it we use it;
  // otherwise we initialise it here.
  let db;
  if (Driver.name === "SqlJsDatabase") {
    const sqlJsMod = options.sqlJs || await initSqlJsIfNeeded();
    db = new Driver(dbPath, sqlJsMod);
  } else {
    db = new Driver(dbPath);
  }

  return db;
}

// Lazily initialise sql.js (loads WASM on first call)
let sqlJsPromise = null;
async function initSqlJsIfNeeded() {
  if (!sqlJsPromise) {
    sqlJsPromise = (async () => {
      const { default: initSqlJs } = await import("sql.js");
      // In the bundled Android server, the WASM file lives alongside the
      // bundle (copied by scripts/bundle-android-server.mjs).
      return initSqlJs();
    })();
  }
  return sqlJsPromise;
}

export { SqlJsDatabase } from "./sqljs-driver.js";

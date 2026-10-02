import { openDatabase } from "./db/driver.js";

/**
 * Initialise the SQLite database, run migrations, bootstrap extensions,
 * and return a stmts object with all prepared statements.
 *
 * Now async because the driver (sql.js) may need async WASM initialisation.
 */
export async function initDatabase(dbPath) {
  const db = await openDatabase(dbPath);

  db.pragma("journal_mode=WAL");

  // --- Schema ---
  db.exec(`
    CREATE TABLE IF NOT EXISTS extensions (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      lang TEXT DEFAULT 'en',
      base_url TEXT,
      installed_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mangas (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      cover_url TEXT,
      description TEXT,
      author TEXT,
      genres TEXT,
      status TEXT,
      cached_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      manga_id TEXT NOT NULL,
      chapter_number REAL,
      volume TEXT,
      title TEXT,
      lang TEXT DEFAULT 'en',
      page_count INTEGER DEFAULT 0,
      created_at TEXT,
      cached_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reading_progress (
      manga_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      user_id INTEGER NOT NULL DEFAULT 0,
      page_index INTEGER DEFAULT 0,
      completed INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (manga_id, chapter_id, user_id)
    )
  `);

  // Migration: add user_id if table already exists without it
  try {
    db.exec("ALTER TABLE reading_progress ADD COLUMN user_id INTEGER NOT NULL DEFAULT 0");
  } catch (_) {
    // column already exists – ignore
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      sync_key TEXT,
      is_admin INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: add sync_key if table exists without it
  try {
    db.exec("ALTER TABLE users ADD COLUMN sync_key TEXT");
  } catch (_) {}

  // Migration: add is_admin. Promote the lowest-id user if no admin exists.
  try {
    db.exec("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0");
  } catch (_) {}
  {
    const adminCount = db.prepare("SELECT COUNT(*) AS c FROM users WHERE is_admin = 1").get().c;
    if (adminCount === 0) {
      db.exec("UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)");
    }
  }

  // Server-wide settings (extensions home, trusted registry URL, ...)
  db.exec(`
    CREATE TABLE IF NOT EXISTS server_settings (
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // Installed extension packages (one package provides one source in v1)
  db.exec(`
    CREATE TABLE IF NOT EXISTS extension_packages (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest_json TEXT NOT NULL,
      install_dir TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      installed_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Per-user source activation (installing a package is server-global; enabling is per user)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_sources (
      user_id INTEGER NOT NULL REFERENCES users(id),
      source_id TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, source_id)
    )
  `);

  // Admin-added extension repositories. Adding a repository does not install
  // its packages; individual packages can then be installed by any user.
  db.exec(`
    CREATE TABLE IF NOT EXISTS extension_repositories (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      name TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      added_at TEXT DEFAULT (datetime('now'))
    )
  `);

  // Migration: repositories from an older schema gain the enabled flag.
  try {
    db.exec("ALTER TABLE extension_repositories ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1");
  } catch (_) {}

  // Per-extension, per-user JSON configuration store. Extensions (e.g. the
  // official Local Source) persist user-owned settings here through the
  // injected runtime.storage helper; the core never inspects the values.
  db.exec(`
    CREATE TABLE IF NOT EXISTS extension_user_store (
      extension_id TEXT NOT NULL,
      user_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (extension_id, user_id, key)
    )
  `);

  // Migration: add updated_at to favorites
  // Note: SQLite 3.35+ allows non-constant default in ALTER, but older versions don't.
  // Use DEFAULT NULL for migration; CREATE TABLE below has the real default.
  try {
    db.exec("ALTER TABLE favorites ADD COLUMN updated_at TEXT");
  } catch (_) {}

  // Add deleted_at to reading_progress (table already created above)
  try {
    db.exec("ALTER TABLE reading_progress ADD COLUMN deleted_at TEXT");
  } catch (_) {}

  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL REFERENCES users(id),
      token TEXT UNIQUE NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_chapters_manga ON chapters(manga_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token)
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS favorites (
      user_id INTEGER NOT NULL REFERENCES users(id),
      manga_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT,
      cover_url TEXT,
      added_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (user_id, manga_id)
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_progress_user ON reading_progress(user_id)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id)
  `);

  // ===== Sync multi-device v2 migrations =====
  // (favorites and reading_progress tables already exist at this point)

  // 1. Rebuild favorites: add source to PK + deleted_at column
  var needsFavoritesRebuild = false;
  try {
    db.exec("SELECT deleted_at FROM favorites LIMIT 0");
  } catch (_) {
    needsFavoritesRebuild = true;
  }
  if (needsFavoritesRebuild) {
    db.exec("BEGIN IMMEDIATE");
    try {
      var oldCount = db.prepare("SELECT COUNT(*) AS c FROM favorites").get().c;

      db.exec(`
        CREATE TABLE favorites_new (
          user_id INTEGER NOT NULL REFERENCES users(id),
          manga_id TEXT NOT NULL,
          source TEXT NOT NULL,
          title TEXT,
          cover_url TEXT,
          added_at TEXT DEFAULT (datetime('now')),
          updated_at TEXT DEFAULT (datetime('now')),
          deleted_at TEXT,
          PRIMARY KEY (user_id, source, manga_id)
        )
      `);

      db.exec(`
        INSERT INTO favorites_new (user_id, manga_id, source, title, cover_url, added_at, updated_at, deleted_at)
        SELECT t.user_id, t.manga_id, t.source, t.title, t.cover_url, t.added_at, t.updated_at, NULL
        FROM favorites t
        INNER JOIN (
          SELECT user_id, source, manga_id, MAX(updated_at) AS max_ts
          FROM favorites
          GROUP BY user_id, source, manga_id
        ) g
        ON t.user_id = g.user_id AND t.source = g.source AND t.manga_id = g.manga_id
           AND (t.updated_at = g.max_ts OR (t.updated_at IS NULL AND g.max_ts IS NULL))
      `);

      var newCount = db.prepare("SELECT COUNT(*) AS c FROM favorites_new").get().c;
      if (newCount === 0 && oldCount > 0) {
        throw new Error("Favorites rebuild: new table is empty but old had " + oldCount + " rows");
      }

      db.exec("DROP TABLE favorites");
      db.exec("ALTER TABLE favorites_new RENAME TO favorites");
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }

  // 2. Create views for active records (exclude tombstone)
  db.exec(`
    CREATE VIEW IF NOT EXISTS favorites_active AS
    SELECT * FROM favorites WHERE deleted_at IS NULL
  `);
  db.exec(`
    CREATE VIEW IF NOT EXISTS reading_progress_active AS
    SELECT * FROM reading_progress WHERE deleted_at IS NULL
  `);


  // --- Prepared statements ---
  const stmts = {
    // Manga
    upsertManga: db.prepare(`
      INSERT OR REPLACE INTO mangas (id, source, title, cover_url, description, author, genres, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    upsertMangaThumb: db.prepare(`
      INSERT OR REPLACE INTO mangas (id, source, title, cover_url)
      VALUES (?, ?, ?, ?)
    `),
    updateFavCover: db.prepare(
      "UPDATE favorites SET cover_url = ? WHERE manga_id = ? AND cover_url != ?"
    ),

    // Chapters
    upsertChapter: db.prepare(`
      INSERT OR REPLACE INTO chapters (id, manga_id, chapter_number, volume, title, lang, page_count, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `),
    countChapters: db.prepare("SELECT COUNT(*) as cnt FROM chapters WHERE manga_id = ?"),
    getChapters: db.prepare(
      "SELECT * FROM chapters WHERE manga_id = ? ORDER BY chapter_number DESC"
    ),
    updateLang: db.prepare(
      "UPDATE chapters SET lang = ? WHERE manga_id = ? AND lang != ?"
    ),
    updateChapterPageCount: db.prepare(
      "UPDATE chapters SET page_count = ?, cached_at = datetime('now') WHERE id = ?"
    ),
    getChapterPageCount: db.prepare(
      "SELECT page_count FROM chapters WHERE id = ?"
    ),
    getChaptersPageCounts: db.prepare(
      "SELECT id, page_count FROM chapters WHERE manga_id = ? AND page_count > 0"
    ),

    // Reading progress (use views for reads, physical table for writes/sync)
    upsertProgress: db.prepare(`
      INSERT OR REPLACE INTO reading_progress (manga_id, chapter_id, user_id, page_index, completed, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `),
    getProgress: db.prepare(
      "SELECT * FROM reading_progress_active WHERE manga_id = ? AND user_id = ?"
    ),
    getChapterProgress: db.prepare(
      "SELECT * FROM reading_progress_active WHERE manga_id = ? AND chapter_id = ? AND user_id = ?"
    ),

    // Auth
    getUserByEmail: db.prepare("SELECT * FROM users WHERE email = ?"),
    insertUser: db.prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)"),
    getSession: db.prepare(
      "SELECT s.*, u.email FROM sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ?"
    ),
    insertSession: db.prepare("INSERT INTO sessions (user_id, token) VALUES (?, ?)"),
    deleteSession: db.prepare("DELETE FROM sessions WHERE token = ?"),
    deleteUserSessions: db.prepare("DELETE FROM sessions WHERE user_id = ?"),

    // Favorites (use views for reads, physical table for writes/sync)
    getFavorites: db.prepare(
      "SELECT manga_id, source, title, cover_url, updated_at FROM favorites_active WHERE user_id = ?"
    ),
    getFavorite: db.prepare(
      "SELECT * FROM favorites_active WHERE user_id = ? AND manga_id = ?"
    ),
    insertFavorite: db.prepare(`
      INSERT INTO favorites (user_id, manga_id, source, title, cover_url, updated_at, added_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(user_id, source, manga_id) DO UPDATE SET
        title = excluded.title,
        cover_url = excluded.cover_url,
        updated_at = excluded.updated_at,
        deleted_at = NULL
    `),
    softDeleteFavorite: db.prepare(
      "UPDATE favorites SET deleted_at = datetime('now'), updated_at = datetime('now') WHERE user_id = ? AND manga_id = ?"
    ),

    // Sync v2 — manifest (full state, including deleted)
    getFavoriteManifest: db.prepare(
      "SELECT (source || ':' || manga_id) AS key, updated_at, deleted_at IS NOT NULL AS deleted FROM favorites WHERE user_id = ?"
    ),
    getProgressManifest: db.prepare(
      "SELECT (manga_id || ':' || chapter_id) AS key, updated_at, deleted_at IS NOT NULL AS deleted FROM reading_progress WHERE user_id = ?"
    ),

    // Sync v2 — pull by keys (batched). SQL prefix only; batchQuery() appends placeholders + ')' at runtime.
    // Keep as string (not prepared) because SQLite rejects incomplete IN clause.
    SQL_FAVORITES_BY_KEYS: "SELECT source, manga_id, title, cover_url, updated_at, deleted_at FROM favorites WHERE user_id = ? AND (source || ':' || manga_id) IN (",
    SQL_PROGRESS_BY_KEYS: "SELECT manga_id, chapter_id, page_index, completed, updated_at, deleted_at FROM reading_progress WHERE user_id = ? AND (manga_id || ':' || chapter_id) IN (",

    // Sync v2 — conditional upsert with deleted_at
    upsertFavoriteConditionalV2: db.prepare(`
      INSERT INTO favorites (user_id, manga_id, source, title, cover_url, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)
      ON CONFLICT(user_id, source, manga_id) DO UPDATE SET
        title = excluded.title,
        cover_url = excluded.cover_url,
        updated_at = COALESCE(excluded.updated_at, datetime('now')),
        deleted_at = excluded.deleted_at
      WHERE excluded.updated_at > updated_at OR updated_at IS NULL
    `),
    upsertProgressConditionalV2: db.prepare(`
      INSERT INTO reading_progress (manga_id, chapter_id, user_id, page_index, completed, updated_at, deleted_at)
      VALUES (?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?)
      ON CONFLICT(manga_id, chapter_id, user_id) DO UPDATE SET
        page_index = excluded.page_index,
        completed = excluded.completed,
        updated_at = COALESCE(excluded.updated_at, datetime('now')),
        deleted_at = excluded.deleted_at
      WHERE excluded.updated_at > updated_at OR updated_at IS NULL
    `),
    updateSyncKey: db.prepare("UPDATE users SET sync_key = ? WHERE id = ?"),

    // Chapter source lookup
    getChapterSource: db.prepare(
      "SELECT m.source, c.manga_id FROM chapters c JOIN mangas m ON c.manga_id = m.id WHERE c.id = ?"
    ),

    // Server settings
    getSetting: db.prepare("SELECT value FROM server_settings WHERE key = ?"),
    setSetting: db.prepare(
      "INSERT INTO server_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ),

    // Installed extension packages
    getPackage: db.prepare("SELECT * FROM extension_packages WHERE id = ?"),
    getAllPackages: db.prepare("SELECT * FROM extension_packages"),
    upsertPackage: db.prepare(`
      INSERT INTO extension_packages (id, name, version, manifest_json, install_dir, content_hash, installed_at)
      VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        version = excluded.version,
        manifest_json = excluded.manifest_json,
        install_dir = excluded.install_dir,
        content_hash = excluded.content_hash,
        installed_at = datetime('now')
    `),
    updatePackageInstallDir: db.prepare("UPDATE extension_packages SET install_dir = ? WHERE id = ?"),
    deletePackage: db.prepare("DELETE FROM extension_packages WHERE id = ?"),

    // Per-user source activation
    getUserSource: db.prepare("SELECT * FROM user_sources WHERE user_id = ? AND source_id = ?"),
    getUserSources: db.prepare("SELECT * FROM user_sources WHERE user_id = ?"),
    setUserSource: db.prepare(`
      INSERT INTO user_sources (user_id, source_id, enabled, updated_at)
      VALUES (?, ?, ?, datetime('now'))
      ON CONFLICT(user_id, source_id) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')
    `),
    deleteUserSourcesBySource: db.prepare("DELETE FROM user_sources WHERE source_id = ?"),

    // Extension repositories
    getAllRepositories: db.prepare("SELECT * FROM extension_repositories ORDER BY COALESCE(name, url) COLLATE NOCASE"),
    getRepository: db.prepare("SELECT * FROM extension_repositories WHERE id = ?"),
    getRepositoryByUrl: db.prepare("SELECT * FROM extension_repositories WHERE url = ?"),
    insertRepository: db.prepare(`
      INSERT OR IGNORE INTO extension_repositories (id, url, name)
      VALUES (?, ?, ?)
    `),
    deleteRepository: db.prepare("DELETE FROM extension_repositories WHERE id = ?"),

    // Per-extension per-user configuration store (runtime.storage)
    getExtensionStore: db.prepare(
      "SELECT value FROM extension_user_store WHERE extension_id = ? AND user_id = ? AND key = ?"
    ),
    setExtensionStore: db.prepare(`
      INSERT INTO extension_user_store (extension_id, user_id, key, value, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'))
      ON CONFLICT(extension_id, user_id, key) DO UPDATE SET
        value = excluded.value,
        updated_at = datetime('now')
    `),
    deleteExtensionStore: db.prepare(
      "DELETE FROM extension_user_store WHERE extension_id = ? AND user_id = ? AND key = ?"
    ),
    deleteExtensionStoreByExtension: db.prepare(
      "DELETE FROM extension_user_store WHERE extension_id = ?"
    ),

    // Admin role
    isAdmin: db.prepare("SELECT is_admin FROM users WHERE id = ?"),
    setUserAdmin: db.prepare("UPDATE users SET is_admin = ? WHERE id = ?"),
    countAdmins: db.prepare("SELECT COUNT(*) AS c FROM users WHERE is_admin = 1"),
  };

  return { db, stmts };
}

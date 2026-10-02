import type { DatabasePort } from "./database";

/** Shared account/library schema. It is intentionally safe to run on startup. */
export async function applyMigrations(database: DatabasePort): Promise<void> {
  await database.exec(`
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      local_pin_hash TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id INTEGER NOT NULL,
      token TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS favorites (
      account_id INTEGER NOT NULL,
      manga_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      cover_url TEXT,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (account_id, source, manga_id)
    );

    CREATE TABLE IF NOT EXISTS reading_progress (
      account_id INTEGER NOT NULL,
      manga_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      page_index INTEGER NOT NULL DEFAULT 0,
      completed INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (account_id, manga_id, chapter_id)
    );

    CREATE TABLE IF NOT EXISTS sync_peers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_id TEXT NOT NULL UNIQUE,
      local_account_id INTEGER NOT NULL,
      remote_account_id TEXT NOT NULL,
      remote_peer_url TEXT NOT NULL,
      remote_peer_id TEXT NOT NULL,
      pairing_pin_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'revoked')),
      last_pull_cursor TEXT,
      last_push_cursor TEXT,
      created_at TEXT NOT NULL,
      activated_at TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_outbox (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pair_id TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      sent_at TEXT,
      UNIQUE(pair_id, entity_type, entity_key)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token);
    CREATE INDEX IF NOT EXISTS idx_favorites_account ON favorites(account_id);
    CREATE INDEX IF NOT EXISTS idx_progress_account ON reading_progress(account_id);
    CREATE INDEX IF NOT EXISTS idx_sync_outbox_pair ON sync_outbox(pair_id, sent_at);
  `);
}

import initSqlJs from "sql.js";
import { applyMigrations, type DatabasePort, type SqlValue } from "@mangayomu/db-contract";

const DATABASE_NAME = "mangayomu-client";
const DATABASE_STORE = "sqlite";
const DATABASE_KEY = "library";

let databasePromise: Promise<BrowserDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openStorage(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(DATABASE_STORE)) database.createObjectStore(DATABASE_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function readDatabaseBytes(storage: IDBDatabase): Promise<ArrayBuffer | null> {
  const transaction = storage.transaction(DATABASE_STORE, "readonly");
  return (await requestResult(transaction.objectStore(DATABASE_STORE).get(DATABASE_KEY))) || null;
}

async function saveDatabaseBytes(storage: IDBDatabase, bytes: ArrayBuffer): Promise<void> {
  const transaction = storage.transaction(DATABASE_STORE, "readwrite");
  transaction.objectStore(DATABASE_STORE).put(bytes, DATABASE_KEY);
  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

function rowsFromStatement(statement: any, params: SqlValue[]): Record<string, SqlValue>[] {
  if (params.length) statement.bind(params);
  const rows: Record<string, SqlValue>[] = [];
  while (statement.step()) rows.push(statement.getAsObject());
  statement.free();
  return rows;
}

/** sql.js database persisted as SQLite bytes in IndexedDB after every mutation. */
export class BrowserDatabase implements DatabasePort {
  private writeQueue: Promise<void> = Promise.resolve();
  private transactionDepth = 0;

  constructor(private readonly database: any, private readonly storage: IDBDatabase) {}

  async get<T>(sql: string, params: SqlValue[] = []): Promise<T | undefined> {
    const statement = this.database.prepare(sql);
    return rowsFromStatement(statement, params)[0] as T | undefined;
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const statement = this.database.prepare(sql);
    return rowsFromStatement(statement, params) as T[];
  }

  async write(sql: string, params: SqlValue[] = []): Promise<void> {
    this.database.run(sql, params);
    if (this.transactionDepth === 0) await this.persist();
  }

  async exec(sql: string): Promise<void> {
    this.database.run(sql);
    if (this.transactionDepth === 0) await this.persist();
  }

  async transaction<T>(work: () => Promise<T>): Promise<T> {
    if (this.transactionDepth > 0) return work();
    this.database.run("BEGIN IMMEDIATE");
    this.transactionDepth += 1;
    try {
      const result = await work();
      this.database.run("COMMIT");
      return result;
    } catch (error) {
      this.database.run("ROLLBACK");
      throw error;
    } finally {
      this.transactionDepth -= 1;
      if (this.transactionDepth === 0) await this.persist();
    }
  }

  async persist(): Promise<void> {
    const exported: Uint8Array = this.database.export();
    const bytes = exported.buffer.slice(exported.byteOffset, exported.byteOffset + exported.byteLength) as ArrayBuffer;
    const queued = this.writeQueue.catch(() => undefined).then(() => saveDatabaseBytes(this.storage, bytes));
    this.writeQueue = queued;
    return queued;
  }

  async cacheManga(manga: { source: string; id: string; title: string; coverUrl?: string | null }): Promise<void> {
    await this.write(
      "INSERT INTO manga_cache (source, manga_id, title, cover_url, detail_json, cached_at) VALUES (?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(source, manga_id) DO UPDATE SET title = excluded.title, cover_url = excluded.cover_url, detail_json = excluded.detail_json, cached_at = excluded.cached_at",
      [manga.source, manga.id, manga.title, manga.coverUrl || null, JSON.stringify(manga), new Date().toISOString()]
    );
  }

  async cacheChapters(source: string, mangaId: string, chapters: Array<{ id: string }>): Promise<void> {
    const now = new Date().toISOString();
    for (const chapter of chapters) {
      this.database.run(
        "INSERT INTO chapter_cache (source, manga_id, chapter_id, chapter_json, cached_at) VALUES (?, ?, ?, ?, ?) " +
          "ON CONFLICT(source, manga_id, chapter_id) DO UPDATE SET chapter_json = excluded.chapter_json, cached_at = excluded.cached_at",
        [source, mangaId, chapter.id, JSON.stringify(chapter), now]
      );
    }
    await this.persist();
  }

  async getChapterSource(chapterId: string): Promise<{ source: string; manga_id: string } | undefined> {
    return this.get("SELECT source, manga_id FROM chapter_cache WHERE chapter_id = ? ORDER BY cached_at DESC LIMIT 1", [chapterId]);
  }
}

async function createBrowserDatabase(): Promise<BrowserDatabase> {
  const storage = await openStorage();
  const bytes = await readDatabaseBytes(storage);
  const SQL = await initSqlJs({
    locateFile: () => new URL("sql-wasm.wasm", window.location.href).toString()
  });
  const database = new SQL.Database(bytes ? new Uint8Array(bytes) : undefined);
  const adapter = new BrowserDatabase(database, storage);

  await applyMigrations(adapter);
  await adapter.exec(`
    CREATE TABLE IF NOT EXISTS manga_cache (
      source TEXT NOT NULL,
      manga_id TEXT NOT NULL,
      title TEXT NOT NULL,
      cover_url TEXT,
      detail_json TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      PRIMARY KEY (source, manga_id)
    );
    CREATE TABLE IF NOT EXISTS chapter_cache (
      source TEXT NOT NULL,
      manga_id TEXT NOT NULL,
      chapter_id TEXT NOT NULL,
      chapter_json TEXT NOT NULL,
      cached_at TEXT NOT NULL,
      PRIMARY KEY (source, manga_id, chapter_id)
    );
  `);
  return adapter;
}

export function getBrowserDatabase(): Promise<BrowserDatabase> {
  databasePromise ??= createBrowserDatabase();
  return databasePromise;
}

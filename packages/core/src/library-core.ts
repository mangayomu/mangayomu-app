import type { DatabasePort } from "@mangayomu/db-contract";

export type Favorite = {
  manga_id: string;
  source: string;
  title: string;
  cover_url: string | null;
  updated_at: string;
};

export type ReadingProgress = {
  manga_id: string;
  chapter_id: string;
  page_index: number;
  completed: number;
  updated_at: string;
};

/** Platform-neutral library domain service. */
export class LibraryCore {
  constructor(private readonly database: DatabasePort) {}

  async listFavorites(accountId: number): Promise<Favorite[]> {
    return this.database.all<Favorite>(
      "SELECT manga_id, source, title, cover_url, updated_at FROM favorites WHERE account_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC",
      [accountId]
    );
  }

  async addFavorite(accountId: number, mangaId: string, source: string, title: string, coverUrl: string | null): Promise<void> {
    const now = new Date().toISOString();
    await this.database.write(
      "INSERT INTO favorites (account_id, manga_id, source, title, cover_url, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL) " +
        "ON CONFLICT(account_id, source, manga_id) DO UPDATE SET title = excluded.title, cover_url = excluded.cover_url, updated_at = excluded.updated_at, deleted_at = NULL",
      [accountId, mangaId, source, title, coverUrl, now]
    );
  }

  async removeFavorite(accountId: number, mangaId: string, source?: string): Promise<void> {
    const now = new Date().toISOString();
    const sourceClause = source ? " AND source = ?" : "";
    const params = source ? [now, now, accountId, mangaId, source] : [now, now, accountId, mangaId];
    await this.database.write(
      "UPDATE favorites SET deleted_at = ?, updated_at = ? WHERE account_id = ? AND manga_id = ? AND deleted_at IS NULL" + sourceClause,
      params
    );
  }

  async getFavoriteMap(accountId: number, mangaIds: string[]): Promise<Record<string, boolean>> {
    const result: Record<string, boolean> = {};
    if (mangaIds.length === 0) return result;

    const placeholders = mangaIds.map(() => "?").join(",");
    const rows = await this.database.all<{ manga_id: string }>(
      "SELECT manga_id FROM favorites WHERE account_id = ? AND deleted_at IS NULL AND manga_id IN (" + placeholders + ")",
      [accountId, ...mangaIds]
    );
    for (const row of rows) result[row.manga_id] = true;
    for (const mangaId of mangaIds) result[mangaId] ??= false;
    return result;
  }

  async getProgress(accountId: number, mangaId: string): Promise<ReadingProgress[]> {
    return this.database.all<ReadingProgress>(
      "SELECT manga_id, chapter_id, page_index, completed, updated_at FROM reading_progress WHERE account_id = ? AND manga_id = ? AND deleted_at IS NULL",
      [accountId, mangaId]
    );
  }

  async getChapterProgress(accountId: number, mangaId: string, chapterId: string): Promise<ReadingProgress | undefined> {
    return this.database.get<ReadingProgress>(
      "SELECT manga_id, chapter_id, page_index, completed, updated_at FROM reading_progress WHERE account_id = ? AND manga_id = ? AND chapter_id = ? AND deleted_at IS NULL",
      [accountId, mangaId, chapterId]
    );
  }

  async updateProgress(accountId: number, mangaId: string, chapterId: string, pageIndex: number, completed: boolean): Promise<void> {
    const now = new Date().toISOString();
    await this.database.write(
      "INSERT INTO reading_progress (account_id, manga_id, chapter_id, page_index, completed, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL) " +
        "ON CONFLICT(account_id, manga_id, chapter_id) DO UPDATE SET page_index = excluded.page_index, completed = excluded.completed, updated_at = excluded.updated_at, deleted_at = NULL",
      [accountId, mangaId, chapterId, pageIndex, completed ? 1 : 0, now]
    );
  }
}

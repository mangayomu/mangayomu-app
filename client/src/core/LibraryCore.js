/**
 * @typedef {object} LibraryDatabase
 * @property {(sql: string, params?: unknown[]) => Promise<object | undefined>} get
 * @property {(sql: string, params?: unknown[]) => Promise<object[]>} all
 * @property {(sql: string, params?: unknown[]) => Promise<void>} write
 */

/**
 * Platform-neutral library domain service.
 * It deliberately only knows the small asynchronous SQL adapter contract above,
 * so the browser sql.js adapter and a future server SQLite adapter can share it.
 */
export class LibraryCore {
  /** @param {LibraryDatabase} database */
  constructor(database) {
    this.database = database;
  }

  async createProfile(email, passwordHash) {
    var normalizedEmail = email.trim().toLowerCase();
    if (!normalizedEmail || !passwordHash) throw new Error("Email e password richieste");

    var existing = await this.database.get("SELECT id FROM profiles WHERE email = ?", [normalizedEmail]);
    if (existing) throw new Error("Email is already registered");

    await this.database.write(
      "INSERT INTO profiles (email, password_hash, created_at) VALUES (?, ?, ?)",
      [normalizedEmail, passwordHash, new Date().toISOString()]
    );
    return this.database.get("SELECT id, email FROM profiles WHERE email = ?", [normalizedEmail]);
  }

  async authenticate(email, passwordHash) {
    var normalizedEmail = email.trim().toLowerCase();
    var profile = await this.database.get(
      "SELECT id, email, password_hash FROM profiles WHERE email = ?",
      [normalizedEmail]
    );
    if (!profile || profile.password_hash !== passwordHash) throw new Error("Incorrect email or password");
    return { id: profile.id, email: profile.email };
  }

  async getProfile(profileId) {
    return this.database.get("SELECT id, email FROM profiles WHERE id = ?", [profileId]);
  }

  async listFavorites(profileId) {
    return this.database.all(
      "SELECT manga_id, source, title, cover_url, updated_at FROM favorites WHERE profile_id = ? AND deleted_at IS NULL ORDER BY updated_at DESC",
      [profileId]
    );
  }

  async addFavorite(profileId, mangaId, source, title, coverUrl) {
    var now = new Date().toISOString();
    await this.database.write(
      "INSERT INTO favorites (profile_id, manga_id, source, title, cover_url, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL) " +
      "ON CONFLICT(profile_id, source, manga_id) DO UPDATE SET title = excluded.title, cover_url = excluded.cover_url, updated_at = excluded.updated_at, deleted_at = NULL",
      [profileId, mangaId, source, title, coverUrl, now]
    );
  }

  async removeFavorite(profileId, mangaId) {
    await this.database.write(
      "UPDATE favorites SET deleted_at = ?, updated_at = ? WHERE profile_id = ? AND manga_id = ? AND deleted_at IS NULL",
      [new Date().toISOString(), new Date().toISOString(), profileId, mangaId]
    );
  }

  async getFavoriteMap(profileId, mangaIds) {
    var result = {};
    if (!mangaIds.length) return result;

    var placeholders = mangaIds.map(function () { return "?"; }).join(",");
    var rows = await this.database.all(
      "SELECT manga_id FROM favorites WHERE profile_id = ? AND deleted_at IS NULL AND manga_id IN (" + placeholders + ")",
      [profileId].concat(mangaIds)
    );
    for (var i = 0; i < rows.length; i++) result[rows[i].manga_id] = true;
    for (var j = 0; j < mangaIds.length; j++) {
      if (!result[mangaIds[j]]) result[mangaIds[j]] = false;
    }
    return result;
  }

  async getProgress(profileId, mangaId) {
    return this.database.all(
      "SELECT manga_id, chapter_id, page_index, completed, updated_at FROM reading_progress WHERE profile_id = ? AND manga_id = ? AND deleted_at IS NULL",
      [profileId, mangaId]
    );
  }

  async getChapterProgress(profileId, mangaId, chapterId) {
    return this.database.get(
      "SELECT manga_id, chapter_id, page_index, completed, updated_at FROM reading_progress WHERE profile_id = ? AND manga_id = ? AND chapter_id = ? AND deleted_at IS NULL",
      [profileId, mangaId, chapterId]
    );
  }

  async updateProgress(profileId, mangaId, chapterId, pageIndex, completed) {
    var now = new Date().toISOString();
    await this.database.write(
      "INSERT INTO reading_progress (profile_id, manga_id, chapter_id, page_index, completed, updated_at, deleted_at) VALUES (?, ?, ?, ?, ?, ?, NULL) " +
      "ON CONFLICT(profile_id, manga_id, chapter_id) DO UPDATE SET page_index = excluded.page_index, completed = excluded.completed, updated_at = excluded.updated_at, deleted_at = NULL",
      [profileId, mangaId, chapterId, pageIndex, completed ? 1 : 0, now]
    );
  }
}

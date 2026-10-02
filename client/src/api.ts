import { AccountCore, LibraryCore } from "@mangayomu/core";
import { getBrowserDatabase } from "@mangayomu/db-browser";
import { clearRemoteSession, getConnection, hasActiveServerSession, setClientAccount, setRemoteSession } from "./connection";
import { applyBackup, decodeBackup } from "@mangayomu/backup-import";

const CLIENT_SESSION_KEY = "mangayomu.client-session";
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;

let accountCorePromise: Promise<AccountCore> | null = null;
let libraryCorePromise: Promise<LibraryCore> | null = null;

// Kept for compatibility with older view imports. Image routing is dynamic:
// a direct client loads source URLs itself, while a selected server proxies
// the same URLs.
const BASE = "";
const PROXY_BASE = "";
export { BASE, PROXY_BASE };

function getAccountCore(): Promise<AccountCore> {
  accountCorePromise ??= getBrowserDatabase().then((database) => new AccountCore(database));
  return accountCorePromise;
}

function getLibraryCore(): Promise<LibraryCore> {
  libraryCorePromise ??= getBrowserDatabase().then((database) => new LibraryCore(database));
  return libraryCorePromise;
}

type ClientSession = { accountId: number; expiresAt: number };

function readSession(): ClientSession | null {
  try {
    const raw = localStorage.getItem(CLIENT_SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw) as ClientSession;
    if (!Number.isInteger(session.accountId) || session.expiresAt <= Date.now()) {
      localStorage.removeItem(CLIENT_SESSION_KEY);
      return null;
    }
    return session;
  } catch {
    return null;
  }
}

function saveSession(accountId: number): string {
  const session: ClientSession = { accountId, expiresAt: Date.now() + ONE_YEAR_MS };
  localStorage.setItem(CLIENT_SESSION_KEY, JSON.stringify(session));
  setClientAccount(accountId);
  return "client:" + accountId;
}

function accountIdFromToken(token: string): number | null {
  const match = /^client:(\d+)$/.exec(token);
  return match ? Number(match[1]) : null;
}

async function requireAccount() {
  const session = readSession();
  if (!session) throw new Error("Sign in to a client account to use your library");

  const account = await (await getAccountCore()).getAccount(session.accountId);
  if (!account) {
    localStorage.removeItem(CLIENT_SESSION_KEY);
    throw new Error("This client account is no longer available");
  }
  return account;
}

export function authHeaders() {
  return {};
}

// Client accounts are real accounts owned by this installation. They are not
// server accounts and their session is never sent to another device.
export const auth = {
  async signup(email: string, password: string) {
    const account = await (await getAccountCore()).createAccount(email, password);
    return { token: "client:" + account.id, user: account };
  },

  async login(email: string, password: string) {
    const account = await (await getAccountCore()).authenticate(email, password);
    return { token: "client:" + account.id, user: account };
  },

  async me() {
    return { user: await requireAccount() };
  },

  async logout() {
    return { ok: true };
  },

  saveToken(token: string) {
    const accountId = accountIdFromToken(token);
    if (!accountId) throw new Error("Invalid client session token");
    saveSession(accountId);
  },

  clearToken() {
    try { localStorage.removeItem(CLIENT_SESSION_KEY); } catch {}
    setClientAccount(null);
  },

  getToken() {
    const session = readSession();
    return session ? "client:" + session.accountId : null;
  }
};

export interface MangaThumbnail {
  id: string;
  title: string;
  coverUrl: string | null;
  source: string;
}

export interface MangaDetail {
  id: string;
  title: string;
  altTitle: string | null;
  description: string | null;
  coverUrl: string | null;
  authors: string[];
  genres: string[];
  themes: string[];
  formats: string[];
  contents: string[];
  status: string;
  source: string;
  availableLanguages: SourceLanguage[];
  displayLanguage: string;
}

export interface Chapter {
  id: string;
  chapterNumber: number | null;
  volume: string | null;
  title: string;
  lang: string;
  pageCount: number;
  createdAt: string | null;
}

export interface ChapterPages {
  /** Image page URLs (image chapters and legacy consumers). */
  urls: string[];
  /** Chapter format marker: "images" (default) or "pdf". */
  format?: "images" | "pdf";
  /** Authenticated PDF source URL when format === "pdf". */
  pdfUrl?: string;
}
export interface ReadingProgress {
  manga_id: string;
  chapter_id: string;
  page_index: number;
  completed: number;
}
export interface SourceLanguage { code: string; label: string; flag: string; }
export interface ExtensionInfo { id: string; packageId?: string; name: string; lang: string; defaultLanguage: string; languages: SourceLanguage[]; baseUrl: string; }

export interface RepositoryPackageInfo {
  id: string;
  name: string;
  version: string;
  url: string;
  tags: string[];
  installed: boolean;
  installedVersion: string | null;
  updateAvailable: boolean;
  enabled: boolean;
}

export interface RepositoryInfo {
  id: string;
  url: string;
  name: string | null;
  error: string | null;
  enabled: boolean;
  packages: RepositoryPackageInfo[];
}

/** Installed package exposing a browser module the current user may use. */
export interface InstalledClientExtension {
  packageId: string;
  name: string;
  version: string;
  clientEntry: string;
  settingsPanels: string[];
  browseSources: string[];
}

async function serverRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const connection = getConnection();
  if (!connection.serverUrl) throw new Error("Connect to a server first");
  const headers = new Headers(init?.headers || {});
  if (hasActiveServerSession(connection)) {
    headers.set("Authorization", "Bearer " + connection.serverSession!.token);
  }
  const response = await fetch(connection.serverUrl + path, { ...init, headers });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    const err = new Error(body.error || "Server request failed: " + response.status) as Error & { status?: number; code?: string };
    err.status = response.status;
    // Machine-readable reason, so callers can react without matching the
    // human-readable message.
    if (typeof body.code === "string") err.code = body.code;
    throw err;
  }
  return response.json() as Promise<T>;
}

function useServerGateway(): boolean {
  const connection = getConnection();
  return connection.transport === "server" && Boolean(connection.serverUrl);
}

function sourcePreferenceQuery(language?: string): string {
  if (!language) return "";
  return "&lang=" + encodeURIComponent(language);
}
/**
 * The source generates its own cover URLs. In server mode the selected
 * server proxies the URL; in direct mode the browser loads it directly.
 * This milestone executes no source code in the browser.
 */
export function imageUrl(url: string | null | undefined, source?: string | null): string | null | undefined {
  if (!url) return url;
  if (!useServerGateway()) return url;
  const connection = getConnection();
  if (!source) return url;
  const sessionToken =
    hasActiveServerSession(connection)
      ? connection.serverSession!.token
      : "";
  const proxyUrl =
    connection.serverUrl + "/api/proxy/image?url=" + encodeURIComponent(url) + "&source=" + encodeURIComponent(source);
  return sessionToken ? proxyUrl + "&access_token=" + encodeURIComponent(sessionToken) : proxyUrl;
}

export function requireServerSources(): void {
  if (!useServerGateway()) {
    throw new Error("Connect to a server to browse manga sources");
  }
}

export const builds = {
  /** Metadata of one Android flavour (with-server by default). */
  async info(variant?: "withServer" | "client"): Promise<{
    buildDate: string | null; apkSize: number; apkName: string | null;
    canBuild: boolean; buildEnabled: boolean; buildsUrl: string; source: "local" | "remote" | null;
    variant: "withServer" | "client"; available: { withServer: boolean; client: boolean };
  }> {
    return serverRequest<{
      buildDate: string | null; apkSize: number; apkName: string | null;
      canBuild: boolean; buildEnabled: boolean; buildsUrl: string; source: "local" | "remote" | null;
      variant: "withServer" | "client"; available: { withServer: boolean; client: boolean };
    }>("/api/builds/info" + (variant ? "?variant=" + variant : ""));
  },

  /** State of an on-demand Android build (polled while one is running). */
  async status(): Promise<{
    canBuild: boolean; building: boolean; startedAt: string | null;
    finishedAt: string | null; ok: boolean | null; error: string; log: string[];
  }> {
    return serverRequest<{
      canBuild: boolean; building: boolean; startedAt: string | null;
      finishedAt: string | null; ok: boolean | null; error: string; log: string[];
    }>("/api/builds/status");
  },

  /** Ask this server to build the Android APK (admin only). */
  async buildAndroid(): Promise<{ ok: boolean; startedAt: string }> {
    return serverRequest<{ ok: boolean; startedAt: string }>("/api/builds/android", { method: "POST" });
  },
};

export const network = {
  /** Local addresses of the served server, used by the QR share dialog. */
  async addresses(): Promise<{ port: number; addresses: Array<{ interface: string; address: string }> }> {
    return serverRequest<{ port: number; addresses: Array<{ interface: string; address: string }> }>("/api/network");
  },
};

export interface AdminSettings {
  extensionsHome: string;
  trustedRegistryUrls: string[];
  /** Legacy single-value alias kept for older clients. */
  trustedRegistryUrl: string;
  androidBuildEnabled: boolean;
  androidBuildsUrl: string;
  androidBuildsUrlDefault: string;
  androidCanBuild: boolean;
}

export const extensions = {
  /** Sources the current server user has enabled, or [] in direct mode. */
  async list(): Promise<ExtensionInfo[]> {
    if (!useServerGateway()) return [];
    return serverRequest<ExtensionInfo[]>("/api/extensions");
  },

  /** All installed sources with the current server user's activation state. */
  async listSettings(): Promise<Array<ExtensionInfo & { enabled: boolean; version?: string }>> {
    if (!useServerGateway()) return [];
    return serverRequest<Array<ExtensionInfo & { enabled: boolean; version?: string }>>("/api/settings/extensions");
  },

  async setEnabled(sourceId: string, enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> {
    return serverRequest<{ ok: boolean; enabled: boolean }>("/api/settings/extensions/" + encodeURIComponent(sourceId), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
  },

  async discover(): Promise<{ configured: boolean; packages: Array<Record<string, unknown>>; errors?: Array<{ url: string; error: string }> }> {
    if (!useServerGateway()) return { configured: false, packages: [], errors: [] };
    return serverRequest<{ configured: boolean; packages: Array<Record<string, unknown>>; errors?: Array<{ url: string; error: string }> }>("/api/extensions/discover");
  },

  async installTrusted(url: string): Promise<{ ok: boolean; status: string }> {
    return serverRequest<{ ok: boolean; status: string }>("/api/extensions/install-trusted", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  },

  async listRepositories(): Promise<{ repositories: Array<RepositoryInfo> }> {
    return serverRequest<{ repositories: Array<RepositoryInfo> }>("/api/extensions/repositories");
  },

  /** Installed packages with a client module the current user may load. */
  async listClientExtensions(): Promise<{ extensions: Array<InstalledClientExtension> }> {
    return serverRequest<{ extensions: Array<InstalledClientExtension> }>("/api/extensions/installed");
  },

  /** Authenticated per-user request handled by an installed extension. */
  async extensionRequest(extensionId: string, method: string, path: string, body?: unknown): Promise<unknown> {
    return serverRequest(
      "/api/extensions/" + encodeURIComponent(extensionId) + "/request/" + path.split("/").filter(Boolean).join("/"),
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      }
    );
  },

  /** Absolute URL of a client module served by the connected server. */
  clientModuleUrl(extension: InstalledClientExtension): string {
    const connection = getConnection();
    const parts = extension.clientEntry.split("/").map(encodeURIComponent).join("/");
    const token =
      hasActiveServerSession(connection)
        ? connection.serverSession!.token
        : "";
    // The package version is part of the URL so an updated release never
    // reuses a stale browser-cached module (installed extensions change at
    // runtime, so the query must change even when the token does not).
    const params = new URLSearchParams();
    params.set("v", extension.version || "0");
    if (token) params.set("access_token", token);
    return (
      connection.serverUrl +
      "/api/extensions/client-module/" +
      encodeURIComponent(extension.packageId) +
      "/" +
      parts +
      "?" +
      params.toString()
    );
  },

  async installRepositoryPackage(repoId: string, packageUrl: string): Promise<{ ok: boolean; status: string; id?: string }> {
    return serverRequest<{ ok: boolean; status: string; id?: string }>("/api/extensions/repositories/" + encodeURIComponent(repoId) + "/install", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ packageUrl }),
    });
  },

  async adminAddRepository(url: string, name?: string): Promise<{ repository: { id: string; url: string; name: string | null } }> {
    return serverRequest("/api/admin/extensions/repositories", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, name }),
    });
  },

  async adminRemoveRepository(id: string): Promise<{ ok: boolean }> {
    return serverRequest<{ ok: boolean }>("/api/admin/extensions/repositories/" + encodeURIComponent(id), {
      method: "DELETE",
    });
  },

  async getAdminSettings(): Promise<AdminSettings> {
    return serverRequest<AdminSettings>("/api/admin/settings");
  },

  async setAdminSettings(body: {
    extensionsHome?: string; trustedRegistryUrls?: string[];
    androidBuildEnabled?: boolean; androidBuildsUrl?: string;
  }): Promise<AdminSettings> {
    return serverRequest<AdminSettings>("/api/admin/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  },

  async adminRemovePackage(packageId: string): Promise<{ ok: boolean; id: string; sourceIds: string[] }> {
    return serverRequest<{ ok: boolean; id: string; sourceIds: string[] }>("/api/admin/extensions/" + encodeURIComponent(packageId), {
      method: "DELETE",
    });
  },

  async adminUpload(file: File): Promise<{ ok: boolean; status: string; id?: string }> {
    const form = new FormData();
    form.append("package", file);
    return serverRequest<{ ok: boolean; status: string; id?: string }>("/api/admin/extensions/upload", {
      method: "POST",
      body: form,
    });
  },

  async adminInstallUrl(url: string): Promise<{ ok: boolean; status: string; id?: string }> {
    return serverRequest<{ ok: boolean; status: string; id?: string }>("/api/admin/extensions/install-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    });
  },

};

// Sources execute only on the selected server. Direct mode has no installed
// source runtime in this milestone and rejects catalog calls explicitly.
export const manga = {
  async list(source: string, page: number, language?: string): Promise<MangaThumbnail[]> {
    requireServerSources();
    return serverRequest<MangaThumbnail[]>("/api/manga/" + encodeURIComponent(source) + "?page=" + page + sourcePreferenceQuery(language));
  },

  async search(source: string, query: string, page: number, language?: string): Promise<MangaThumbnail[]> {
    requireServerSources();
    return serverRequest<MangaThumbnail[]>("/api/search/" + encodeURIComponent(source) + "?q=" + encodeURIComponent(query) + "&page=" + page + sourcePreferenceQuery(language));
  },

  async detail(source: string, mangaId: string, language?: string): Promise<MangaDetail> {
    requireServerSources();
    const detail = await serverRequest<MangaDetail>("/api/manga/" + encodeURIComponent(source) + "/" + encodeURIComponent(mangaId) + (language ? "?lang=" + encodeURIComponent(language) : ""));
    await (await getBrowserDatabase()).cacheManga(detail);
    return detail;
  },

  async chapters(source: string, mangaId: string, language?: string): Promise<Chapter[]> {
    requireServerSources();
    const chapters = await serverRequest<Chapter[]>("/api/manga/" + encodeURIComponent(source) + "/" + encodeURIComponent(mangaId) + "/chapters" + (language ? "?lang=" + encodeURIComponent(language) : ""));
    await (await getBrowserDatabase()).cacheChapters(source, mangaId, chapters);
    return chapters;
  },

  async pages(chapterId: string): Promise<ChapterPages> {
    requireServerSources();
    return serverRequest<ChapterPages>("/api/chapter/" + encodeURIComponent(chapterId) + "/pages");
  }
};

export const backupImport = {
  async decode(file: File) {
    return decodeBackup(new Uint8Array(await file.arrayBuffer()), file.name);
  },

  async applyLocal(payload: any) {
    const account = await requireAccount();
    const database = await getBrowserDatabase();
    const library = await getLibraryCore();
    return applyBackup(payload, {
      saveManga: (item: any) => database.cacheManga(item),
      saveFavorite: (item: any) => library.addFavorite(account.id, item.id, item.source, item.title, item.coverUrl),
      saveProgress: async (item: any, chapter: any) => {
        await database.cacheChapters(item.source, item.id, [chapter]);
        await library.updateProgress(account.id, item.id, chapter.id, chapter.pageIndex, chapter.completed);
      },
    });
  },

  async applyRemote(payload: any) {
    const connection = getConnection();
    if (!connection.serverSession) throw new Error("Sign in to a Remote account before importing to a server");
    const response = await serverRequest<{ ok: boolean; summary: any }>("/api/import/normalized", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    return response.summary;
  },
};

export const remoteAuth = {
  async login(email: string, password: string) {
    const result = await serverRequest<{ token: string; user: { id: number; email: string } }>("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    setRemoteSession(result.user.id, result.token, result.user.email);
    return result;
  },

  async signup(email: string, password: string) {
    const result = await serverRequest<{ token: string; user: { id: number; email: string } }>("/api/auth/signup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password })
    });
    setRemoteSession(result.user.id, result.token, result.user.email);
    return result;
  },

  async logout() {
    try {
      await serverRequest("/api/auth/logout", { method: "POST" });
    } finally {
      clearRemoteSession();
    }
  },

  async me() {
    return serverRequest<{ user: { id: number; email: string; is_admin?: number } }>("/api/auth/me");
  }
};

function serverSessionActive(): boolean {
  return hasActiveServerSession(getConnection());
}

export const progress = {
  async getAllWithTimestamps(_since: string): Promise<ReadingProgress[]> {
    throw new Error("Remote Sync is not configured");
  },

  async get(mangaId: string): Promise<ReadingProgress[]> {
    // With an active server session the reading progress belongs to the
    // server account; keep the client-account library as the fallback for
    // direct/client-only usage.
    if (serverSessionActive()) {
      return serverRequest<ReadingProgress[]>("/api/progress/" + encodeURIComponent(mangaId));
    }
    const account = await requireAccount();
    return (await getLibraryCore()).getProgress(account.id, mangaId);
  },

  async update(mangaId: string, chapterId: string, pageIndex: number, completed: boolean): Promise<{ ok: boolean }> {
    if (serverSessionActive()) {
      await serverRequest<{ ok: boolean }>(
        "/api/progress/" + encodeURIComponent(mangaId) + "/chapter/" + encodeURIComponent(chapterId),
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pageIndex, completed }),
        }
      );
      return { ok: true };
    }
    const account = await requireAccount();
    await (await getLibraryCore()).updateProgress(account.id, mangaId, chapterId, pageIndex, completed);
    return { ok: true };
  },

  async getChapter(mangaId: string, chapterId: string): Promise<ReadingProgress | null> {
    if (serverSessionActive()) {
      const row = await serverRequest<{ page_index: number; completed: number }>(
        "/api/progress/" + encodeURIComponent(mangaId) + "/chapter/" + encodeURIComponent(chapterId)
      );
      if (!row || (!row.page_index && !row.completed)) return null;
      return { manga_id: mangaId, chapter_id: chapterId, page_index: row.page_index, completed: row.completed };
    }
    const account = await requireAccount();
    return (await (await getLibraryCore()).getChapterProgress(account.id, mangaId, chapterId)) || null;
  }
};

export const favorites = {
  async list(): Promise<Array<{ manga_id: string; source: string; title: string; cover_url: string | null }>> {
    if (serverSessionActive()) {
      return serverRequest<Array<{ manga_id: string; source: string; title: string; cover_url: string | null }>>("/api/favorites");
    }
    const account = await requireAccount();
    return (await getLibraryCore()).listFavorites(account.id);
  },

  async add(mangaId: string, source: string, title: string, coverUrl: string | null): Promise<{ ok: boolean }> {
    if (serverSessionActive()) {
      await serverRequest<{ ok: boolean }>("/api/favorites", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ manga_id: mangaId, source, title, cover_url: coverUrl }),
      });
      return { ok: true };
    }
    const account = await requireAccount();
    await (await getLibraryCore()).addFavorite(account.id, mangaId, source, title, coverUrl);
    return { ok: true };
  },

  async remove(mangaId: string, source?: string): Promise<{ ok: boolean }> {
    if (serverSessionActive()) {
      await serverRequest<{ ok: boolean }>("/api/favorites/" + encodeURIComponent(mangaId), {
        method: "DELETE",
      });
      return { ok: true };
    }
    const account = await requireAccount();
    await (await getLibraryCore()).removeFavorite(account.id, mangaId, source);
    return { ok: true };
  },

  check(mangaId: string, list: Array<{ manga_id: string }>): boolean {
    return list.some((favorite) => favorite.manga_id === mangaId);
  },

  async checkBatch(mangaIds: string[]): Promise<{ favorited: Record<string, boolean> }> {
    if (serverSessionActive()) {
      const server = await serverRequest<{ favorited: Record<string, boolean> }>("/api/favorites/check", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mangaIds }),
      });
      return { favorited: server.favorited };
    }
    const account = await requireAccount();
    return { favorited: await (await getLibraryCore()).getFavoriteMap(account.id, mangaIds) };
  },

  listWithTimestamps() { return this.list(); },

  async listManifest() {
    throw new Error("Remote Sync is not configured");
  }
};

export interface SyncManifestEntry {
  key: string;
  updated_at: string | null;
  deleted: boolean | number;
}

export interface SyncFavoriteRecord {
  manga_id: string;
  source: string;
  title: string;
  cover_url: string | null;
  updated_at: string;
  deleted_at?: string | null;
}

export interface SyncProgressRecord {
  manga_id: string;
  chapter_id: string;
  page_index: number;
  completed: number;
  updated_at: string;
  deleted_at?: string | null;
}

/**
 * Peer-to-peer sync calls hit ANOTHER MangaYomu instance, so they cannot use
 * the local server session: the peer authenticates with email + sync PIN.
 */
async function peerRequest<T>(remoteUrl: string, path: string, body: unknown): Promise<T> {
  const response = await fetch(remoteUrl.replace(/\/+$/, "") + path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Remote request failed: " + response.status);
  }
  return response.json() as Promise<T>;
}

function serverSyncRequest<T>(path: string, body?: unknown): Promise<T> {
  const init: RequestInit = body === undefined
    ? { method: "GET" }
    : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  return serverRequest<T>(path, init);
}

export const sync = {
  requiresServerSession(): boolean {
    return serverSessionActive();
  },

  /** Handshake with the peer instance; protocolVersion must be 2. */
  hello(remoteUrl: string, email: string, syncKey: string): Promise<{ found: boolean; serverTime: string; protocolVersion: number }> {
    return peerRequest(remoteUrl, "/api/sync/hello", { email, syncKey });
  },

  /** Full key list with timestamps, no records: the reconciliation input. */
  manifest(remoteUrl: string, email: string, syncKey: string): Promise<{
    serverTime: string;
    favorites: SyncManifestEntry[];
    progress: SyncManifestEntry[];
  }> {
    return peerRequest(remoteUrl, "/api/sync/manifest", { email, syncKey });
  },

  /** Full records for the keys the diff decided to pull. */
  pull(remoteUrl: string, email: string, syncKey: string, favoriteKeys: string[], progressKeys: string[]): Promise<{
    serverTime: string;
    favorites: SyncFavoriteRecord[];
    progress: SyncProgressRecord[];
  }> {
    return peerRequest(remoteUrl, "/api/sync/pull", { email, syncKey, favoriteKeys, progressKeys });
  },

  /** Push local changes to the peer (deleted_at included for tombstones). */
  push(remoteUrl: string, email: string, syncKey: string, data: {
    favorites: SyncFavoriteRecord[];
    progress: SyncProgressRecord[];
  }): Promise<{ ok: boolean }> {
    return peerRequest(remoteUrl, "/api/sync/push", { email, syncKey, ...data });
  },

  /** Build metadata of the peer, used to offer its APK download. */
  async getBuildInfo(remoteUrl: string): Promise<{ buildDate: string | null; apkSize: number; apkName: string | null }> {
    try {
      const response = await fetch(remoteUrl.replace(/\/+$/, "") + "/api/builds/info");
      if (!response.ok) throw new Error(String(response.status));
      return await response.json();
    } catch {
      return { buildDate: null, apkSize: 0, apkName: null };
    }
  },

  /** Apply pulled records to the account of the connected server. */
  localApply(data: { favorites: SyncFavoriteRecord[]; progress: SyncProgressRecord[] }): Promise<{ ok: boolean }> {
    return serverSyncRequest("/api/sync/local-apply", data);
  },

  /** Manifest of the connected server account (the "local" side). */
  getLocalManifest(): Promise<{ serverTime: string; favorites: SyncManifestEntry[]; progress: SyncManifestEntry[] }> {
    return serverSyncRequest("/api/sync/local-manifest");
  },

  /** Local records for the keys the diff decided to push. */
  getLocalPushData(favKeys: string[], progKeys: string[]): Promise<{ favorites: SyncFavoriteRecord[]; progress: SyncProgressRecord[] }> {
    return serverSyncRequest("/api/sync/local-push-data", { favKeys, progKeys });
  },

  /** This account's sync PIN, shared with the peer device. */
  getOwnKey(): Promise<{ syncKey: string | null; email: string }> {
    return serverSyncRequest("/api/auth/sync-key");
  },

  /** Set a custom PIN, or generate a random one when omitted. */
  regenerateOwnKey(pin?: string): Promise<{ syncKey: string }> {
    return serverSyncRequest("/api/auth/sync-key", pin ? { pin } : {});
  }
};

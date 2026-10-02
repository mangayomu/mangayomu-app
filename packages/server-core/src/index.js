import express from "express";
import { randomUUID, randomInt } from "crypto";
import { spawn } from "child_process";
import bcrypt from "bcryptjs";
import path from "path";
import fs from "fs";
import os from "os";
import { fileURLToPath } from "url";
import busboy from "busboy";
import { parseHTML } from "linkedom";
import { initDatabase } from "./db.js";
import { getUserId, requireAuth } from "./auth.js";
import { applyBackup } from "@mangayomu/backup-import";
import { ExtensionRegistry } from "./extensions/registry.js";
import {
  installPackage, downloadUrl, peekManifest, hashData, MAX_UPLOAD_BYTES,
} from "./extensions/installer.js";
import { resolveTrustedCatalogs, resolveRepository } from "./extensions/trusted.js";
import { parseManifest } from "./extensions/manifest.js";
import { resolveClientModulePath, clientContentType } from "./extensions/client-module.js";
import {
  isBinaryResult,
  isRedirectResult,
  parseExtensionImageUrl,
  shouldProxyRedirect,
} from "./extensions/response.js";

// The official extension repository ships MangaYomu-maintained packages (the
// Local Source extension first). It is seeded into the repository list on the
// first boot so installs are one click away; removing it stays permanent.
const DEFAULT_OFFICIAL_REPOSITORY_URL =
  process.env.MANGAYOMU_OFFICIAL_REPOSITORY_URL ||
  "https://mangayomu.github.io/mangayomu-official-extensions/repository.json";

/**
 * Create a fully-configured Express app with all MangaYomu routes.
 *
 * @param {object}   options
 * @param {string}   [options.dbPath]  – path to SQLite database file
 * @param {number}   [options.port]    – used only for logging / convenience
 * @returns {{ app: import("express").Express, db: import("better-sqlite3").Database }}
 */
export async function createApp(options = {}) {
  const dbPath = options.dbPath || path.resolve(process.cwd(), "mangayomu.db");
  const { db, stmts } = await initDatabase(dbPath);

  // =====================================================================
  //  Extension runtime
  // =====================================================================

  const serverRuntime = {
    fetch: (input, init) => fetch(input, init),
    parseHtml: (html) => parseHTML(html).document,
    // Per-extension, per-user JSON configuration backed by the core database.
    // Extensions own the value semantics; the core only persists opaque text.
    storage: {
      async get(extensionId, userId, key) {
        const row = stmts.getExtensionStore.get(extensionId, String(userId), key);
        return row ? row.value : null;
      },
      async set(extensionId, userId, key, value) {
        stmts.setExtensionStore.run(
          extensionId, String(userId), key,
          typeof value === "string" ? value : JSON.stringify(value)
        );
        return true;
      },
      async remove(extensionId, userId, key) {
        stmts.deleteExtensionStore.run(extensionId, String(userId), key);
        return true;
      },
    },
  };
  const registry = new ExtensionRegistry(serverRuntime);

  function officialRepositoryUrl() {
    return options.defaultRepositoryUrl || DEFAULT_OFFICIAL_REPOSITORY_URL;
  }

  // Seed the official repository once. The marker stays in server_settings so
  // an admin who removes it is not surprised by a phantom row on next boot.
  if (!stmts.getSetting.get("official_repository_seeded")) {
    const officialUrl = officialRepositoryUrl();
    if (officialUrl) {
      stmts.insertRepository.run(
        randomUUID(), officialUrl,
        options.defaultRepositoryName || "Official MangaYomu Extensions"
      );
    }
    stmts.setSetting.run("official_repository_seeded", "1");
  }

  function resolveHome() {
    const row = stmts.getSetting.get("extensions_home");
    if (row && row.value) return row.value;
    return options.defaultHome || path.join(os.homedir(), ".mangayomu");
  }

  /** The trusted catalogs the admin configured, without implicit entries. */
  function configuredTrustedUrls() {
    // Stored as a JSON array; the singular key is the pre-multi-registry value
    // and is only read as a fallback.
    const row = stmts.getSetting.get("trusted_registry_urls");
    if (row && row.value) {
      try {
        const list = JSON.parse(row.value);
        if (Array.isArray(list)) {
          return list.filter(function (url) { return typeof url === "string" && url.trim(); });
        }
      } catch (err) { /* fall through to the legacy value */ }
    }
    const legacy = stmts.getSetting.get("trusted_registry_url");
    return legacy && legacy.value ? [legacy.value] : [];
  }

  /**
   * Catalogs the server actually trusts.
   *
   * The repository MangaYomu ships is trusted implicitly: it is seeded on the
   * first boot, so removing it must never make it impossible to add back.
   * It goes last, so an admin's own catalogs still win on conflicting ids.
   */
  function resolveTrustedUrls() {
    const configured = configuredTrustedUrls();
    const official = officialRepositoryUrl();
    if (!official || configured.includes(official)) return configured;
    return configured.concat([official]);
  }

  /** Validate, trim and de-duplicate the admin's trusted registry list. */
  function normalizeTrustedUrls(values) {
    const seen = new Set();
    const list = [];
    for (const value of values || []) {
      const url = typeof value === "string" ? value.trim() : "";
      if (!url) continue;
      if (!/^https:\/\//.test(url)) throw new Error("Trusted registry URLs must use HTTPS");
      if (seen.has(url)) continue;
      seen.add(url);
      list.push(url);
    }
    return list;
  }

  function writeTrustedUrls(urls) {
    stmts.setSetting.run("trusted_registry_urls", JSON.stringify(urls));
    // Clear the legacy key so one reader stays authoritative.
    stmts.setSetting.run("trusted_registry_url", "");
  }

  function settingsSummary() {
    // The editor edits what the admin configured: the implicit official
    // repository is not listed, so removing it from the list cannot silently
    // reappear after a save.
    const trustedRegistryUrls = configuredTrustedUrls();
    return {
      extensionsHome: resolveHome(),
      trustedRegistryUrls,
      // Legacy single-value alias for clients that predate multiple registries.
      trustedRegistryUrl: trustedRegistryUrls[0] || "",
      androidBuildEnabled: androidBuildEnabled(),
      androidBuildsUrl: resolveBuildsUrl(),
      androidBuildsUrlDefault: DEFAULT_BUILDS_URL,
      androidCanBuild: canBuildAndroid(),
    };
  }

  // The database must mirror the filesystem: a package record whose install
  // directory (or manifest) is gone is not really installed. Dropping stale
  // records keeps repository toggles from pointing at a package that no longer
  // exists (which would 404 on enable/disable) and lets the user re-install it
  // from the repository with one click.
  function reconcileInstalledPackages() {
    for (const pkg of stmts.getAllPackages.all()) {
      const dir = pkg.install_dir;
      if (dir && fs.existsSync(dir) && fs.existsSync(path.join(dir, "extension.json"))) continue;
      console.warn("[extensions] dropping stale install record for " + pkg.id + " (missing at " + dir + ")");
      let sources = [];
      try {
        const m = JSON.parse(pkg.manifest_json);
        sources = (m.contributes && m.contributes.sources || []).map((s) => s.id);
      } catch (_) { /* ignore */ }
      for (const sourceId of sources) stmts.deleteUserSourcesBySource.run(sourceId);
      stmts.deletePackage.run(pkg.id);
    }
  }
  reconcileInstalledPackages();

  // Load installed packages into the runtime registry. A single broken
  // package must not prevent the server from starting.
  for (const pkg of stmts.getAllPackages.all()) {
    try {
      await registry.load(pkg.install_dir);
    } catch (err) {
      console.error("[extensions] failed to load " + pkg.id + ": " + err.message);
    }
  }

  // A crash after an uninstall DB commit can leave a package directory behind.
  // Only app-owned, manifest-valid directory names are eligible for cleanup.
  function pruneOrphanedPackageDirectories() {
    const packageDir = path.join(resolveHome(), "extensions");
    let entries;
    try { entries = fs.readdirSync(packageDir, { withFileTypes: true }); }
    catch (_) { return; }
    const installedIds = new Set(stmts.getAllPackages.all().map((pkg) => pkg.id));
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(entry.name) || installedIds.has(entry.name)) continue;
      try { fs.rmSync(path.join(packageDir, entry.name), { recursive: true, force: true }); }
      catch (err) { console.error("[extensions] could not prune orphaned " + entry.name + ": " + err.message); }
    }
  }
  pruneOrphanedPackageDirectories();

  // Re-register a freshly installed/updated package and persist its record.
  // The registry map is keyed by source id, not package id, so an update that
  // changes a contributed source id must evict the old entries before reload.
  async function activateInstalled(result) {
    const contributed = (result.manifest.contributes && result.manifest.contributes.sources) || [];
    for (const source of contributed) {
      registry.entries.delete(source.id);
    }
    await registry.load(result.installDir);
    stmts.upsertPackage.run(
      result.id, result.manifest.name, result.manifest.version,
      JSON.stringify(result.manifest), result.installDir, result.contentHash
    );
  }

  // Uninstall is server-wide: remove package records and runtime sources first,
  // so the database remains authoritative even if filesystem cleanup is delayed.
  // A leftover directory is never loaded because startup reads installed packages
  // from the database.
  function removeInstalledPackage(packageId) {
    const pkg = stmts.getPackage.get(packageId);
    if (!pkg) throw new Error("Extension is not installed");
    const manifest = parseManifest(pkg.manifest_json);
    if (manifest.id !== packageId) throw new Error("Installed extension metadata is invalid");
    const expectedDir = path.resolve(resolveHome(), "extensions", packageId);
    if (path.resolve(pkg.install_dir) !== expectedDir) {
      throw new Error("Installed extension path is invalid");
    }
    const sourceIds = ((manifest.contributes && manifest.contributes.sources) || []).map((source) => source.id);
    try {
      db.exec("BEGIN IMMEDIATE");
      stmts.deletePackage.run(packageId);
      for (const sourceId of sourceIds) stmts.deleteUserSourcesBySource.run(sourceId);
      stmts.deleteExtensionStoreByExtension.run(packageId);
      db.exec("COMMIT");
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch (_) {}
      throw err;
    }
    registry.removePackage(packageId);
    try { fs.rmSync(expectedDir, { recursive: true, force: true }); }
    catch (err) { console.error("[extensions] could not remove " + expectedDir + ": " + err.message); }
    return sourceIds;
  }

  // Controlled home migration: stage and validate every package in the new
  // home, promote them only after validation, commit the DB change, reload the
  // registry, and only then remove the old app-owned package directories.
  async function moveExtensionsHome(oldHome, newHome) {
    const resolvedOld = path.resolve(oldHome);
    const resolvedNew = path.resolve(newHome);
    if (resolvedOld === resolvedNew) return;
    if (resolvedNew.startsWith(resolvedOld + path.sep) || resolvedOld.startsWith(resolvedNew + path.sep)) {
      throw new Error("Extensions home and its new location must not contain each other");
    }

    const packages = stmts.getAllPackages.all();
    const migrateRoot = path.join(newHome, ".migrate", randomUUID());
    const newExtDir = path.join(resolvedNew, "extensions");
    // The migration owns directory creation and only after validation passed.
    fs.mkdirSync(migrateRoot, { recursive: true });
    fs.mkdirSync(newExtDir, { recursive: true });

    // Stage + validate every package before any setting/DB mutation. Old
    // install dirs stay untouched and the running registry stays live.
    // A directory is app-owned only when it is exactly
    // <oldHome>/extensions/<package id>.
    const staged = [];
    try {
      for (const pkg of packages) {
        const ownedDir = path.join(resolvedOld, "extensions", pkg.id);
        if (path.resolve(pkg.install_dir) !== ownedDir) {
          throw new Error("Refusing to migrate package outside the extensions layout: " + pkg.id);
        }
        const to = path.join(resolvedNew, "extensions", pkg.id);
        if (fs.existsSync(to)) {
          throw new Error("Destination already exists in the new extensions home: " + pkg.id);
        }
        const stage = path.join(migrateRoot, pkg.id);
        fs.cpSync(pkg.install_dir, stage, { recursive: true });
        parseManifest(fs.readFileSync(path.join(stage, "extension.json"), "utf-8"));
        // Validate the server runtime loads before promoting the stage.
        const probe = new ExtensionRegistry(serverRuntime);
        await probe.load(stage);
        staged.push({ id: pkg.id, from: pkg.install_dir, stage, to, promoted: false });
      }

      // Promote staged copies into the new stable layout (still pre-commit).
      for (const s of staged) {
        fs.renameSync(s.stage, s.to);
        s.promoted = true;
      }
    } catch (err) {
      // Remove only copies created by this migration, never pre-existing files.
      for (const s of staged) {
        try { if (s.promoted) fs.rmSync(s.to, { recursive: true, force: true }); else fs.rmSync(s.stage, { recursive: true, force: true }); } catch (_) {}
      }
      fs.rmSync(migrateRoot, { recursive: true, force: true });
      throw err;
    }
    fs.rmSync(migrateRoot, { recursive: true, force: true });

    // Commit package paths + extensions home in one DB transaction.
    db.exec("BEGIN IMMEDIATE");
    try {
      for (const s of staged) stmts.updatePackageInstallDir.run(s.to, s.id);
      stmts.setSetting.run("extensions_home", newHome);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      // Keep the old paths/settings intact and remove only the newly promoted dirs.
      for (const s of staged) fs.rmSync(s.to, { recursive: true, force: true });
      throw err;
    }

    // Reload the runtime registry from the new home. Old dirs are removed only
    // when every package reloads; otherwise keep both copies for recovery.
    let allReloaded = true;
    registry.entries.clear();
    for (const pkg of stmts.getAllPackages.all()) {
      try {
        await registry.load(pkg.install_dir);
      } catch (err) {
        allReloaded = false;
        console.error("[extensions] failed to reload " + pkg.id + ": " + err.message);
      }
    }
    if (allReloaded) {
      for (const s of staged) fs.rmSync(s.from, { recursive: true, force: true });
    } else {
      console.error("[extensions] home migration committed but reload failed; keeping old package copies");
    }
  }

  const app = express();

  // --- CORS ---
  function corsMiddleware(req, res, next) {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
    // Reflect whatever headers the browser requests — supports any
    // custom header (Authorization, X-Custom, etc.) without hardcoding.
    res.setHeader("Access-Control-Allow-Headers",
      req.headers["access-control-request-headers"] || "Content-Type");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  }

  app.use(express.json({ limit: "50mb" }));
  app.use(corsMiddleware);

  // A client served by this Node process discovers its exact origin instead
  // of guessing host names or ports from the UI.
  app.get("/mangayomu-runtime.json", function (req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      kind: "mangayomu-server",
      serverUrl: req.protocol + "://" + req.get("host"),
      apiBase: "/api"
    });
  });
  app.get("/api/health", function (_req, res) {
    res.json({ ok: true, name: "MangaYomu" });
  });

  // Local addresses of this server, so a client can show a QR code that opens
  // the same instance from another device. Public like /api/health: these are
  // the addresses a device on the same network would discover anyway, and the
  // port is the one this very request arrived on.
  app.get("/api/network", function (req, res) {
    const addresses = [];
    const interfaces = os.networkInterfaces();
    for (const [name, entries] of Object.entries(interfaces)) {
      for (const entry of entries || []) {
        if (entry.family !== "IPv4" || entry.internal) continue;
        addresses.push({ interface: name, address: entry.address });
      }
    }
    res.setHeader("Cache-Control", "no-store");
    res.json({ port: req.socket.localPort, addresses });
  });

  // --- Auth middleware ---
  const auth = requireAuth(stmts);

  function requireAdmin(req, res, next) {
    const row = stmts.isAdmin.get(Number(req.userId));
    if (!row || !row.is_admin) return res.status(403).json({ error: "Admin role required" });
    next();
  }

  // Image tags cannot carry an Authorization header, so the client propagates
  // its active server-session token as a query parameter for this route only.
  function requireProxyAuth(req, res, next) {
    const authHeader = req.headers["authorization"] || "";
    const token = authHeader.replace("Bearer ", "") || String(req.query.access_token || "");
    if (!token) return res.status(401).json({ error: "Non autenticato" });
    const session = stmts.getSession.get(token);
    if (!session) return res.status(401).json({ error: "Non autenticato" });
    req.userId = String(session.user_id);
    next();
  }

  // =====================================================================
  //  Routes
  // =====================================================================

  // --- Image proxy ---

  app.get("/api/proxy/image", requireProxyAuth, async function (req, res) {
    const imgUrl = req.query.url;
    const sourceId = req.query.source;
    if (!imgUrl) return res.status(400).json({ error: "Missing url param" });
    if (!sourceId) return res.status(400).json({ error: "Missing source param" });
    // Only an enabled source for the requesting user may be proxied.
    const ext = enabledSource(req, res, sourceId);
    if (!ext) return;
    try {
      // Extension-owned tokens (mangayomu-image://...) are dispatched to the
      // enabled source's request handler instead of a network fetch. The
      // source resolves the token strictly inside its own user-scoped roots.
      const token = parseExtensionImageUrl(imgUrl);
      if (token) {
        const result = await ext.extensionRequest({
          method: "GET",
          path: token.path,
          query: token.query,
          body: {},
          userId: String(req.userId),
        });
        if (isBinaryResult(result)) {
          res.setHeader("Content-Type", result.contentType);
          res.setHeader("Cache-Control", "public, max-age=86400");
          return res.end(result.body);
        }
        if (isRedirectResult(result)) {
          // Remote cover redirects are fetched through the normal proxy so the
          // upstream header policy (UA/Referer/extension headers) still applies;
          // only relative/local targets are handed back to the browser.
          if (shouldProxyRedirect(result.location)) {
            const imgData = await fetchImage(result.location, sourceId);
            res.setHeader("Content-Type", imgData.type);
            res.setHeader("Cache-Control", "public, max-age=86400");
            return res.end(imgData.body);
          }
          res.setHeader("Cache-Control", "no-store");
          return res.redirect(result.status, result.location);
        }
        throw new Error("Extension image handler returned an unexpected response");
      }
      const imgData = await fetchImage(imgUrl, sourceId);
      res.setHeader("Content-Type", imgData.type);
      res.setHeader("Cache-Control", "public, max-age=86400");
      res.end(imgData.body);
    } catch (err) {
      res.status(502).json({ error: "Image fetch failed: " + err.message });
    }
  });

  function generateSyncPin() {
  // 6-digit random PIN
  return String(randomInt(100000, 999999));
}

function nowSql() {
  return new Date().toISOString().replace("T", " ").replace(/\..+/, "");
}

// --- Auth ---

  app.post("/api/auth/signup", async function (req, res) {
    var body = req.body || {};
    var email = (body.email || "").trim().toLowerCase();
    var password = body.password || "";
    if (!email || !password) return res.status(400).json({ error: "Email e password richieste" });
    if (password.length < 4) return res.status(400).json({ error: "Password minima 4 caratteri" });
    var existing = stmts.getUserByEmail.get(email);
    if (existing) return res.status(409).json({ error: "Email is already registered" });

    var syncKey = generateSyncPin();
    var hash = bcrypt.hashSync(password, 4);
    var token = randomUUID();
    var userId;
    db.exec("BEGIN IMMEDIATE");
    try {
      // The first registered user is the server admin.
      var isAdmin = stmts.countAdmins.get().c === 0 ? 1 : 0;
      var info = stmts.insertUser.run(email, hash);
      userId = info.lastInsertRowid;
      stmts.setUserAdmin.run(isAdmin, userId);
      stmts.updateSyncKey.run(syncKey, userId);
      stmts.insertSession.run(userId, token);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      // A concurrent signup may insert the same email between the preliminary
      // lookup and this insert. That external DB boundary is still the known
      // duplicate case, not a generic failure.
      if (String(err && err.message).indexOf("UNIQUE constraint failed") !== -1) {
        return res.status(409).json({ error: "Email is already registered" });
      }
      return res.status(500).json({ error: "Account creation failed" });
    }
    res.json({ token: token, user: { id: userId, email: email, syncKey: syncKey } });
  });

  app.post("/api/auth/login", async function (req, res) {
    var body = req.body || {};
    var email = (body.email || "").trim().toLowerCase();
    var password = body.password || "";
    if (!email || !password) return res.status(400).json({ error: "Email e password richieste" });
    var user = stmts.getUserByEmail.get(email);
    if (!user) return res.status(401).json({ error: "Email non trovata" });
    var ok = bcrypt.compareSync(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: "Incorrect password" });
    var token = randomUUID();
    stmts.insertSession.run(user.id, token);
    res.json({ token: token, user: { id: user.id, email: user.email } });
  });

  app.get("/api/auth/me", function (req, res) {
    var authHeader = req.headers["authorization"] || "";
    var token = authHeader.replace("Bearer ", "");
    var session = stmts.getSession.get(token);
    if (!session) return res.status(401).json({ error: "Non autenticato" });
    var admin = stmts.isAdmin.get(session.user_id);
    res.json({ user: { id: session.user_id, email: session.email, is_admin: admin ? admin.is_admin : 0 } });
  });

  app.post("/api/auth/logout", function (req, res) {
    var authHeader = req.headers["authorization"] || "";
    var token = authHeader.replace("Bearer ", "");
    if (token) stmts.deleteSession.run(token);
    res.json({ ok: true });
  });

  // --- Sync key management ---

  app.post("/api/auth/sync-key", auth, function (req, res) {
    var body = req.body || {};
    var syncKey = body.pin;
    if (syncKey) {
      // User-set PIN: validate format
      syncKey = String(syncKey).trim();
      if (!/^\d{4,8}$/.test(syncKey)) {
        return res.status(400).json({ error: "Il PIN deve essere di 4-8 cifre" });
      }
    } else {
      // Auto-generate 6-digit PIN
      syncKey = generateSyncPin();
    }
    stmts.updateSyncKey.run(syncKey, req.userId);
    res.json({ syncKey: syncKey });
  });

  app.get("/api/auth/sync-key", auth, function (req, res) {
    var user = db.prepare("SELECT email, sync_key FROM users WHERE id = ?").get(req.userId);
    if (!user) return res.status(404).json({ error: "Utente non trovato" });
    res.json({ syncKey: user.sync_key || null, email: user.email });
  });

  // --- Favorites ---

  app.get("/api/favorites", auth, function (req, res) {
    res.json(stmts.getFavorites.all(req.userId));
  });

  app.post("/api/favorites", auth, function (req, res) {
    var body = req.body;
    var mangaId = body.manga_id;
    var source = body.source;
    var title = body.title || "";
    var coverUrl = body.cover_url || "";
    if (!mangaId) return res.status(400).json({ error: "manga_id richiesto" });
    stmts.insertFavorite.run(req.userId, mangaId, source, title, coverUrl);
    res.json({ ok: true });
  });

  app.post("/api/favorites/check", auth, function (req, res) {
    var body = req.body;
    var ids = body.mangaIds || [];
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.json({ favorited: {} });
    }
    var all = stmts.getFavorites.all(req.userId);
    var favSet = {};
    for (var fi = 0; fi < all.length; fi++) {
      favSet[all[fi].manga_id] = true;
    }
    var result = {};
    for (var fi = 0; fi < ids.length; fi++) {
      result[ids[fi]] = !!favSet[ids[fi]];
    }
    res.json({ favorited: result });
  });

  app.delete("/api/favorites/:mangaId(*)", auth, function (req, res) {
    var mangaId = decodeURIComponent(req.params.mangaId);
    stmts.softDeleteFavorite.run(req.userId, mangaId);
    res.json({ ok: true });
  });

  // --- Extensions ---

  /**
   * Resolve a source for the authenticated user. Writes the error response
   * and returns null when the source is missing, disabled, or failed to load.
   */
  function enabledSource(req, res, sourceId) {
    const meta = registry.metadata(sourceId);
    if (!meta) {
      res.status(404).json({ error: "Source not installed: " + sourceId });
      return null;
    }
    const row = stmts.getUserSource.get(req.userId, sourceId);
    if (!row || !row.enabled) {
      res.status(403).json({ error: "Source not enabled for this user" });
      return null;
    }
    const ext = registry.get(sourceId);
    if (!ext) {
      res.status(503).json({ error: "Source failed to load" });
      return null;
    }
    return ext;
  }

  /**
   * True when an installed package is usable by the requesting user: at least
   * one of its declared sources is enabled, or (for client-only packages with
   * no sources) it is simply installed. Used to gate client modules and the
   * generic extension request route.
   */
  function packageSourcesEnabled(userId, pkg) {
    let manifest;
    try {
      manifest = JSON.parse(pkg.manifest_json);
    } catch (err) {
      return false;
    }
    const sources = (manifest.contributes && manifest.contributes.sources) || [];
    if (sources.length === 0) return true;
    for (const s of sources) {
      const row = stmts.getUserSource.get(userId, s.id);
      if (row && row.enabled) return true;
    }
    return false;
  }

  /**
   * Resolve an installed extension package with client-network metadata for
   * the requesting user. Returns null (and writes the error response) when the
   * package is missing, the user cannot use it, or it has no client module.
   */
  function enabledClientPackage(req, res, packageId) {
    const pkg = stmts.getPackage.get(packageId);
    if (!pkg) {
      res.status(404).json({ error: "Extension not installed" });
      return null;
    }
    if (!packageSourcesEnabled(req.userId, pkg)) {
      res.status(403).json({ error: "Extension is not enabled for this user" });
      return null;
    }
    let manifest;
    try {
      manifest = JSON.parse(pkg.manifest_json);
    } catch (err) {
      res.status(500).json({ error: "Invalid installed manifest" });
      return null;
    }
    if (!manifest.entrypoints || typeof manifest.entrypoints.client !== "string") {
      res.status(404).json({ error: "Extension has no client module" });
      return null;
    }
    return { pkg, manifest };
  }

  // Resolve a stored repository's catalog into a per-user display structure.
  // A single broken repository must not take down the rest of the list.
  async function repositoryCatalogWithState(repo, userId) {
    let catalog;
    try {
      catalog = await resolveRepository(repo.url);
    } catch (err) {
      return { id: repo.id, url: repo.url, name: repo.name || null, error: err.message, packages: [], enabled: !!repo.enabled };
    }
    const enabled = new Set();
    for (const row of stmts.getUserSources.all(userId)) {
      if (row.enabled) enabled.add(row.source_id);
    }
    const packages = catalog.packages.map((entry) => {
      const installed = stmts.getPackage.get(entry.id);
      return {
        id: entry.id,
        name: entry.name || entry.id,
        version: entry.version,
        url: entry.url,
        tags: Array.isArray(entry.tags) ? entry.tags : [],
        installed: !!installed,
        installedVersion: installed ? installed.version : null,
        updateAvailable: installed ? installed.version !== entry.version : false,
        enabled: enabled.has(entry.id),
      };
    });
    return { id: repo.id, url: repo.url, name: repo.name || null, error: null, packages, enabled: !!repo.enabled };
  }

  // List installed repositories with per-user package state (install allowed).
  app.get("/api/extensions/repositories", auth, async function (req, res) {
    const results = [];
    for (const repo of stmts.getAllRepositories.all()) {
      results.push(await repositoryCatalogWithState(repo, req.userId));
    }
    res.json({ repositories: results });
  });

  // Install a single package from a stored repository. Any authenticated user
  // may install from an admin-added repository; activation stays per-user.
  app.post("/api/extensions/repositories/:repoId/install", auth, async function (req, res) {
    const repo = stmts.getRepository.get(req.params.repoId);
    if (!repo) return res.status(404).json({ error: "Repository not found" });
    if (repo.enabled === 0) return res.status(403).json({ error: "Repository is disabled" });
    const packageUrl = req.body && req.body.packageUrl;
    if (!packageUrl) return res.status(400).json({ error: "Package url is required" });
    let catalog;
    try {
      catalog = await resolveRepository(repo.url);
    } catch (err) {
      return res.status(502).json({ error: "Failed to resolve repository catalog: " + err.message });
    }
    const entry = catalog.packages.find((p) => p.url === packageUrl);
    if (!entry) return res.status(403).json({ error: "Package is not part of this repository" });
    try {
      const home = resolveHome();
      const installed = stmts.getPackage.get(entry.id);
      const buffer = await downloadUrl(entry.url);
      if (hashData(buffer) !== entry.sha256) throw new Error("Package checksum mismatch");
      const existing = installed ? { version: installed.version, content_hash: installed.content_hash } : null;
      const result = await installPackage({ buffer, home, existing });
      if (result.status !== "noop") await activateInstalled(result);
      res.json({ ok: true, status: result.status, id: result.id });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Admin: add a repository (validated) or remove one. Adding does not install packages.
  app.post("/api/admin/extensions/repositories", auth, requireAdmin, async function (req, res) {
    const url = (req.body && req.body.url || "").trim();
    if (!url) return res.status(400).json({ error: "Repository url is required" });

    // The trusted catalogs are the allowlist: a repository nobody trusts must
    // not become installable just because it happens to be a valid catalog.
    const trusted = await resolveTrustedCatalogs(resolveTrustedUrls());
    if (!trusted.repositories.includes(url)) {
      let message = "This repository is not trusted by this server. Add it to the trusted registries in Settings → Advanced, then add it here.";
      if (trusted.errors.length > 0) {
        message += " (Trusted catalogs that could not be resolved: " +
          trusted.errors.map((e) => e.url + ": " + e.error).join("; ") + ")";
      }
      return res.status(403).json({ code: "repository-not-trusted", error: message });
    }

    try {
      // downloadUrl applies the production HTTPS/private-host policy, with
      // the explicit localhost-only dev opt-in handled by the downloader.
      await resolveRepository(url);
    } catch (err) {
      return res.status(400).json({ error: "Invalid repository catalog: " + err.message });
    }
    const name = typeof req.body.name === "string" && req.body.name.trim() ? req.body.name.trim() : null;
    stmts.insertRepository.run(randomUUID(), url, name);
    const row = stmts.getRepositoryByUrl.get(url);
    res.json({ repository: { id: row.id, url: row.url, name: row.name } });
  });

  app.delete("/api/admin/extensions/repositories/:id", auth, requireAdmin, function (req, res) {
    const row = stmts.getRepository.get(req.params.id);
    if (!row) return res.status(404).json({ error: "Repository not found" });
    stmts.deleteRepository.run(req.params.id);
    res.json({ ok: true });
  });

  // Browse catalog: every installed source the current user has enabled.
  app.get("/api/extensions", auth, function (req, res) {
    const enabled = {};
    for (const row of stmts.getUserSources.all(req.userId)) {
      if (row.enabled) enabled[row.source_id] = true;
    }
    res.json(registry.list().filter((meta) => enabled[meta.id]));
  });

  // Settings: every installed source with the current user's activation state.
  app.get("/api/settings/extensions", auth, function (req, res) {
    const enabled = {};
    for (const row of stmts.getUserSources.all(req.userId)) {
      enabled[row.source_id] = !!row.enabled;
    }
    res.json(registry.listDetailed().map((meta) => ({
      ...meta,
      enabled: !!enabled[meta.id],
    })));
  });

  // Enable or disable a source for the current user.
  app.put("/api/settings/extensions/:sourceId", auth, function (req, res) {
    const sourceId = req.params.sourceId;
    if (!registry.metadata(sourceId)) return res.status(404).json({ error: "Source not installed" });
    const enabled = req.body && req.body.enabled ? 1 : 0;
    stmts.setUserSource.run(req.userId, sourceId, enabled);
    res.json({ ok: true, enabled: !!enabled });
  });

  // Installed packages with a client module the requesting user may use.
  app.get("/api/extensions/installed", auth, function (req, res) {
    const out = [];
    for (const pkg of stmts.getAllPackages.all()) {
      let manifest;
      try {
        manifest = JSON.parse(pkg.manifest_json);
      } catch (err) {
        continue;
      }
      if (!manifest.entrypoints || typeof manifest.entrypoints.client !== "string") continue;
      if (!packageSourcesEnabled(req.userId, pkg)) continue;
      const client = manifest.contributes && manifest.contributes.client;
      out.push({
        packageId: pkg.id,
        name: pkg.name,
        version: pkg.version,
        clientEntry: manifest.entrypoints.client,
        settingsPanels: client && Array.isArray(client.settingsPanels) ? client.settingsPanels : [],
        browseSources: client && Array.isArray(client.browseSources) ? client.browseSources : [],
      });
    }
    res.json({ extensions: out });
  });

  // Serve a browser module from an installed package's client/ directory.
  // Image tags cannot send an Authorization header; like the image proxy this
  // route also accepts the active session token as a query parameter so a
  // dynamic import() can authenticate it.
  app.get("/api/extensions/client-module/:packageId/*", requireProxyAuth, async function (req, res) {
    const gate = enabledClientPackage(req, res, req.params.packageId);
    if (!gate) return;
    const file = req.params[0];
    let abs;
    try {
      abs = resolveClientModulePath(gate.pkg.install_dir, file);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      return res.status(404).json({ error: "Client module file not found" });
    }
    res.setHeader("Content-Type", clientContentType(file));
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(abs).pipe(res);
  });

  // Generic authenticated per-user request handled by an installed extension.
  // The core never touches extension data or host filesystem; the package's
  // server entry decides what this endpoint means. Like the image proxy and
  // client-module routes it accepts the active session token as a query
  // parameter so <img> and dynamically imported modules can authenticate.
  app.all("/api/extensions/:extensionId/request*", requireProxyAuth, async function (req, res) {
    const pkg = stmts.getPackage.get(req.params.extensionId);
    if (!pkg) return res.status(404).json({ error: "Extension not installed" });
    if (!packageSourcesEnabled(req.userId, pkg)) {
      return res.status(403).json({ error: "Extension is not enabled for this user" });
    }
    let manifest;
    try {
      manifest = JSON.parse(pkg.manifest_json);
    } catch (err) {
      return res.status(500).json({ error: "Invalid installed manifest" });
    }
    const sources = (manifest.contributes && manifest.contributes.sources) || [];
    if (sources.length === 0) {
      return res.status(404).json({ error: "Extension does not expose a request handler" });
    }
    let source = null;
    for (const s of sources) {
      const entry = registry.entry(s.id);
      if (entry && typeof entry.source.extensionRequest === "function") {
        source = entry.source;
        break;
      }
    }
    if (!source) {
      return res.status(404).json({ error: "Extension does not expose a request handler" });
    }
    try {
      const result = await source.extensionRequest({
        method: req.method,
        path: req.params[0] || "",
        query: req.query,
        body: req.body || {},
        userId: String(req.userId),
      });
      if (result === undefined || result === null) return res.json({ ok: true });
      // Binary payloads (images, fonts, archives) and redirects are served
      // with their declared status/content type; everything else is JSON.
      if (isRedirectResult(result)) return res.redirect(result.status, result.location);
      if (isBinaryResult(result)) {
        res.status(result.status || 200);
        res.setHeader("Content-Type", result.contentType);
        return res.end(result.body);
      }
      // JSON results arrive as { status, contentType, body } from the extension
      // contract. Serve the inner body with its declared status so the host
      // client receives clean JSON and real error codes (400/403/404) instead
      // of a 200 envelope the browser could not detect.
      if (typeof result === "object" && result !== null && typeof result.status === "number" && "body" in result) {
        return res.status(result.status).json(result.body === undefined ? {} : result.body);
      }
      return res.json(result);
    } catch (err) {
      console.error("[extensions] request failed", { extensionId: pkg.id, path: req.params[0], message: err.message });
      return res.status(400).json({ error: err.message || "Extension request failed" });
    }
  });

  // Trusted discovery for every authenticated user (no install rights implied).
  app.get("/api/extensions/discover", auth, async function (req, res) {
    const trustedUrls = resolveTrustedUrls();
    if (trustedUrls.length === 0) return res.json({ configured: false, packages: [], repositories: [], errors: [] });

    const { packages: catalog, repositories, errors } = await resolveTrustedCatalogs(trustedUrls);
    if (catalog.size === 0 && errors.length > 0) {
      return res.status(502).json({
        error: "Failed to resolve trusted catalog: " + errors.map((e) => e.url + ": " + e.error).join("; "),
      });
    }

    const packages = Array.from(catalog.values()).map((entry) => {
      const installed = stmts.getPackage.get(entry.id);
      const hosted = registry.metadata(entry.id);
      return {
        id: entry.id,
        name: entry.name,
        version: entry.version,
        url: entry.url,
        hasSha256: !!entry.sha256,
        repository: entry.repository || null,
        registry: entry.registry || null,
        installed: !!installed,
        installedVersion: installed ? installed.version : null,
        hostedVersion: hosted ? hosted.version : null,
        updateAvailable: installed ? installed.version !== entry.version : false,
      };
    });
    res.json({ configured: true, packages, repositories, errors });
  });

  // Install or update a package that is part of the trusted registry. The
  // client only supplies the package URL; metadata comes from the catalog.
  app.post("/api/extensions/install-trusted", auth, async function (req, res) {
    const url = req.body && req.body.url;
    if (!url) return res.status(400).json({ error: "Package url is required" });
    const trustedUrls = resolveTrustedUrls();
    if (trustedUrls.length === 0) return res.status(403).json({ error: "No trusted registry configured" });

    const { packages: catalog, errors } = await resolveTrustedCatalogs(trustedUrls);
    const entry = catalog.get(url);
    if (!entry) {
      if (errors.length > 0) {
        return res.status(502).json({
          error: "Failed to resolve trusted catalog: " + errors.map((e) => e.url + ": " + e.error).join("; "),
        });
      }
      return res.status(403).json({ error: "Package is not part of the trusted registries" });
    }
    try {
      const home = resolveHome();
      const installed = stmts.getPackage.get(entry.id);
      const buffer = await downloadUrl(entry.url);
      if (hashData(buffer) !== entry.sha256) {
        throw new Error("Package checksum mismatch");
      }
      const existing = installed ? { version: installed.version, content_hash: installed.content_hash } : null;
      const result = await installPackage({ buffer, home, existing });
      if (result.status !== "noop") await activateInstalled(result);
      res.json({ ok: true, status: result.status });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Admin: server-wide settings (extensions home and trusted registry URL).
  app.get("/api/admin/settings", auth, requireAdmin, function (req, res) {
    res.json(settingsSummary());
  });

  app.put("/api/admin/settings", auth, requireAdmin, async function (req, res) {
    const body = req.body || {};
    const newHome = typeof body.extensionsHome === "string" && body.extensionsHome.trim() ? body.extensionsHome.trim() : null;
    const hasTrustedList = Array.isArray(body.trustedRegistryUrls);
    const hasLegacyTrusted = typeof body.trustedRegistryUrl === "string";
    const currentHome = resolveHome();
    try {
      if (newHome && newHome !== currentHome) {
        await moveExtensionsHome(currentHome, newHome);
      }
      if (hasTrustedList || hasLegacyTrusted) {
        const urls = normalizeTrustedUrls(hasTrustedList ? body.trustedRegistryUrls : [body.trustedRegistryUrl]);
        writeTrustedUrls(urls);
      }
      if (typeof body.androidBuildEnabled === "boolean") {
        stmts.setSetting.run("android_build_enabled", body.androidBuildEnabled ? "1" : "0");
      }
      if (typeof body.androidBuildsUrl === "string") {
        const buildsUrl = body.androidBuildsUrl.trim().replace(/\/+$/, "");
        // Clearing it disables the published-builds fallback entirely.
        if (buildsUrl && !/^https?:\/\//.test(buildsUrl)) throw new Error("The builds URL must start with http:// or https://");
        stmts.setSetting.run("android_builds_url", buildsUrl);
      }
      res.json(settingsSummary());
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // Admin: uninstall a server-wide extension package for every user.
  app.delete("/api/admin/extensions/:packageId", auth, requireAdmin, function (req, res) {
    if (!stmts.getPackage.get(req.params.packageId)) {
      return res.status(404).json({ error: "Extension is not installed" });
    }
    try {
      const sourceIds = removeInstalledPackage(req.params.packageId);
      res.json({ ok: true, id: req.params.packageId, sourceIds });
    } catch (err) {
      console.error("[extensions] could not remove " + req.params.packageId + ": " + err.message);
      res.status(500).json({ error: "Could not remove extension" });
    }
  });

  // Admin: ZIP upload via multipart form.
  app.post("/api/admin/extensions/upload", auth, requireAdmin, function (req, res) {
    const bb = busboy({ headers: req.headers, limits: { files: 1, fileSize: MAX_UPLOAD_BYTES } });
    let buffer = null;
    let tooLarge = false;
    let parseError = "";
    let answered = false;
    bb.on("file", function (_name, stream) {
      const chunks = [];
      stream.on("data", function (chunk) { chunks.push(chunk); });
      stream.on("limit", function () { tooLarge = true; });
      stream.on("end", function () {
        if (chunks.length > 0) buffer = Buffer.concat(chunks);
      });
    });
    bb.on("error", function (err) { parseError = err.message; });
    bb.on("close", async function () {
      if (answered) return;
      answered = true;
      try {
        if (parseError) return res.status(400).json({ error: parseError });
        if (tooLarge) return res.status(400).json({ error: "Package file is too large" });
        if (!buffer || buffer.length === 0) return res.status(400).json({ error: "Package file is required" });
        const home = resolveHome();
        const manifest = await peekManifest(buffer);
        const installed = stmts.getPackage.get(manifest.id);
        const existing = installed ? { version: installed.version, content_hash: installed.content_hash } : null;
        const result = await installPackage({ buffer, home, existing });
        if (result.status !== "noop") await activateInstalled(result);
        res.json({ ok: true, status: result.status, id: result.id });
      } catch (err) {
        res.status(400).json({ error: err.message });
      }
    });
    req.pipe(bb);
  });

  // Admin: install from an arbitrary HTTPS package URL.
  app.post("/api/admin/extensions/install-url", auth, requireAdmin, async function (req, res) {
    const body = req.body || {};
    const url = body.url;
    if (!url) return res.status(400).json({ error: "Package url is required" });
    try {
      const home = resolveHome();
      const buffer = await downloadUrl(url);
      const manifest = await peekManifest(buffer);
      const installed = stmts.getPackage.get(manifest.id);
      const existing = installed ? { version: installed.version, content_hash: installed.content_hash } : null;
      const result = await installPackage({ buffer, home, existing });
      if (result.status !== "noop") await activateInstalled(result);
      res.json({ ok: true, status: result.status, id: result.id });
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

  // The server does not own a reader's source-language preference. It is
  // supplied by the selected client for each catalog, detail, and feed call.
  // userId is passed so per-user sources (e.g. Local Source roots) can resolve
  // the requesting account; HTTP sources ignore it.
  function sourceRequestOptions(query, userId) {
    const options = { userId: String(userId) };
    if (typeof query.lang === "string") {
      options.languages = query.lang.split(",").map((language) => language.trim()).filter(Boolean);
    }
    return options;
  }

  // --- Manga list (latest) ---

  app.get("/api/manga/:source", auth, async function (req, res) {
    const source = req.params.source;
    let page = parseInt(req.query.page || "1");
    if (page < 1) page = 1;
    const ext = enabledSource(req, res, source);
    if (!ext) return;
    try {
      const mangaList = await ext.getLatestManga(page, sourceRequestOptions(req.query, req.userId));
      for (const m of mangaList) {
        stmts.upsertMangaThumb.run(m.id, m.source, m.title, m.coverUrl);
      }
      res.json(mangaList);
    } catch (e) {
      console.error("[manga] " + source + ":", e.message);
      // Se l'estensione fallisce, ritorna una lista vuota invece di crashare
      res.json([]);
    }
  });

  // --- Manga sub-routes (detail / chapters) ---
  // A manga id can contain slashes (for example a numeric id plus a slug).
  app.get("/api/manga/:source/*", auth, async function (req, res) {
    const source = req.params.source;
    const ext = enabledSource(req, res, source);
    if (!ext) return;

    var rest = req.params[0]; // everything after :source/
    if (!rest) return res.status(404).json({ error: "Not found" });

    // Chapters: /api/manga/:source/:mangaId/chapters
    if (rest.endsWith("/chapters")) {
      var mangaIdDecoded = decodeURIComponent(rest.slice(0, -"/chapters".length));
      var chapters;
      try {
        chapters = await ext.getChapters(mangaIdDecoded, sourceRequestOptions(req.query, req.userId));
      } catch (err) {
        var cached = stmts.countChapters.get(mangaIdDecoded);
        if (cached && cached.cnt > 0) {
          var cachedList = stmts.getChapters.all(mangaIdDecoded);
          var requestLangs = sourceRequestOptions(req.query).languages || [];
          if (cachedList.length > 0 && requestLangs.length > 0 && cachedList[0].lang !== requestLangs[0]) {
            stmts.updateLang.run(requestLangs[0], mangaIdDecoded, requestLangs[0]);
            cachedList = stmts.getChapters.all(mangaIdDecoded);
          }
          return res.json(cachedList);
        }
        return res.status(500).json({ error: "Chapters error: " + err.message });
      }
      // Batch-fetch cached page counts (1 query, non-zero only)
      var cachedPageCounts = {};
      var cachedRows = stmts.getChaptersPageCounts.all(mangaIdDecoded);
      for (var cr = 0; cr < cachedRows.length; cr++) {
        cachedPageCounts[cachedRows[cr].id] = cachedRows[cr].page_count;
      }

      for (var ci = 0; ci < chapters.length; ci++) {
        var ch = chapters[ci];
        var pageCount = ch.pageCount || cachedPageCounts[ch.id] || 0;
        stmts.upsertChapter.run(
          ch.id, mangaIdDecoded, ch.chapterNumber, ch.volume,
          ch.title, ch.lang, pageCount, ch.createdAt
        );
        ch.pageCount = pageCount;
      }
      return res.json(chapters);
    }

    // Detail: /api/manga/:source/:mangaId
    var mangaIdDecoded = decodeURIComponent(rest);
    try {
      const detail = await ext.getMangaDetail(mangaIdDecoded, sourceRequestOptions(req.query, req.userId));
      stmts.upsertManga.run(
        detail.id, detail.source, detail.title, detail.coverUrl,
        detail.description, detail.authors.join(", "),
        detail.genres.join(", "), detail.status
      );
      stmts.updateFavCover.run(detail.coverUrl, mangaIdDecoded, detail.coverUrl);
      res.json(detail);
    } catch (e) {
      res.status(500).json({ error: "Manga detail error: " + e.message });
    }
  });

  // --- Search ---

  app.get("/api/search/:source", auth, async function (req, res) {
    const source = req.params.source;
    const query = req.query.q;
    const page = parseInt(req.query.page || "1");
    if (!query) return res.status(400).json({ error: "Missing query param q" });
    const ext = enabledSource(req, res, source);
    if (!ext) return;
    try {
      const results = await ext.searchManga(query, page, sourceRequestOptions(req.query, req.userId));
      res.json(results);
    } catch (err) {
      res.status(502).json({ error: "Search error: " + err.message });
    }
  });

  // --- Chapter pages ---

  app.get("/api/chapter/:chapterId/pages", auth, async function (req, res) {
    const chapterId = req.params.chapterId;
    const row = stmts.getChapterSource.get(chapterId);

    if (row) {
      const ext = enabledSource(req, res, row.source);
      if (!ext) return;
      try {
        const pages = await ext.getChapterPages(chapterId, row.manga_id, { userId: String(req.userId) });
        // Cache page count for future chapter list requests
        if (pages.urls && pages.urls.length > 0) {
          stmts.updateChapterPageCount.run(pages.urls.length, chapterId);
        }
        return res.json(pages);
      } catch (err) {
        const status = upstreamErrorStatus(err);
        console.warn("[pages] source request failed", { source: row.source, chapterId, status, message: err.message });
        return res.status(status).json({ error: err.message || "Chapter page request failed" });
      }
    }

    // Fallback: try only the sources enabled for this user.
    let lastError = null;
    const enabled = {};
    for (const row of stmts.getUserSources.all(req.userId)) {
      if (row.enabled) enabled[row.source_id] = true;
    }
    for (const meta of registry.list()) {
      if (!enabled[meta.id]) continue;
      const ext = registry.get(meta.id);
      if (!ext) continue;
      try {
        const pages = await ext.getChapterPages(chapterId, null, { userId: String(req.userId) });
        return res.json(pages);
      } catch (err) {
        lastError = err;
        console.warn("[pages] fallback failed", { source: meta.id, chapterId, status: upstreamErrorStatus(err), message: err.message });
      }
    }
    if (lastError) {
      return res.status(upstreamErrorStatus(lastError)).json({ error: lastError.message || "Chapter page request failed" });
    }
    res.status(404).json({ error: "Chapter not found" });
  });

  // --- Reading progress ---

  app.put("/api/progress/:mangaId(*)/chapter/:chapterId(*)", auth, async function (req, res) {
    var mangaId = req.params.mangaId;
    var chapterId = req.params.chapterId;
    var body = req.body || {};
    var pageIndex = body.pageIndex ?? 0;
    var completed = body.completed ? 1 : 0;
    stmts.upsertProgress.run(mangaId, chapterId, req.userId, pageIndex, completed);
    res.json({ ok: true });
  });

  app.get("/api/progress/:mangaId(*)/chapter/:chapterId(*)", auth, function (req, res) {
    var mangaId = req.params.mangaId;
    var chapterId = req.params.chapterId;
    var row = stmts.getChapterProgress.get(mangaId, chapterId, req.userId);
    res.json(row || { page_index: 0, completed: 0 });
  });

  app.get("/api/progress/since/:since(*)", auth, function (req, res) {
    var rows = stmts.getProgressTimestamps.all(req.userId, req.params.since);
    res.json(rows);
  });

  app.get("/api/progress/:mangaId(*)", auth, function (req, res) {
    var mangaId = req.params.mangaId;
    res.json(stmts.getProgress.all(mangaId, req.userId));
  });

  // The backup file is decoded only in the client. This endpoint accepts the
  // already-normalized JSON and uses the same shared apply loop as client-only.
  app.post("/api/import/normalized", auth, async function (req, res) {
    if (!req.body || !Array.isArray(req.body.manga)) {
      return res.status(400).json({ error: "Payload import non valido" });
    }
    const target = {
      saveManga: async (item) => stmts.upsertManga.run(item.id, item.source, item.title, item.coverUrl, item.description, item.author, item.genres.join(", "), "unknown"),
      saveFavorite: async (item) => stmts.insertFavorite.run(req.userId, item.id, item.source, item.title, item.coverUrl),
      saveProgress: async (item, chapter) => {
        stmts.upsertChapter.run(chapter.id, item.id, chapter.chapterNumber, null, chapter.title, chapter.lang, 0, null);
        stmts.upsertProgress.run(item.id, chapter.id, req.userId, chapter.pageIndex, chapter.completed ? 1 : 0);
      },
    };
    const summary = await applyBackup(req.body, target);
    res.json({ ok: true, summary });
  });

  // =====================================================================
  //  Sync (peer-to-peer via sync key)
  // =====================================================================

  /** Verify sync credentials: email + plain-text sync key */
  function validateSync(email, syncKey) {
    if (!email || !syncKey) return null;
    var user = stmts.getUserByEmail.get(email);
    if (!user || !user.sync_key) return null;
    if (syncKey !== user.sync_key) return null;
    return user;
  }

  app.post("/api/sync/hello", async function (req, res) {
    var body = req.body || {};
    var user = validateSync(body.email, body.syncKey);
    if (!user) return res.status(401).json({ error: "Email o sync key non validi" });
    res.json({ found: true, serverTime: nowSql(), protocolVersion: 2 });
  });

  // =====================================================================
  //  Sync v2 — manifest-based reconciliation
  // =====================================================================

  /** Helper: batch IN queries for pull (accept SQL string, not statement — IN clause is built dynamically) */
  function batchQuery(sqlPrefix, userId, keys, batchSize) {
    batchSize = batchSize || 200;
    var results = [];
    for (var i = 0; i < keys.length; i += batchSize) {
      var batch = keys.slice(i, i + batchSize);
      var placeholders = batch.map(function () { return "?"; }).join(",");
      var sql = sqlPrefix + placeholders + ")";
      var stmt = db.prepare(sql);
      var params = [userId].concat(batch);
      var rows = stmt.all.apply(stmt, params);
      for (var j = 0; j < rows.length; j++) results.push(rows[j]);
    }
    return results;
  }

  // 1. Manifest — full key list with timestamps (stateless)
  app.post("/api/sync/manifest", async function (req, res) {
    var email = req.body.email || "";
    var syncKey = req.body.syncKey || "";

    var user = validateSync(email, syncKey);
    if (!user) return res.status(401).json({ error: "Email o sync key non validi" });

    var favorites = stmts.getFavoriteManifest.all(user.id);
    var progress = stmts.getProgressManifest.all(user.id);

    res.json({
      serverTime: nowSql(),
      favorites: favorites,
      progress: progress,
    });
  });

  // 2. Pull — fetch full records for specific keys (from toPull)
  app.post("/api/sync/pull", async function (req, res) {
    var body = req.body || {};
    var user = validateSync(body.email, body.syncKey);
    if (!user) return res.status(401).json({ error: "Email o sync key non validi" });

    var favoriteKeys = body.favoriteKeys || [];
    var progressKeys = body.progressKeys || [];

    var favorites = batchQuery(stmts.SQL_FAVORITES_BY_KEYS, user.id, favoriteKeys);
    var progress = batchQuery(stmts.SQL_PROGRESS_BY_KEYS, user.id, progressKeys);

    res.json({
      serverTime: nowSql(),
      favorites: favorites,
      progress: progress,
    });
  });

  // 3. Push — send local changes (favorites + progress, including deleted_at)
  app.post("/api/sync/push", async function (req, res) {
    var body = req.body || {};
    var user = validateSync(body.email, body.syncKey);
    if (!user) return res.status(401).json({ error: "Email o sync key non validi" });

    var favorites = body.favorites || [];
    var progress = body.progress || [];

    for (var i = 0; i < favorites.length; i++) {
      var f = favorites[i];
      stmts.upsertFavoriteConditionalV2.run(
        user.id, f.manga_id, f.source, f.title, f.cover_url,
        f.updated_at, f.deleted_at || null
      );
    }

    for (var i = 0; i < progress.length; i++) {
      var p = progress[i];
      stmts.upsertProgressConditionalV2.run(
        p.manga_id, p.chapter_id, user.id, p.page_index, p.completed,
        p.updated_at, p.deleted_at || null
      );
    }

    res.json({ ok: true });
  });

  // Local apply (token-auth) — called by sync client to apply pulled data locally
  app.post("/api/sync/local-apply", auth, async function (req, res) {
    var body = req.body || {};
    var favorites = body.favorites || [];
    var progress = body.progress || [];

    db.exec("BEGIN");

    try {
      for (var i = 0; i < favorites.length; i++) {
        var f = favorites[i];
        stmts.upsertFavoriteConditionalV2.run(
          req.userId, f.manga_id, f.source, f.title, f.cover_url,
          f.updated_at, f.deleted_at || null
        );
      }

      for (var i = 0; i < progress.length; i++) {
        var p = progress[i];
        stmts.upsertProgressConditionalV2.run(
          p.manga_id, p.chapter_id, req.userId, p.page_index, p.completed,
          p.updated_at, p.deleted_at || null
        );
      }

      db.exec("COMMIT");
      res.json({ ok: true });
    } catch (err) {
      try { db.exec("ROLLBACK"); } catch (_) {}
      res.status(500).json({ error: "Errore applicazione dati: " + err.message });
    }
  });

  // Local manifest (token-auth) — for client to compute its own diff
  app.get("/api/sync/local-manifest", auth, async function (req, res) {
    var favorites = stmts.getFavoriteManifest.all(req.userId);
    var progress = stmts.getProgressManifest.all(req.userId);
    res.json({
      serverTime: nowSql(),
      favorites: favorites,
      progress: progress,
    });
  });

  // Full local data for push (includes deleted items)
  app.post("/api/sync/local-push-data", auth, async function (req, res) {
    var body = req.body || {};
    var favKeys = Array.isArray(body.favKeys) ? body.favKeys : [];
    var progKeys = Array.isArray(body.progKeys) ? body.progKeys : [];
    var favorites = favKeys.length > 0 ? batchQuery(stmts.SQL_FAVORITES_BY_KEYS, req.userId, favKeys) : [];
    var progress = progKeys.length > 0 ? batchQuery(stmts.SQL_PROGRESS_BY_KEYS, req.userId, progKeys) : [];
    res.json({ favorites: favorites, progress: progress });
  });

  // =====================================================================
  //  Build info & APK download (sync)
  // =====================================================================

  var __dir = path.dirname(fileURLToPath(import.meta.url));
  var BUILD_DIR = path.resolve(__dir, "..", "..", "..", "builds");

  // Published builds: the installers are assets of the latest GitHub Release
  // (see scripts/release.mjs), so the APK and build-info.json have a permanent
  // URL and an instance that never built the app can still hand out the official
  // one. The admin can point it elsewhere or clear it in Settings → Advanced.
  const DEFAULT_BUILDS_URL = (process.env.MANGAYOMU_BUILDS_URL ||
    "https://github.com/mangayomu/mangayomu-app/releases/latest/download").replace(/\/+$/, "");

  function resolveBuildsUrl() {
    const row = stmts.getSetting.get("android_builds_url");
    return row && typeof row.value === "string" ? row.value.replace(/\/+$/, "") : DEFAULT_BUILDS_URL;
  }

  // Building on demand runs a pipeline on the host, so it can be switched off
  // server-wide (default: on, where the checkout is present).
  function androidBuildEnabled() {
    const row = stmts.getSetting.get("android_build_enabled");
    return !row || row.value !== "0";
  }

  // Both Android flavours are downloadable: the with-server APK is
  // self-contained, the client-only one is the small install for a phone that
  // talks to a server (this one, over the local network).
  const APK_VARIANTS = {
    withServer: "mangayomu-with-server.apk",
    client: "mangayomu-client.apk",
  };

  function apkVariant(value) {
    return value === "client" ? "client" : "withServer";
  }

  // Last answer from the published host, keyed by URL and variant: the panel
  // polls, and the host must not be hit on every poll.
  var remoteBuildInfo = { url: null, at: 0, value: null };

  /** Metadata of one flavour: build-info.json entry, else the APK itself. */
  function localBuildEntry(variant) {
    var apkName = APK_VARIANTS[variant];
    var apkPath = path.join(BUILD_DIR, apkName);
    if (!fs.existsSync(apkPath)) return null;
    var stats = fs.statSync(apkPath);
    var recorded = null;
    try {
      var infoPath = path.join(BUILD_DIR, "build-info.json");
      if (fs.existsSync(infoPath)) {
        var data = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
        recorded = (data.builds && data.builds[variant]) || (data.apkName === apkName ? data : null);
      }
    } catch (err) { /* fall back to the file itself */ }
    return {
      buildDate: (recorded && recorded.buildDate) || stats.mtime.toISOString().replace("T", " ").replace(/\..+/, ""),
      apkSize: stats.size,
      apkName: apkName,
    };
  }

  /** Metadata of the published build of one flavour, if the host answers. */
  async function fetchRemoteBuildInfo(url, variant) {
    if (!url) return null;
    var cacheKey = url + "#" + variant;
    if (remoteBuildInfo.url === cacheKey && Date.now() - remoteBuildInfo.at < 60000) return remoteBuildInfo.value;
    let value = null;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      const response = await fetch(url + "/build-info.json", { signal: controller.signal, cache: "no-store" });
      clearTimeout(timer);
      if (response.ok) {
        const data = await response.json();
        const entry = (data.builds && data.builds[variant]) || null;
        if (entry) {
          value = {
            buildDate: entry.buildDate || null,
            apkSize: Number(entry.apkSize) || 0,
            apkName: entry.apkName || APK_VARIANTS[variant],
          };
        }
      }
    } catch (err) {
      value = null;
    }
    remoteBuildInfo = { url: cacheKey, at: Date.now(), value };
    return value;
  }

  app.get("/api/builds/info", async function (req, res) {
    var flags = {
      canBuild: canBuildAndroid(),
      buildEnabled: androidBuildEnabled(),
      buildsUrl: resolveBuildsUrl(),
    };
    var variant = apkVariant(req.query.variant);
    try {
      // Prefer what this server already has; otherwise ask the published host.
      var entry = localBuildEntry(variant);
      var source = "local";
      if (!entry) {
        entry = await fetchRemoteBuildInfo(flags.buildsUrl, variant);
        source = entry ? "remote" : null;
      }
      // The flat fields describe the with-server flavour, as before.
      var primary = localBuildEntry("withServer") || (variant === "withServer" ? entry : null);
      res.json({
        ...flags,
        buildDate: (entry && entry.buildDate) || null,
        apkSize: (entry && entry.apkSize) || 0,
        apkName: (entry && entry.apkName) || APK_VARIANTS[variant],
        variant,
        source,
        available: { withServer: !!localBuildEntry("withServer"), client: !!localBuildEntry("client") },
        primary: primary || null,
      });
    } catch (err) {
      res.json({
        ...flags,
        buildDate: null, apkSize: 0, apkName: APK_VARIANTS[variant], variant, source: null,
        available: { withServer: !!localBuildEntry("withServer"), client: !!localBuildEntry("client") },
        primary: localBuildEntry("withServer"),
      });
    }
  });

  // The Android APK is produced by the repository pipeline, so a server can
  // only build it where the checkout and the Android SDK are present (a
  // developer machine running the server from the repo). The packaged app has
  // neither, and the UI hides the action there.
  var REPO_ROOT = path.resolve(__dir, "..", "..", "..");
  var ANDROID_BUILD_SCRIPT = path.join(REPO_ROOT, "scripts", "build-android.mjs");
  var androidBuild = { running: false, startedAt: null, finishedAt: null, ok: null, error: "", log: [] };

  function canBuildAndroid() {
    return fs.existsSync(ANDROID_BUILD_SCRIPT) && fs.existsSync(path.join(REPO_ROOT, "android", "gradlew"));
  }

  app.get("/api/builds/info", async function (req, res) {
    // The APK is the thing that matters: metadata written by an older pipeline
    // (or missing entirely) must not hide a build that is already servable.
    var apkPath = path.join(BUILD_DIR, "mangayomu-with-server.apk");
    var flags = {
      canBuild: canBuildAndroid(),
      buildEnabled: androidBuildEnabled(),
      buildsUrl: resolveBuildsUrl(),
    };
    try {
      if (fs.existsSync(apkPath)) {
        var stats = fs.statSync(apkPath);
        var infoPath = path.join(BUILD_DIR, "build-info.json");
        var info = fs.existsSync(infoPath) ? JSON.parse(fs.readFileSync(infoPath, "utf-8")) : {};
        return res.json({
          ...flags,
          buildDate: info.buildDate || stats.mtime.toISOString().replace("T", " ").replace(/\..+/, ""),
          apkSize: stats.size,
          apkName: "mangayomu-with-server.apk",
          source: "local",
        });
      }
      var remote = await fetchRemoteBuildInfo(flags.buildsUrl);
      if (remote) return res.json({ ...flags, ...remote, source: "remote" });
      return res.json({ ...flags, buildDate: null, apkSize: 0, apkName: "mangayomu-with-server.apk", source: null });
    } catch (err) {
      res.json({ ...flags, buildDate: null, apkSize: 0, apkName: "mangayomu-with-server.apk", source: null });
    }
  });

  // Read-only state of the on-demand build, polled by the Sync panel.
  app.get("/api/builds/status", function (_req, res) {
    res.setHeader("Cache-Control", "no-store");
    res.json({
      canBuild: canBuildAndroid(),
      building: androidBuild.running,
      startedAt: androidBuild.startedAt,
      finishedAt: androidBuild.finishedAt,
      ok: androidBuild.ok,
      error: androidBuild.error,
      log: androidBuild.log.slice(-20),
    });
  });

  // Build the Android APK on demand (admin only, one at a time).
  app.post("/api/builds/android", auth, requireAdmin, function (req, res) {
    if (!androidBuildEnabled()) {
      return res.status(409).json({ error: "On-demand Android builds are disabled on this server." });
    }
    if (!canBuildAndroid()) {
      return res.status(409).json({
        error: "This server cannot build the Android app: it needs the repository checkout and the Android SDK.",
      });
    }
    if (androidBuild.running) {
      return res.status(409).json({ error: "An Android build is already running." });
    }

    androidBuild = {
      running: true,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      ok: null,
      error: "",
      log: [],
    };

    var child = spawn(process.execPath, [ANDROID_BUILD_SCRIPT, "withServer"], { cwd: REPO_ROOT });
    var pushOutput = function (chunk) {
      // The build pipeline prints colored output; the panel shows plain text.
      var text = String(chunk).replace(/\u001b\[[0-9;]*m/g, "");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        androidBuild.log.push(line.slice(0, 400));
      }
      if (androidBuild.log.length > 400) androidBuild.log.splice(0, androidBuild.log.length - 400);
    };
    child.stdout.on("data", pushOutput);
    child.stderr.on("data", pushOutput);
    child.on("error", function (err) {
      androidBuild.running = false;
      androidBuild.ok = false;
      androidBuild.error = err.message;
      androidBuild.finishedAt = new Date().toISOString();
    });
    child.on("close", function (code) {
      androidBuild.running = false;
      androidBuild.ok = code === 0;
      androidBuild.error = code === 0 ? "" : "Build failed with exit code " + code;
      androidBuild.finishedAt = new Date().toISOString();
    });

    res.json({ ok: true, startedAt: androidBuild.startedAt });
  });

  app.get("/api/builds/apk", async function (req, res) {
    var variant = apkVariant(req.query.variant);
    var apkName = APK_VARIANTS[variant];
    var apkPath = path.join(BUILD_DIR, apkName);
    if (!fs.existsSync(apkPath)) {
      // No local build: hand out the published one instead of proxying it.
      var buildsUrl = resolveBuildsUrl();
      if (!buildsUrl) return res.status(404).json({ error: "No Android build available yet" });
      return res.redirect(302, buildsUrl + "/" + apkName);
    }
    res.download(apkPath, apkName);
  });

  // When bundled for Android, expose the same compiled client to LAN browsers.
  // API routes remain above this fallback and continue to win.
  if (options.staticDir) {
    var staticDir = path.resolve(options.staticDir);
    app.use(express.static(staticDir));
    app.get(/^(?!\/api\/).*/, function (_req, res) {
      res.sendFile(path.join(staticDir, "index.html"));
    });
  }

  // =====================================================================
  //  Image proxy helper
  // =====================================================================
  async function fetchImage(url, sourceId) {
    let origin;
    try {
      origin = new URL(url).origin;
    } catch {
      throw new Error("Invalid image URL");
    }
    const headers = {
      "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36",
      Referer: origin,
    };
    // A loaded source may provide image request headers (for example a site
    // Referer expected by its own CDN) through an optional capability. The
    // core never hardcodes upstream header policies.
    if (sourceId) {
      const entry = registry.entry(sourceId);
      if (entry && entry.source && typeof entry.source.getImageHeaders === "function") {
        const extra = entry.source.getImageHeaders(url);
        if (extra && typeof extra === "object") Object.assign(headers, extra);
      }
    }
    var res = await fetch(url, { headers });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      return fetchImage(res.headers.get("location"), sourceId);
    }
    if (!res.ok) {
      throw new Error("HTTP " + res.status);
    }
    return {
      body: Buffer.from(await res.arrayBuffer()),
      type: res.headers.get("content-type") || "image/jpeg",
    };
  }

  return { app, db };
}

function upstreamErrorStatus(error) {
  const status = Number(error?.status);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

/**
 * Extension client hub (host side).
 *
 * The host app never bundles extension source code. Installed packages that
 * declare an `entrypoints.client` module are imported here asynchronously and
 * mounted into host-owned slots (a Settings tab, a Browse source cog).
 *
 * Client module contract (used by the official Local Source package):
 *   - default export is either
 *       a) a TinyBubble component definition object, or
 *       b) a function `(hostRuntime) => { settingsPanel?, browsePanel? }`.
 *   - `hostRuntime` exposes `request(extensionId, method, path, body)` for the
 *     per-user extension config API plus `createComponent`, `importComponent`,
 *     and `getConnection`.
 *
 * A module can also be a plain object with `settingsPanel`/`browsePanel`
 * properties holding component definitions.
 */

import { createComponent, importComponent } from "tinybubble";
import { getConnection, hasActiveServerSession } from "../connection";
import { extensions } from "../api.ts";

/** Shared host runtime handed to extension modules. */
export const hostRuntime = {
  createComponent,
  importComponent,
  getConnection,
  request: (extensionId, method, path, body) =>
    extensions.extensionRequest(extensionId, method, path, body),
  token: () => {
    const connection = getConnection();
    return hasActiveServerSession(connection) ? connection.serverSession.token : "";
  },
  apiBase: () => {
    const connection = getConnection();
    return connection.serverUrl ? connection.serverUrl + "/api" : "";
  },
  /** Parse a request init and call the per-user extension API; returns JSON. */
  requestJson: (extensionId, path, init) => {
    const method = (init && init.method) || "GET";
    let body;
    if (init && init.body !== undefined && init.body !== null) {
      body = typeof init.body === "string" ? JSON.parse(init.body) : init.body;
    }
    return extensions.extensionRequest(extensionId, method, path, body);
  },
};

if (typeof window !== "undefined") {
  window.MangaYomuExtensionRuntime = hostRuntime;
}

const _moduleCache = new Map(); // packageId + version -> module

let _installed = []; // InstalledClientExtension[]
let _contributions = null; // { settings: [], browse: [] }

async function importClientModule(info) {
  const cacheKey = info.packageId + "@" + info.version;
  if (_moduleCache.has(cacheKey)) return _moduleCache.get(cacheKey);
  const url = extensions.clientModuleUrl(info);
  // @vite-ignore: the URL is a runtime cross-origin module served by the
  // connected server; Vite must not try to resolve or bundle it.
  const mod = await import(/* @vite-ignore */ url);
  _moduleCache.set(cacheKey, mod);
  return mod;
}

/**
 * Resolve a panel descriptor from a client module result.
 * Supports the Local Source contract (default function returning
 * { settingsPanel?, browsePanel? }) plus plain module exports.
 */
function pickPanel(resolved, kind) {
  if (!resolved || typeof resolved !== "object") return null;
  if (kind === "settings" && resolved.settingsPanel) return resolved.settingsPanel;
  if (kind === "browse" && resolved.browsePanel) return resolved.browsePanel;
  // A bare component definition object (name/template/data) is a settings
  // panel by default.
  if (kind === "settings" && resolved.name && resolved.template) return resolved;
  return null;
}

async function resolvePanel(info, kind) {
  const mod = await importClientModule(info);
  const def = mod.default;
  let resolved = null;
  if (typeof def === "function") {
    try {
      resolved = await def(hostRuntime);
    } catch (err) {
      console.error("[extensions] client init failed", info.packageId, err);
      return null;
    }
    return pickPanel(resolved, kind);
  }
  if (def && typeof def === "object") return pickPanel(def, kind);
  return pickPanel(mod, kind);
}

/**
 * Fetch installed client extensions for the current user and import their
 * modules once. Only metadata needed to list panels is resolved eagerly; the
 * heavy component definitions are created lazily on mount.
 */
export async function loadExtensionContributions() {
  try {
    _installed = (await extensions.listClientExtensions()).extensions || [];
  } catch (err) {
    _installed = [];
  }
  _contributions = { settings: [], browse: [] };
  for (const info of _installed) {
    const record = {
      packageId: info.packageId,
      name: info.name,
      version: info.version,
      info,
    };
    if (info.settingsPanels.length) _contributions.settings.push(record);
    if (info.browseSources.length) _contributions.browse.push(record);
  }
  return _contributions;
}

export function getExtensionContributions() {
  return _contributions || { settings: [], browse: [] };
}

export function browseContributionsForSource(sourceId) {
  const all = getExtensionContributions().browse || [];
  return all.filter((record) => record.info.browseSources.includes(sourceId));
}

/** Create a mounted component for one contribution kind (settings | browse). */
export async function createExtensionComponent(info, kind, parent) {
  const def = await resolvePanel(info, kind);
  if (!def || typeof def !== "object") return null;
  try {
    return createComponent(def, {}, {}, parent);
  } catch (err) {
    console.error("[extensions] mount failed", info.packageId, kind, err);
    return null;
  }
}
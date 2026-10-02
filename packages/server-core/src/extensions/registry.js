/**
 * Runtime registry of installed extension contributions.
 *
 * The registry owns the loaded source objects and their package metadata. It
 * loads a package directory by importing its server entry point with the
 * injected runtime capabilities (Node fetch + HTML parsing), registering every
 * server-side source contribution it declares.
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { parseManifest, hasServerSources } from "./manifest.js";

export class ExtensionRegistry {
  constructor(runtime) {
    this.runtime = runtime;
    this.entries = new Map(); // sourceId -> { source, packageId, version, manifest }
  }

  /**
   * Load a package from its install directory and register its sources.
   * @param {string} installDir absolute path to <home>/extensions/<id>
   * @returns {Promise<object|null>} the parsed manifest, or null when the
   *   package has no executable server content (client-only, metadata-only,
   *   theme, or utility package).
   */
  async load(installDir) {
    const manifestText = await readFile(path.join(installDir, "extension.json"), "utf-8");
    const manifest = parseManifest(manifestText);
    // Execute a server entry only for packages that declare one or more
    // source contributions AND a server entry point. Everything else loads
    // structurally without running any of its modules in v1.
    if (!hasServerSources(manifest)) return manifest;
    const entry = manifest.entrypoints.server;

    const entryPath = path.join(installDir, entry);
    // A stable install dir keeps a stable module URL, so cache-bust by version
    // to force a fresh evaluation when the package is updated in place.
    const moduleUrl = pathToFileURL(entryPath).href + "?v=" + encodeURIComponent(manifest.version);
    const mod = await import(moduleUrl);
    const factory = typeof mod.default === "function" ? mod.default : null;
    if (!factory) throw new Error("Server entry must export a createExtension function");

    const sources = manifest.contributes.sources || [];
    const sourceObj = factory(this.runtime);
    if (!sourceObj || typeof sourceObj !== "object") throw new Error("createExtension did not return a source");
    if (sources.length !== 1 || sources[0].id !== sourceObj.id) {
      throw new Error("Package must expose exactly one source matching the manifest id");
    }
    this.register(sourceObj, { id: manifest.id, version: manifest.version, manifest });
    return manifest;
  }

  register(source, packageRecord) {
    this.entries.set(source.id, {
      source: source,
      packageId: packageRecord.id,
      version: packageRecord.version,
      manifest: packageRecord.manifest,
    });
  }

  get(sourceId) {
    const entry = this.entries.get(sourceId);
    return entry ? entry.source : null;
  }

  entry(sourceId) {
    return this.entries.get(sourceId) || null;
  }

  /** Basic source metadata for catalog and activation contexts. */
  metadata(sourceId) {
    const entry = this.entries.get(sourceId);
    if (!entry) return null;
    const manifest = entry.manifest;
    const source = manifest.contributes.sources[0];
    const firstLang = source.languages && source.languages.length > 0 ? source.languages[0].code : "en";
    return {
      id: source.id,
      packageId: entry.packageId,
      name: source.name,
      lang: source.lang || "en",
      defaultLanguage: source.defaultLanguage || firstLang,
      languages: source.languages || [],
      baseUrl: source.baseUrl || "",
      version: entry.version,
    };
  }

  list() {
    return Array.from(this.entries.keys()).map((id) => this.metadata(id));
  }

  listDetailed() {
    return Array.from(this.entries.values()).map((entry) => this.metadata(entry.source.id));
  }

  /** Remove every runtime source contributed by one installed package. */
  removePackage(packageId) {
    const removed = [];
    for (const [sourceId, entry] of this.entries) {
      if (entry.packageId === packageId) {
        this.entries.delete(sourceId);
        removed.push(sourceId);
      }
    }
    return removed;
  }
}

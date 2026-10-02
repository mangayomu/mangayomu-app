/**
 * Trusted extension catalog resolution.
 *
 * A trusted registry is a JSON document configured by an admin. It lists
 * trusted repositories and direct packages. Each repository is another JSON
 * document listing one or more package ZIP releases. This module resolves the
 * full trusted catalog into a map of package URL -> {id, version, name,
 * sha256}. Non-admin installs are only allowed to use package entries resolved
 * from this trusted chain, never an arbitrary URL supplied by the client.
 */

import { downloadUrl } from "./installer.js";

const MAX_JSON_BYTES = 2 * 1024 * 1024;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;

function requireSha256(id, sha256) {
  if (typeof sha256 !== "string" || !SHA256_PATTERN.test(sha256)) {
    throw new Error("Package entry must declare a valid sha256: " + id);
  }
}

export { requireSha256 };

async function fetchJson(url) {
  const data = await downloadUrl(url, { limit: MAX_JSON_BYTES });
  let json;
  try {
    json = JSON.parse(data.toString("utf-8"));
  } catch (err) {
    throw new Error("Invalid JSON catalog at " + url);
  }
  return json;
}

/**
 * Resolve a package entry URL against its catalog URL. Relative paths (for
 * example `dist/<id>-<version>.zip`) are resolved against the HTTPS catalog
 * so a hosted repository/registry needs no absolute release URLs.
 */
export function resolveCatalogUrl(catalogUrl, entryUrl) {
  try {
    return new URL(entryUrl, catalogUrl).toString();
  } catch (err) {
    throw new Error("Invalid package URL in catalog: " + entryUrl);
  }
}

/**
 * Merge already-resolved catalogs into one trusted view.
 *
 * Packages are keyed by package URL (the value the client sends back when
 * installing) and deduplicated by package id: the first catalog wins, so the
 * admin's ordering decides precedence. Repository URLs keep the same order and
 * are what the "add repository" gate checks against. Keeping this pure
 * separates the merge rules from the network fetch.
 *
 * @param {Array<{url: string, catalog?: {packages: Map<string, object>, repositories: string[]}, error?: string}>} results
 * @returns {{ packages: Map<string, object>, repositories: string[], errors: Array<{url: string, error: string}> }}
 */
export function mergeTrustedCatalogs(results) {
  const packages = new Map();
  const seenIds = new Set();
  const repositories = [];
  const seenRepositories = new Set();
  const errors = [];

  for (const result of results) {
    if (result.error) {
      errors.push({ url: result.url, error: result.error });
      continue;
    }
    for (const repositoryUrl of result.catalog.repositories || []) {
      if (seenRepositories.has(repositoryUrl)) continue;
      seenRepositories.add(repositoryUrl);
      repositories.push(repositoryUrl);
    }
    for (const entry of result.catalog.packages.values()) {
      if (seenIds.has(entry.id)) continue;
      seenIds.add(entry.id);
      packages.set(entry.url, { ...entry, registry: result.url });
    }
  }

  return { packages, repositories, errors };
}

/**
 * Resolve several trusted catalogs into one view.
 *
 * A broken catalog must not hide the others, so failures are collected per
 * URL instead of aborting the whole resolution.
 *
 * @param {string[]} registryUrls
 * @returns {Promise<{ packages: Map<string, object>, repositories: string[], errors: Array<{url: string, error: string}> }>}
 */
export async function resolveTrustedCatalogs(registryUrls) {
  const results = [];

  for (const registryUrl of registryUrls) {
    try {
      results.push({ url: registryUrl, catalog: await resolveTrustedCatalog(registryUrl) });
    } catch (err) {
      results.push({ url: registryUrl, error: err.message || String(err) });
    }
  }

  return mergeTrustedCatalogs(results);
}

/**
 * Resolve a trusted catalog URL.
 *
 * Two document kinds are accepted, so an admin can either curate a registry
 * that points at repositories or trust a single repository by pasting its
 * catalog URL:
 *   - registry (`registryVersion: 1`)   → its `repository` items are trusted
 *     repositories, and their packages become installable;
 *   - repository (`repositoryVersion: 1`) → itself is the trusted repository.
 *
 * @param {string} registryUrl
 * @returns {Promise<{ packages: Map<string, object>, repositories: string[] }>}
 */
export async function resolveTrustedCatalog(registryUrl) {
  const document = await fetchJson(registryUrl);

  if (document.repositoryVersion === 1) {
    return {
      packages: packagesFromRepository(document, registryUrl, document.id || null),
      repositories: [registryUrl],
    };
  }

  if (document.registryVersion !== 1 || !Array.isArray(document.items)) {
    throw new Error("Invalid trusted catalog: expected a registryVersion 1 registry or a repositoryVersion 1 repository");
  }

  const packages = new Map();
  const repositories = [];
  const pending = [];

  for (const item of document.items) {
    if (!item || item.type === "package") {
      if (!item || !item.url || !item.id || !item.version) throw new Error("Invalid trusted package entry");
      requireSha256(item.id, item.sha256);
      const url = resolveCatalogUrl(registryUrl, item.url);
      packages.set(url, {
        url, id: item.id, version: item.version, name: item.name || item.id, sha256: item.sha256,
      });
    } else if (item.type === "repository") {
      if (!item.url) throw new Error("Invalid trusted repository entry");
      const url = resolveCatalogUrl(registryUrl, item.url);
      repositories.push(url);
      pending.push({ url, label: item.id || url });
    }
  }

  for (const repository of pending) {
    const document = await fetchJson(repository.url);
    for (const [url, entry] of packagesFromRepository(document, repository.url, repository.label)) {
      packages.set(url, entry);
    }
  }

  return { packages, repositories };
}

/** Packages of a repository catalog, with URLs resolved against its own URL. */
function packagesFromRepository(repository, repositoryUrl, label) {
  if (repository.repositoryVersion !== 1 || !Array.isArray(repository.packages)) {
    throw new Error("Invalid repository catalog: " + (label || repositoryUrl));
  }
  const packages = new Map();
  for (const pkg of repository.packages) {
    if (!pkg.url || !pkg.id || !pkg.version) {
      throw new Error("Invalid package entry in repository " + (label || repositoryUrl));
    }
    requireSha256(pkg.id, pkg.sha256);
    const url = resolveCatalogUrl(repositoryUrl, pkg.url);
    packages.set(url, {
      url, id: pkg.id, version: pkg.version, name: pkg.name || pkg.id,
      sha256: pkg.sha256, repository: label || null,
    });
  }
  return packages;
}

/**
 * Fetch and validate an extension repository catalog (repositoryVersion 1).
 * Package URLs are resolved against the repository URL so they may be
 * relative `dist/` release paths.
 */
export async function resolveRepository(url) {
  const json = await fetchJson(url);
  if (json.repositoryVersion !== 1 || !Array.isArray(json.packages)) {
    throw new Error("Invalid repository catalog");
  }
  return {
    ...json,
    packages: json.packages.map((pkg) => {
      if (!pkg.url || !pkg.id || !pkg.version) throw new Error("Invalid package entry in repository");
      requireSha256(pkg.id, pkg.sha256);
      return { ...pkg, url: resolveCatalogUrl(url, pkg.url) };
    }),
  };
}

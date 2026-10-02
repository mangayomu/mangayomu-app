/**
 * Manifest parsing and validation for extension packages.
 * A package manifest declares a unique id, a version, optional runtime entry
 * points, and the contributions (sources, themes, utilities, ...) it provides.
 */

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

function hasSources(manifest) {
  return manifest && manifest.contributes && Array.isArray(manifest.contributes.sources);
}

export function parseManifest(text) {
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (err) {
    throw new Error("Invalid extension.json: " + err.message);
  }
  validateManifest(manifest);
  return manifest;
}

function validateEntryTarget(entry, dir) {
  if (entry == null) return true;
  if (typeof entry !== "string" || !entry) return false;
  // Entry points must be relative paths inside their declared target
  // directory: no absolute paths, no traversal, no backslashes or NUL bytes.
  if (entry.startsWith("/") || entry.includes("\\") || entry.includes("\0")) return false;
  const parts = entry.split("/");
  if (parts[0] !== dir || parts.includes("..") || parts.includes("")) return false;
  return true;
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== "object") throw new Error("Manifest must be an object");
  if (manifest.manifestVersion !== 1) throw new Error("Unsupported manifestVersion");
  if (typeof manifest.id !== "string" || !ID_PATTERN.test(manifest.id)) throw new Error("Invalid extension id");
  if (typeof manifest.name !== "string" || !manifest.name) throw new Error("Extension name is required");
  if (typeof manifest.version !== "string" || !VERSION_PATTERN.test(manifest.version)) throw new Error("Invalid version (expected x.y.z)");

  const entrypoints = manifest.entrypoints || {};
  if (!validateEntryTarget(entrypoints.server, "server")) throw new Error("Invalid server entrypoint");
  if (!validateEntryTarget(entrypoints.client, "client")) throw new Error("Invalid client entrypoint");

  if (hasSources(manifest)) {
    for (const source of manifest.contributes.sources) {
      if (!source || typeof source.id !== "string" || !ID_PATTERN.test(source.id)) {
        throw new Error("Invalid source contribution id");
      }
      if (typeof source.name !== "string" || !source.name) {
        throw new Error("Source name is required");
      }
    }
  }

  // Client contributions are UI metadata consumed by the host app: optional
  // Settings panels and Browse source actions. They are never executed on the
  // server; the browser loads the declared client module asynchronously.
  if (manifest.contributes && manifest.contributes.client != null) {
    const client = manifest.contributes.client;
    if (typeof client !== "object" || Array.isArray(client)) {
      throw new Error("Invalid client contribution");
    }
    if (client.settingsPanels != null &&
        (!Array.isArray(client.settingsPanels) || client.settingsPanels.some((p) => typeof p !== "string" || !p))) {
      throw new Error("Invalid client settings panels");
    }
    if (client.browseSources != null &&
        (!Array.isArray(client.browseSources) || client.browseSources.some((s) => typeof s !== "string" || !s))) {
      throw new Error("Invalid client browse sources");
    }
  }

  return manifest;
}

/** True when a package declares server-side source contributions to execute. */
export function hasServerSources(manifest) {
  return (
    hasSources(manifest) &&
    !!manifest.entrypoints &&
    typeof manifest.entrypoints.server === "string"
  );
}

/** True when a package declares a browser-side client module. */
export function hasClientModule(manifest) {
  return !!manifest && !!manifest.entrypoints && typeof manifest.entrypoints.client === "string";
}

/**
 * Shared staging helpers for bundled MangaYomu servers.
 *
 * Two builders ship a Node server next to a client bundle:
 *   - Android (`bundle-android-server.mjs`) → nodejs-mobile runtime + assets
 *   - Desktop (`bundle-tauri-server.mjs`)   → Node runtime sidecar + resources
 *
 * Both need the same runtime dependency tree and the same package layout, so
 * the copying rules live here instead of being duplicated per platform.
 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/** Native modules that cannot travel to the target platform. */
export const NATIVE_MODULES = ["better-sqlite3"];

export function rm(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

export function sha256(file) {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

export function directoryHash(dir) {
  const hash = createHash("sha256");
  function visit(current) {
    const entries = fs.readdirSync(current, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relativePath = path.relative(dir, fullPath);
      hash.update(relativePath + "\0");
      if (entry.isDirectory()) {
        visit(fullPath);
      } else if (entry.isSymbolicLink()) {
        hash.update(fs.readlinkSync(fullPath));
      } else {
        hash.update(fs.readFileSync(fullPath));
      }
    }
  }
  visit(dir);
  return hash.digest("hex");
}

export function packageSource(nodeModulesDir, name) {
  const source = path.join(nodeModulesDir, name);
  return fs.existsSync(source) ? fs.realpathSync(source) : null;
}

// Resolve exactly as Node would from a package directory. npm may hoist one
// version while a dependency needs another nested version; using only the
// root node_modules silently combines incompatible dependency trees.
export function resolvedPackageSource(fromPackage, name) {
  let current = fromPackage;
  while (true) {
    const source = packageSource(path.join(current, "node_modules"), name);
    if (source) return source;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

/**
 * Copy one runtime package (and, recursively, its own dependencies) into a
 * destination node_modules.
 *
 * @param {string} name
 * @param {string} source       – resolved package directory
 * @param {string} destinationNodeModules
 * @param {object} [options]
 * @param {Set<string>} [options.skipPackages] – native modules to leave out
 * @param {string[]} [options.forceRootPackages] – packages to always take from
 *        the workspace root instead of the requiring package's tree
 * @param {string} [options.rootNodeModules]
 * @returns {number} number of packages copied
 */
export function copyRuntimePackage(name, source, destinationNodeModules, options = {}) {
  const skipPackages = options.skipPackages || new Set();
  const forceRootPackages = options.forceRootPackages || [];
  const rootNodeModules = options.rootNodeModules;

  if (skipPackages.has(name)) {
    console.log("  [skip] " + name + " (native module)");
    return 0;
  }

  const destination = path.join(destinationNodeModules, name);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, { recursive: true, force: true });

  const pkg = JSON.parse(fs.readFileSync(path.join(source, "package.json"), "utf-8"));
  let copied = 1;
  for (const dependency of Object.keys(pkg.dependencies || {})) {
    const dependencySource = forceRootPackages.includes(dependency) && rootNodeModules
      ? packageSource(rootNodeModules, dependency)
      : resolvedPackageSource(source, dependency);
    if (!dependencySource) {
      throw new Error("Missing runtime dependency " + dependency + " for " + name);
    }
    copied += copyRuntimePackage(dependency, dependencySource, path.join(destination, "node_modules"), options);
  }
  return copied;
}

/**
 * Copy a package's declared dependencies into the destination node_modules.
 *
 * @returns {number} number of packages copied
 */
export function copyRuntimeDependencies(dependencies, options) {
  const { rootNodeModules, destNodeModules, skipPackages, forceRootPackages } = options;
  let copied = 0;
  for (const dependency of dependencies) {
    const source = packageSource(rootNodeModules, dependency);
    if (!source) {
      throw new Error("Missing runtime dependency " + dependency);
    }
    copied += copyRuntimePackage(dependency, source, destNodeModules, {
      skipPackages, forceRootPackages, rootNodeModules,
    });
  }
  return copied;
}

/**
 * Stage a runnable server payload:
 *
 *   <destDir>/src/index.js                 ← platform server entry
 *   <destDir>/node_modules/**              ← runtime deps (native modules skipped)
 *   <destDir>/node_modules/@mangayomu/server-core
 *   <destDir>/package.json                 ← ESM marker + main entry
 *   <destDir>/bundle-version.txt           ← content hash of the staged tree
 *
 * The server entry resolves its project root two levels up from `src`, so the
 * caller must place the client bundle where that entry expects it.
 *
 * @param {object} options
 * @param {string} options.destDir
 * @param {string} options.serverSrcDir    – directory copied to `src`
 * @param {string} options.corePackageDir  – `@mangayomu/server-core` package
 * @param {string} options.rootNodeModules – workspace root node_modules
 * @param {string} options.packageName     – name for the generated package.json
 * @param {string[]} [options.forceRootPackages]
 * @param {(destDir: string) => void} [options.afterDependencies] – hook run
 *        after dependencies are copied, before the hash is taken
 * @returns {string} the staged content hash
 */
export function stageServerPayload(options) {
  const {
    destDir, serverSrcDir, corePackageDir, rootNodeModules,
    packageName, forceRootPackages = [], skipPackages = new Set(NATIVE_MODULES),
    afterDependencies,
  } = options;

  rm(destDir);
  fs.mkdirSync(destDir, { recursive: true });

  // 1. Platform server entry.
  fs.cpSync(serverSrcDir, path.join(destDir, "src"), { recursive: true, force: true });

  // 2. Core source (without node_modules) where the entry resolves it. Its
  //    runtime dependencies live at node_modules/* from step 3.
  const nmScopedDir = path.join(destDir, "node_modules", "@mangayomu");
  fs.mkdirSync(nmScopedDir, { recursive: true });
  const coreDest = path.join(nmScopedDir, "server-core");
  rm(coreDest);
  fs.cpSync(corePackageDir, coreDest, { recursive: true, force: true });
  rm(path.join(coreDest, "node_modules"));

  // 3. Runtime dependencies with their resolved nested versions. npm can
  //    install several versions of one package, which a flat copy loses.
  const corePkg = JSON.parse(fs.readFileSync(path.join(corePackageDir, "package.json"), "utf-8"));
  const nmDir = path.join(destDir, "node_modules");
  fs.mkdirSync(nmDir, { recursive: true });

  const copied = copyRuntimeDependencies(Object.keys(corePkg.dependencies || {}), {
    rootNodeModules, destNodeModules: nmDir, skipPackages, forceRootPackages,
  });
  console.log(`[bundle] copied ${copied} runtime packages`);

  // 4. Platform-specific extras (client bundle, asset cleanup).
  if (afterDependencies) afterDependencies(destDir);

  // 5. Root package.json (ESM entry point) + content hash.
  fs.writeFileSync(path.join(destDir, "package.json"), JSON.stringify({
    name: packageName,
    private: true,
    type: "module",
    main: "src/index.js",
  }, null, 2));

  const hash = directoryHash(destDir);
  fs.writeFileSync(path.join(destDir, "bundle-version.txt"), hash + "\n");
  return hash;
}

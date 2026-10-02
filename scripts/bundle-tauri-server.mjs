#!/usr/bin/env node
/**
 * Prepare the Tauri desktop bundle.
 *
 * Layout produced under `src-tauri/`:
 *
 *   binaries/mangayomu-server-<target-triple>[.exe]   ← Node runtime (sidecar)
 *   resources/server/{src,node_modules,package.json}  ← bundled MangaYomu server
 *   resources/client/dist/**                          ← compiled client
 *
 * The server entry (`resources/server/src/index.js`) resolves its project root
 * two levels up, so it serves `resources/client/dist` and finds its own
 * node_modules without any path patching.
 *
 * The payload is pure JavaScript plus the sql.js WASM build, so the same files
 * are valid on every desktop target; only the Node runtime is per-platform.
 *
 * Usage:
 *   node scripts/bundle-tauri-server.mjs                      # host target
 *   node scripts/bundle-tauri-server.mjs --target mac-x64
 *   node scripts/bundle-tauri-server.mjs --target all
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { rm, sha256, stageServerPayload } from "./lib/server-payload.mjs";
import { TARGETS, parseTargets } from "./lib/tauri-targets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const TAURI_DIR = path.join(ROOT, "src-tauri");
const BINARIES_DIR = path.join(TAURI_DIR, "binaries");
const RESOURCES_DIR = path.join(TAURI_DIR, "resources");
const SERVER_DIR = path.join(RESOURCES_DIR, "server");
const CLIENT_DIST = path.join(ROOT, "client", "dist");
const ROOT_NODE_MODULES = path.join(ROOT, "node_modules");
const CACHE_DIR = path.join(TAURI_DIR, ".cache");

// Pinned Node.js runtime: the desktop server runs on the official Node build.
// Hashes come from https://nodejs.org/dist/<version>/SHASUMS256.txt
const NODE_VERSION = "v22.23.2";
const NODE_SHA256 = {
  "darwin-arm64": "61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6",
  "darwin-x64": "58e99022c2ff89395576cc7fd4d98cea24bb68081475d5f88b801ee8729fb026",
  "win-x64": "0d0f5e39f9f3d9587bc19f73eab3c2c9c4903fd02d6dbf9c853dd81b3d95fad4",
};

/** Shorthand → Rust target triple (and the Node.js build that feeds it). */

async function download(url, file, expectedSha256) {
  if (fs.existsSync(file) && sha256(file) === expectedSha256) return;
  console.log("[node-runtime] downloading " + url);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Could not download " + url + ": HTTP " + response.status);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(file, data);
  if (sha256(file) !== expectedSha256) {
    rm(file);
    throw new Error("Checksum mismatch for " + url);
  }
}

/** Fetch the Node runtime for one platform and place it as a Tauri sidecar. */
async function provisionNodeRuntime(nodePlatform, triple) {
  const isWindows = nodePlatform === "win-x64";
  const extension = isWindows ? ".exe" : "";
  const destination = path.join(BINARIES_DIR, "mangayomu-server-" + triple + extension);

  if (fs.existsSync(destination) && fs.statSync(destination).size > 10 * 1024 * 1024) {
    console.log("[node-runtime] " + triple + " already staged");
    return destination;
  }

  const expected = NODE_SHA256[nodePlatform];
  fs.mkdirSync(BINARIES_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  if (isWindows) {
    // Node publishes the standalone Windows executable, so no extraction.
    const archive = path.join(CACHE_DIR, "node-" + NODE_VERSION + "-win-x64.exe");
    await download("https://nodejs.org/dist/" + NODE_VERSION + "/win-x64/node.exe", archive, expected);
    fs.copyFileSync(archive, destination);
    return destination;
  }

  const archiveName = "node-" + NODE_VERSION + "-" + nodePlatform + ".tar.gz";
  const archive = path.join(CACHE_DIR, archiveName);
  await download("https://nodejs.org/dist/" + NODE_VERSION + "/" + archiveName, archive, expected);

  const extractDir = path.join(CACHE_DIR, "node-" + NODE_VERSION + "-" + nodePlatform);
  rm(extractDir);
  fs.mkdirSync(extractDir, { recursive: true });
  execFileSync("tar", ["-xzf", archive, "-C", extractDir]);
  const binary = path.join(extractDir, "node-" + NODE_VERSION + "-" + nodePlatform, "bin", "node");
  if (!fs.existsSync(binary)) {
    throw new Error("Extracted Node runtime is missing bin/node");
  }
  fs.copyFileSync(binary, destination);
  fs.chmodSync(destination, 0o755);
  return destination;
}

function assertClientBuilt() {
  if (!fs.existsSync(path.join(CLIENT_DIST, "index.html"))) {
    throw new Error("Missing client/dist. Run npm run build:client before staging the Tauri bundle.");
  }
}

function dirSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    size += entry.isDirectory() ? dirSize(full) : fs.statSync(full).size;
  }
  return size;
}

async function main() {
  console.time("[tauri-bundle]");
  const targets = parseTargets(process.argv.slice(2));
  assertClientBuilt();

  // The server payload is platform independent: stage it once.
  const version = stageServerPayload({
    destDir: SERVER_DIR,
    serverSrcDir: path.resolve(ROOT, "server", "src"),
    corePackageDir: path.resolve(ROOT, "packages", "server-core"),
    rootNodeModules: ROOT_NODE_MODULES,
    packageName: "mangayomu-desktop-server",
    forceRootPackages: ["undici"],
    afterDependencies: (destDir) => {
      // Serve the client from the same origin as the API so the app runs in
      // "hosted" mode exactly like the Android with-server flavour.
      const stagedClient = path.join(RESOURCES_DIR, "client", "dist");
      fs.cpSync(CLIENT_DIST, stagedClient, { recursive: true, force: true });
      // The dev server writes this file into client/public; a packaged app
      // must not ship a stale pointer to a dev port.
      rm(path.join(stagedClient, "mangayomu-runtime.json"));
      void destDir;
    },
  });

  for (const shorthand of targets) {
    const { triple, node } = TARGETS[shorthand];
    const binary = await provisionNodeRuntime(node, triple);
    console.log(
      "[node-runtime] " + shorthand + " → " + path.relative(ROOT, binary) +
      " (" + (fs.statSync(binary).size / 1024 / 1024).toFixed(1) + " MB, " + NODE_VERSION + ")"
    );
  }

  const size = dirSize(RESOURCES_DIR) + dirSize(BINARIES_DIR);
  console.log(`[tauri-bundle] server payload ${version.slice(0, 12)} · ${(size / 1024 / 1024).toFixed(1)} MB total`);
  console.timeEnd("[tauri-bundle]");
}

main().catch((error) => {
  console.error("[tauri-bundle] failed:", error.message);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Publish the installable MangaYomu builds as assets of a GitHub Release.
 *
 * Installers never enter the repository: they are built here and uploaded to a
 * release, whose asset names stay stable across versions. That gives every
 * download one permanent URL, which is also what the server hands out
 * (`/api/builds/info`, `/api/builds/apk`):
 *
 *   https://github.com/<owner>/<repo>/releases/latest/download/<asset>
 *
 * Steps: build the client → build both Android flavours and the macOS disk
 * image → create (or top up) the release with those files plus `build-info.json`
 * and `SHA256SUMS`.
 *
 * Usage:
 *   node scripts/release.mjs --tag v0.1.0
 *   node scripts/release.mjs --tag v0.1.0 --only=android
 *   node scripts/release.mjs --tag v0.1.0 --skip-build --dry-run
 *   node scripts/release.mjs --tag v0.2.0 --notes-file notes.md --prerelease
 */

import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BUILD_DIR = path.join(ROOT, "builds");
const args = process.argv.slice(2);

const FLAGS = ["--tag", "--only", "--notes", "--notes-file"];
const KNOWN_SWITCHES = [
  "--dry-run", "--skip-build", "--skip-client", "--allow-dirty", "--prerelease", "--help",
];

/** Assets of a release, in the order they are listed to the user. */
const ASSETS = {
  android: [
    { file: "mangayomu-with-server.apk", label: "Android, with embedded server" },
    { file: "mangayomu-client.apk", label: "Android, client only (needs a server)" },
    { file: "build-info.json", label: "APK dates and sizes read by the server" },
  ],
  macos: [
    { file: "mangayomu-macos-arm64.dmg", label: "macOS, Apple silicon" },
  ],
};

function run(command, commandArgs, options = {}) {
  console.log("[release] " + command + " " + commandArgs.join(" "));
  execFileSync(command, commandArgs, {
    cwd: ROOT,
    stdio: "inherit",
    shell: process.platform === "win32",
    ...options,
  });
}

function capture(command, commandArgs) {
  return execFileSync(command, commandArgs, {
    cwd: ROOT,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();
}

function fail(message) {
  console.error("[release] " + message);
  process.exit(1);
}

function usage() {
  console.log(`Usage: node scripts/release.mjs --tag vX.Y.Z [options]

  --tag <vX.Y.Z>     release to create or update (required)
  --only <scope>     android | macos | all (default: all)
  --skip-build       upload what is already in builds/
  --skip-client      reuse the current client/dist
  --allow-dirty      release from a working tree with uncommitted changes
  --prerelease       mark the release as a pre-release
  --notes <text>     release notes (default: generated from commits)
  --notes-file <p>   read the release notes from a file
  --dry-run          build and print the plan, upload nothing`);
}

function parseArgs(argv) {
  const options = { only: "all" };
  for (let i = 0; i < argv.length; i++) {
    // Both spellings are accepted: --only=android and --only android.
    const [arg, inline] = argv[i].startsWith("--") && argv[i].includes("=")
      ? [argv[i].slice(0, argv[i].indexOf("=")), argv[i].slice(argv[i].indexOf("=") + 1)]
      : [argv[i], null];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    if (FLAGS.includes(arg)) {
      options[key] = inline === null ? argv[++i] : inline;
      continue;
    }
    if (KNOWN_SWITCHES.includes(arg) && inline === null) {
      options[key] = true;
      continue;
    }
    fail("unknown option " + argv[i] + " (--help for the list)");
  }
  return options;
}

/** owner/repo of `origin`, so release URLs are never hardcoded twice. */
function repositorySlug() {
  let remote;
  try {
    remote = capture("git", ["remote", "get-url", "origin"]);
  } catch {
    fail("no git remote named origin: add the GitHub repository first");
  }
  const match = /github\.com[:/]([^/]+)\/(.+?)(?:\.git)?$/.exec(remote);
  if (!match) fail("origin is not a GitHub repository: " + remote);
  return match[1] + "/" + match[2];
}

function preflight(options, slug) {
  if (!options.tag) fail("--tag is required (for example --tag v0.1.0)");
  if (!/^v\d+\.\d+\.\d+/.test(options.tag)) {
    console.warn("[release] warning: " + options.tag + " is not a vX.Y.Z tag");
  }
  if (!["all", "android", "macos"].includes(options.only)) {
    fail("--only must be android, macos or all");
  }
  try {
    const status = capture("git", ["status", "--porcelain"]);
    if (status && !options.allowDirty) {
      fail("the working tree has uncommitted changes; commit them or pass --allow-dirty");
    }
  } catch {
    fail("this is not a git checkout");
  }
  try {
    capture("gh", ["auth", "status"]);
  } catch {
    fail("gh is not authenticated (run: gh auth login)");
  }
  try {
    capture("gh", ["release", "view", options.tag, "-R", slug]);
    console.log("[release] release " + options.tag + " already exists: assets will be replaced");
  } catch {
    // No release yet: this run creates it.
  }
  console.log("[release] repository " + slug + ", tag " + options.tag + ", scope " + options.only);
}

function buildClient(options) {
  if (options.skipBuild || options.skipClient) return;
  run("npm", ["run", "build:client"]);
}

function buildAndroid(options) {
  if (options.skipBuild) return;
  for (const variant of ["withServer", "client"]) {
    run("node", ["scripts/build-android.mjs", variant]);
  }
}

function buildMacos(options) {
  if (options.skipBuild) return;
  // build-tauri copies the disk image into builds/ as part of the run.
  run("node", ["scripts/build-tauri.mjs"]);
}

function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function humanSize(bytes) {
  return (bytes / 1024 / 1024).toFixed(1) + " MB";
}

/**
 * Files to upload: the installers of the selected scope plus the metadata the
 * server reads to describe them to a client.
 *
 * @returns {string[]} absolute paths inside builds/
 */
function collectAssets(options) {
  const wanted = [];
  for (const scope of options.only === "all" ? ["android", "macos"] : [options.only]) {
    for (const asset of ASSETS[scope]) wanted.push({ ...asset, scope });
  }

  const files = [];
  for (const asset of wanted) {
    const file = path.join(BUILD_DIR, asset.file);
    if (!fs.existsSync(file)) {
      fail(asset.file + " is missing from builds/" + (options.skipBuild ? "" : " after the build"));
    }
    files.push({ ...asset, path: file });
  }
  return files;
}

/** Sidecar list so anyone can verify a download. */
function writeChecksums(files) {
  const lines = files
    .filter((file) => file.file !== "SHA256SUMS")
    .map((file) => sha256(file.path) + "  " + file.file);
  const target = path.join(BUILD_DIR, "SHA256SUMS");
  fs.writeFileSync(target, lines.join("\n") + "\n");
  return target;
}

function publish(options, slug, files) {
  const uploads = files.map((file) => file.path);
  let exists = true;
  try {
    capture("gh", ["release", "view", options.tag, "-R", slug]);
  } catch {
    exists = false;
  }

  if (exists) {
    run("gh", ["release", "upload", options.tag, ...uploads, "--clobber", "-R", slug]);
    return;
  }

  const create = ["release", "create", options.tag, ...uploads, "-R", slug, "--title", options.tag];
  if (options.prerelease) create.push("--prerelease");
  else create.push("--latest");
  if (options.notes) create.push("--notes", options.notes);
  else if (options.notesFile) create.push("--notes-file", options.notesFile);
  else create.push("--generate-notes");
  run("gh", [...create]);
}

function main() {
  const options = parseArgs(args);
  const slug = repositorySlug();
  preflight(options, slug);

  buildClient(options);
  if (options.only !== "macos") buildAndroid(options);
  if (options.only !== "android") buildMacos(options);

  const files = collectAssets(options);
  const checksums = writeChecksums(files);
  files.push({ file: "SHA256SUMS", path: checksums, label: "Checksums" });

  console.log("[release] assets");
  for (const file of files) {
    console.log("[release]   " + file.file.padEnd(30) + humanSize(fs.statSync(file.path).size) +
      "  " + file.label);
  }

  if (options.dryRun) {
    console.log("[release] dry run: nothing uploaded. Run without --dry-run to publish " + options.tag);
    return;
  }

  publish(options, slug, files);

  console.log("[release] " + slug + " " + options.tag + " published");
  for (const file of files) {
    console.log("[release]   https://github.com/" + slug + "/releases/latest/download/" + file.file);
  }
}

try {
  main();
} catch (error) {
  fail(error.message);
}

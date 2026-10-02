#!/usr/bin/env node
/**
 * Build the MangaYomu desktop app (Tauri).
 *
 * Steps: compile the client → stage the Node runtime sidecar and the server
 * payload → let Tauri build the native app → package the macOS disk image.
 *
 * The disk image is created with `hdiutil` instead of Tauri's styled DMG: the
 * styled variant drives Finder through AppleScript, which fails on any machine
 * without Automation permission and in CI. A plain image with the app plus an
 * /Applications shortcut installs the same way.
 *
 * Usage:
 *   node scripts/build-tauri.mjs                 # host platform, with DMG on macOS
 *   node scripts/build-tauri.mjs --no-dmg
 *   node scripts/build-tauri.mjs --target win-x64 --skip-client
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BUNDLES, parseTargets, targetTriple } from "./lib/tauri-targets.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const args = process.argv.slice(2);

function run(command, commandArgs) {
  execFileSync(command, commandArgs, { cwd: ROOT, stdio: "inherit", shell: process.platform === "win32" });
}

function tauriBin() {
  const binary = path.join(
    ROOT, "node_modules", ".bin",
    process.platform === "win32" ? "tauri.cmd" : "tauri"
  );
  if (!fs.existsSync(binary)) {
    throw new Error("@tauri-apps/cli is missing. Run npm install first.");
  }
  return binary;
}

function readConfig() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf-8"));
}

function bundleRoot(targets) {
  return targets.length === 1
    ? path.join(ROOT, "src-tauri", "target", targetTriple(targets[0]), "release", "bundle")
    : path.join(ROOT, "src-tauri", "target", "release", "bundle");
}

/**
 * Package the built .app as a disk image.
 *
 * `hdiutil create -srcfolder` needs no GUI session, so this works locally and
 * on CI. The staging folder adds the usual drag-to-Applications shortcut.
 */
function createMacDmg(bundleDir, config, target) {
  const macosDir = path.join(bundleDir, "macos");
  const appName = config.productName + ".app";
  const appPath = path.join(macosDir, appName);
  if (!fs.existsSync(appPath)) {
    throw new Error("Missing " + appPath + "; the app bundle was not produced");
  }

  const arch = target.startsWith("mac-arm64") ? "aarch64" : "x64";
  const dmgDir = path.join(bundleDir, "dmg");
  fs.mkdirSync(dmgDir, { recursive: true });
  const dmgPath = path.join(dmgDir, `${config.productName}_${config.version}_${arch}.dmg`);

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "mangayomu-dmg-"));
  try {
    fs.cpSync(appPath, path.join(staging, appName), { recursive: true, force: true });
    fs.symlinkSync("/Applications", path.join(staging, "Applications"));
    rmFile(dmgPath);
    execFileSync("hdiutil", [
      "create", "-volname", config.productName,
      "-srcfolder", staging,
      "-format", "UDZO", "-ov", dmgPath,
    ], { stdio: ["ignore", "ignore", "inherit"] });
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
  return dmgPath;
}

function rmFile(file) {
  try {
    fs.rmSync(file, { force: true });
  } catch (error) {
    // A leftover image is not fatal: hdiutil -ov overwrites it anyway.
  }
}

/**
 * Copy the distributable artifacts into `builds/` next to the Android APKs, so
 * every platform has one known folder and stable file names.
 */
function publishToBuilds(bundleDir, config, targets, dmgPath) {
  const outDir = path.join(ROOT, "builds");
  fs.mkdirSync(outDir, { recursive: true });
  const published = [];

  if (dmgPath) {
    const suffix = (targets[0] || "mac-arm64") === "mac-x64" ? "macos-x64" : "macos-arm64";
    const destination = path.join(outDir, `mangayomu-${suffix}.dmg`);
    fs.copyFileSync(dmgPath, destination);
    published.push(destination);
  }

  // NSIS installers land in bundle/nsis with an arch/version suffix.
  const nsisDir = path.join(bundleDir, "nsis");
  if (fs.existsSync(nsisDir)) {
    const installer = fs.readdirSync(nsisDir).find((file) => file.endsWith("-setup.exe"));
    if (installer) {
      const arch = installer.includes("arm64") ? "arm64" : "x64";
      const destination = path.join(outDir, `mangayomu-windows-${arch}-setup.exe`);
      fs.copyFileSync(path.join(nsisDir, installer), destination);
      published.push(destination);
    }
  }

  void config;
  return published;
}

const KNOWN_FLAGS = ["--skip-client", "--no-dmg", "--no-publish", "--all-targets"];

function assertKnownFlags(argv) {
  const unknown = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    // --target consumes the following value (shorthand list).
    if (arg === "--target") {
      i++;
      continue;
    }
    if (arg.startsWith("--") && !KNOWN_FLAGS.includes(arg)) unknown.push(arg);
  }
  if (unknown.length > 0) {
    throw new Error(
      "Unknown option " + unknown.join(" ") +
      ". Supported: --target <mac-arm64|mac-x64|win-x64|all>, --skip-client, --no-dmg, --no-publish, --all-targets"
    );
  }
}

function main() {
  assertKnownFlags(args);
  const targets = parseTargets(args);
  const bundles = [...(BUNDLES[process.platform] || [])];
  if (!args.includes("--skip-client")) {
    console.log("[tauri] building the client");
    run("npm", ["run", "build:client"]);
  }

  console.log("[tauri] staging the embedded server for " + targets.join(", "));
  run("node", ["scripts/bundle-tauri-server.mjs", "--target", targets.join(",")]);

  const command = [tauriBin(), "build", "--bundles", bundles.join(",")];
  // Building every platform from one machine only works for the host target.
  if (targets.length === 1 && !args.includes("--all-targets")) {
    command.push("--target", targetTriple(targets[0]));
  }

  console.log("[tauri] " + command.slice(1).join(" "));
  run(command[0], command.slice(1));

  const root = bundleRoot(targets);
  const config = readConfig();
  let dmgPath = null;
  if (process.platform === "darwin" && !args.includes("--no-dmg")) {
    dmgPath = createMacDmg(root, config, targets[0] || "mac-arm64");
    console.log("[tauri] disk image → " + path.relative(ROOT, dmgPath) +
      " (" + (fs.statSync(dmgPath).size / 1024 / 1024).toFixed(1) + " MB)");
  }

  if (!args.includes("--no-publish")) {
    const published = publishToBuilds(root, config, targets, dmgPath);
    if (published.length === 0) {
      console.log("[tauri] nothing to publish (use --no-dmg for the app only)");
    }
    for (const file of published) {
      console.log("[tauri] published → " + path.relative(ROOT, file) +
        " (" + (fs.statSync(file).size / 1024 / 1024).toFixed(1) + " MB)");
    }
  }

  console.log("[tauri] done — artifacts in " + path.relative(ROOT, root));
}

try {
  main();
} catch (error) {
  console.error("[tauri] failed:", error.message);
  process.exit(1);
}

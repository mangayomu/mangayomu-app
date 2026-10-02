#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeBuildInfo } from "./save-build-info.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const variant = process.argv[2];

if (variant !== "client" && variant !== "withServer") {
  throw new Error("Usage: node scripts/build-android.mjs <client|withServer>");
}

function resolveJavaHome() {
  // Prefer a compiler new enough for this Android project over a stale shell
  // JAVA_HOME left by an older Gradle daemon.
  for (const version of ["21", "24"]) {
    try {
      return execFileSync("/usr/libexec/java_home", ["-v", version], { encoding: "utf8" }).trim();
    } catch {}
  }
  return process.env.JAVA_HOME;
}

const javaHome = resolveJavaHome();

function run(command, args) {
  execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, ...(javaHome ? { JAVA_HOME: javaHome } : {}) }
  });
}

function findApk(directory, expectedName) {
  const entries = fs.readdirSync(directory, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      const found = findApk(fullPath, expectedName);
      if (found) return found;
    } else if (entry.name === expectedName) {
      return fullPath;
    }
  }
  return null;
}

function archiveContains(apkPath, pattern) {
  // Ask unzip for one bounded pattern instead of listing the entire embedded
  // Node dependency tree, which exceeds spawnSync's default output buffer.
  try {
    const listing = execFileSync("unzip", ["-l", apkPath, pattern], { encoding: "utf8" });
    return !/0 files/.test(listing);
  } catch (error) {
    // unzip uses status 11 to report a valid archive with no matching entry.
    if (error && error.status === 11) return false;
    throw error;
  }
}

function inspectApk(apkPath, expectServer) {
  const hasNodeLibrary = archiveContains(apkPath, "lib/*/libnode.so");
  const hasNodeEntry = archiveContains(apkPath, "assets/nodejs-project/src/index.js");
  const containsNode = hasNodeLibrary || hasNodeEntry;
  if (expectServer && (!hasNodeLibrary || !hasNodeEntry)) {
    throw new Error("withServer APK is missing embedded Node runtime markers");
  }
  if (!expectServer && containsNode) {
    throw new Error("client APK unexpectedly contains embedded Node runtime markers");
  }
}

run("npm", ["run", "build:client"]);
run("npx", ["cap", "sync", "android"]);

const nodeAssets = path.join(root, "android", "app", "src", "withServer", "assets", "nodejs-project");
if (variant === "withServer") {
  run("node", ["scripts/bundle-android-server.mjs"]);
} else {
  fs.rmSync(nodeAssets, { recursive: true, force: true });
}

const gradlew = path.join(root, "android", "gradlew");
// A previously running daemon can have been launched with an older JDK and
// ignores the JAVA_HOME selected above. Restart it before compiling Java 21.
run(gradlew, ["--stop"]);
const task = variant === "withServer" ? ":app:assembleWithServerDebug" : ":app:assembleClientDebug";
run(gradlew, ["-p", "android", task]);

const apkDir = path.join(root, "android", "app", "build", "outputs", "apk");
const sourceApk = findApk(apkDir, variant === "withServer" ? "app-withServer-debug.apk" : "app-client-debug.apk");
if (!sourceApk) throw new Error("Could not locate generated " + variant + " APK under " + apkDir);

const buildsDir = path.join(root, "builds");
fs.mkdirSync(buildsDir, { recursive: true });
const outputApk = path.join(buildsDir, variant === "withServer" ? "mangayomu-with-server.apk" : "mangayomu-client.apk");
fs.copyFileSync(sourceApk, outputApk);
inspectApk(outputApk, variant === "withServer");
// Both flavours are worth publishing: the with-server APK is self-contained,
// the client-only one is the small install for a phone that talks to a server.
writeBuildInfo(outputApk, path.basename(outputApk));
console.log("APK: " + outputApk);

#!/usr/bin/env node
/**
 * Prepare a clean Node.js server project for Android.
 * Copies only the npm packages that are actual runtime dependencies.
 */

import { execFileSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { rm, sha256, stageServerPayload } from "./lib/server-payload.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const ASSETS = path.resolve(ROOT, "android", "app", "src", "withServer", "assets", "nodejs-project");
const NMDIR = path.resolve(ROOT, "node_modules");
const CORE_NMDIR = NMDIR;
const ANDROID_APP = path.join(ROOT, "android", "app");
const NODE_RUNTIME_DIR = path.join(ANDROID_APP, "src", "withServer", "jniLibs");
const NODE_HEADERS_DIR = path.join(ANDROID_APP, "src", "withServer", "cpp", "include");

const NODE_RUNTIME = {
  alignedArchive: {
    url: "https://github.com/arkuna23/nodejs-mobile/releases/download/v18.20.4-16k%2Bicu/nodejs-mobile-android.zip",
    sha256: "5af5acc38db9d8fc86e9ebf1351f310787c3f13574a181a1566229fc6f2f7621",
  },
  arm32Archive: {
    url: "https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v18.20.4/nodejs-mobile-v18.20.4-android.zip",
    sha256: "bd7321eaa1a7602fbe0bb87302df2d79d87835cf4363fbdd17c350dbb485c2af",
  },
  libraries: {
    "arm64-v8a": "7e032ae2e104f31dc11629c266270d6eb48f0fc447c86d69c95e7ff8b9020848",
    "armeabi-v7a": "d60451f64718354b1a3d4857d20fbe56cc3a3dbe2c319c2911342aea2bbef92d",
    "x86_64": "09eaddbcec93a969c1c207e799f975355258bca542b0cbba0a77ce000439ed05",
  },
};

function nodeRuntimeIsReady() {
  for (const abi in NODE_RUNTIME.libraries) {
    const file = path.join(NODE_RUNTIME_DIR, abi, "libnode.so");
    if (!fs.existsSync(file) || sha256(file) !== NODE_RUNTIME.libraries[abi]) {
      return false;
    }
  }
  return fs.existsSync(path.join(NODE_HEADERS_DIR, "node.h"));
}

async function download(url, file, expectedSha256) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error("Could not download " + url + ": HTTP " + response.status);
  }
  const data = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(file, data);
  if (sha256(file) !== expectedSha256) {
    throw new Error("Checksum mismatch for " + url);
  }
}

async function provisionAndroidNodeRuntime() {
  if (nodeRuntimeIsReady()) return;

  console.log("[node-runtime] provisioning Node.js Mobile 18.20.4 with 16 KB support");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mangayomu-node-runtime-"));
  try {
    const alignedArchive = path.join(tempDir, "aligned.zip");
    const arm32Archive = path.join(tempDir, "arm32.zip");
    await download(NODE_RUNTIME.alignedArchive.url, alignedArchive, NODE_RUNTIME.alignedArchive.sha256);
    await download(NODE_RUNTIME.arm32Archive.url, arm32Archive, NODE_RUNTIME.arm32Archive.sha256);

    const alignedDir = path.join(tempDir, "aligned");
    const arm32Dir = path.join(tempDir, "arm32");
    execFileSync("unzip", ["-q", alignedArchive, "-d", alignedDir]);
    execFileSync("unzip", ["-q", arm32Archive, "-d", arm32Dir]);

    rm(NODE_RUNTIME_DIR);
    fs.mkdirSync(NODE_RUNTIME_DIR, { recursive: true });
    for (const abi of ["arm64-v8a", "x86_64"]) {
      const source = path.join(alignedDir, "bin", abi, "libnode.so");
      const destination = path.join(NODE_RUNTIME_DIR, abi, "libnode.so");
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(source, destination);
    }
    const arm32Source = path.join(arm32Dir, "bin", "armeabi-v7a", "libnode.so");
    const arm32Destination = path.join(NODE_RUNTIME_DIR, "armeabi-v7a", "libnode.so");
    fs.mkdirSync(path.dirname(arm32Destination), { recursive: true });
    fs.copyFileSync(arm32Source, arm32Destination);

    rm(NODE_HEADERS_DIR);
    fs.cpSync(path.join(alignedDir, "include", "node"), NODE_HEADERS_DIR, { recursive: true });
    if (!nodeRuntimeIsReady()) {
      throw new Error("Downloaded Node.js Mobile runtime did not match the pinned hashes");
    }
  } finally {
    rm(tempDir);
  }
}

async function main() {
  console.time("[bundle]");
  await provisionAndroidNodeRuntime();

  const version = stageServerPayload({
    destDir: ASSETS,
    serverSrcDir: path.resolve(ROOT, "server-android", "src"),
    corePackageDir: path.resolve(ROOT, "packages", "server-core"),
    rootNodeModules: CORE_NMDIR,
    packageName: "mangayomu-android-server",
    // Cheerio requires undici@7, which needs the browser File API unavailable
    // in Node 18/nodejs-mobile. Keep the project-pinned undici@5 instead.
    forceRootPackages: ["undici"],
    afterDependencies: (destDir) => {
      // The embedded server serves this compiled client to LAN browsers.
      const clientDist = path.resolve(ROOT, "client", "dist");
      if (!fs.existsSync(path.join(clientDist, "index.html"))) {
        throw new Error("Missing client/dist. Run npm run build:client before bundling Android server assets.");
      }
      fs.cpSync(clientDist, path.join(destDir, "public"), { recursive: true, force: true });

      // AAPT chokes on .js + .js.gz duplicates
      for (const f of fs.readdirSync(destDir, { recursive: true, withFileTypes: true })) {
        if (f.name.endsWith(".gz") && f.isFile()) {
          fs.rmSync(path.join(f.parentPath || f.path, f.name));
        }
      }
    },
  });

  function dirSize(dir) {
    let size = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules" && dir !== ASSETS) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) size += dirSize(p);
      else size += fs.statSync(p).size;
    }
    return size;
  }

  const total = dirSize(ASSETS);
  console.log(`[bundle] done — ${(total / 1024 / 1024).toFixed(1)} MB (${version.slice(0, 12)})`);
  console.timeEnd("[bundle]");
}

main().catch(err => {
  console.error("[bundle] failed:", err.message);
  process.exit(1);
});

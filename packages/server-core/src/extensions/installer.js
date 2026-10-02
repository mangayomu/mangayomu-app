/**
 * Extension package installation and updates.
 *
 * A package ZIP contains extension.json at its root plus optional server/ and
 * client/ targets. Installation is staging-first: the archive is extracted and
 * validated under <home>/.staging, then moved into <home>/extensions/<id> only
 * after every check passes. The UI never sees versioned directories.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFile, mkdir, rm, rename } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import yauzl from "yauzl";
import { parseManifest, hasServerSources } from "./manifest.js";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
export const MAX_ENTRIES = 200;
const MAX_UNCOMPRESSED = 10 * 1024 * 1024;

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

export function hashData(data) {
  return sha256(data);
}

/**
 * Read only the root extension.json from a ZIP buffer to learn the package id
 * before a full staged install.
 */
export async function peekManifest(buffer) {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.on("error", reject);
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (entry.fileName !== "extension.json") {
          zipfile.readEntry();
          return;
        }
        zipfile.openReadStream(entry, (err2, stream) => {
          if (err2) return reject(err2);
          let text = "";
          stream.setEncoding("utf8");
          stream.on("data", (chunk) => { text += chunk; });
          stream.on("end", () => { zipfile.close(); resolve(parseManifest(text)); });
          stream.on("error", reject);
        });
      });
      zipfile.on("end", () => reject(new Error("No extension.json found in package")));
    });
  });
}

export async function extractZip(buffer, stagingDir) {
  await new Promise((resolve, reject) => {
    let count = 0;
    let total = 0;
    yauzl.fromBuffer(buffer, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      zipfile.on("error", reject);
      zipfile.readEntry();
      zipfile.on("entry", (entry) => {
        if (++count > MAX_ENTRIES) {
          zipfile.close();
          return reject(new Error("Too many files in package"));
        }
        const name = entry.fileName;
        const isDir = /\/$/.test(name);
        if (!isDir && (name.includes("..") || name.startsWith("/") || name.includes("\\"))) {
          zipfile.close();
          return reject(new Error("Unsafe path in package: " + name));
        }
        const unixMode = entry.externalFileAttributes >>> 16;
        if ((unixMode & 0o170000) === 0o120000) {
          zipfile.close();
          return reject(new Error("Symlinks are not allowed in a package"));
        }
        total += entry.uncompressedSize;
        if (total > MAX_UNCOMPRESSED) {
          zipfile.close();
          return reject(new Error("Package is too large when extracted"));
        }
        if (isDir) return zipfile.readEntry();

        const dest = path.join(stagingDir, name);
        mkdir(path.dirname(dest), { recursive: true })
          .then(() => {
            return new Promise((openResolve, openReject) => {
              zipfile.openReadStream(entry, (err2, stream) => {
                if (err2) return openReject(err2);
                const out = fs.createWriteStream(dest);
                stream.pipe(out);
                stream.on("error", (e) => { out.destroy(); openReject(e); });
                out.on("finish", () => openResolve());
                out.on("error", (e) => openReject(e));
              });
            });
          })
          .then(() => zipfile.readEntry())
          .catch((e) => { zipfile.close(); reject(e); });
      });
      zipfile.on("end", () => resolve());
    });
  });
}

async function stageAndValidate(buffer, home) {
  const stagingRoot = path.join(home, ".staging");
  await mkdir(stagingRoot, { recursive: true });
  const stagingDir = path.join(stagingRoot, randomUUID());
  await mkdir(stagingDir, { recursive: true });
  try {
    await extractZip(buffer, stagingDir);
    const manifestText = await readFile(path.join(stagingDir, "extension.json"), "utf-8");
    const manifest = parseManifest(manifestText);
    if (hasServerSources(manifest) && !fs.existsSync(path.join(stagingDir, manifest.entrypoints.server))) {
      throw new Error("Declared server entry point is missing from the package");
    }
    return { stagingDir, manifest };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

function semverCompare(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] > pb[i]) return 1;
    if (pa[i] < pb[i]) return -1;
  }
  return 0;
}

/**
 * Install an extension package from a raw ZIP buffer.
 *
 * @param {Buffer}    buffer  raw ZIP bytes
 * @param {string}    home    the MangaYomu home (packages live under home/extensions)
 * @param {object}    existing optional current install record {version, content_hash}
 * @returns {Promise<{status, manifest, id, installDir, contentHash}>}
 */
export async function installPackage({ buffer, home, existing }) {
  const { stagingDir, manifest } = await stageAndValidate(buffer, home);
  const id = manifest.id;
  const installDir = path.join(home, "extensions", id);
  const contentHash = sha256(buffer);

  try {
    // Reinstall of an identical id+version+content is a no-op.
    if (existing && existing.version === manifest.version) {
      if (existing.content_hash === contentHash) {
        // Self-heal: the no-op path is only valid while the installed files are
        // still present. If the directory (or its declared server entry) is
        // missing, re-extract the staged package instead of leaving a broken
        // install that the UI would keep listing.
        const manifestFile = path.join(installDir, "extension.json");
        const entryFile =
          manifest.entrypoints && manifest.entrypoints.server
            ? path.join(installDir, manifest.entrypoints.server)
            : null;
        const intact = fs.existsSync(manifestFile) && (!entryFile || fs.existsSync(entryFile));
        if (intact) {
          await rm(stagingDir, { recursive: true, force: true });
          return { status: "noop", manifest, id, installDir, contentHash };
        }
      } else {
        throw new Error("A different package with the same version is already installed");
      }
    }
    if (existing && semverCompare(manifest.version, existing.version) < 0) {
      throw new Error("Cannot downgrade an installed package");
    }
    // Promote the staged package without destroying the previous stable copy
    // until the new one is fully in place.
    const tmp = installDir + ".tmp-" + randomUUID();
    const backup = installDir + ".bak-" + randomUUID();
    const hadExisting = fs.existsSync(installDir);
    await mkdir(path.dirname(installDir), { recursive: true });
    await rename(stagingDir, tmp);
    try {
      if (hadExisting) await rename(installDir, backup);
      await rename(tmp, installDir);
      if (hadExisting) await rm(backup, { recursive: true, force: true });
    } catch (err) {
      await rm(tmp, { recursive: true, force: true }).catch(() => {});
      if (hadExisting && fs.existsSync(backup)) {
        await rm(installDir, { recursive: true, force: true }).catch(() => {});
        await rename(backup, installDir).catch(() => {});
      }
      throw err;
    }
    return {
      status: existing ? "updated" : "installed",
      manifest,
      id,
      installDir,
      contentHash,
    };
  } catch (err) {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Reject literal private/loopback host strings.
 *
 * This is best-effort: it does not resolve hostnames, so a name that resolves
 * to a private or link-local address (including DNS rebinding) is not caught.
 * The admin-constrained trusted chain limits exposure, but this is not a
 * sandbox.
 */
function isBlockedHost(host) {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "0.0.0.0" || h === "::") return true;
  // IPv4-mapped IPv6 (::ffff:10.0.0.1) evaluates to its embedded IPv4.
  const mapped = h.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  const ipv4 = mapped ? mapped[1] : h;
  return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ipv4);
}

/**
 * Dev-only opt-in (MANGAYOMU_ALLOW_LOCAL_EXTENSION_URLS=1): allow http:// to
 * literal loopback hosts so a locally hosted extension repository can be
 * tested. Every production restriction stays in effect by default.
 */
function allowLocalDevUrl(parsed) {
  if (process.env.MANGAYOMU_ALLOW_LOCAL_EXTENSION_URLS !== "1") return false;
  if (parsed.protocol !== "http:") return false;
  const h = String(parsed.hostname).toLowerCase().replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "127.0.0.1" || h === "::1";
}

function assertAllowedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    throw new Error("Invalid package URL");
  }
  if (parsed.username || parsed.password) throw new Error("Package URL must not contain credentials");
  if (allowLocalDevUrl(parsed)) return parsed;
  if (parsed.protocol !== "https:") throw new Error("Package URL must use HTTPS");
  if (isBlockedHost(parsed.hostname)) {
    throw new Error("Package URL host is not allowed");
  }
  return parsed;
}

/**
 * Download a package (ZIP) over HTTPS with size, redirect, credential and
 * literal private-network protections. With MANGAYOMU_ALLOW_LOCAL_EXTENSION_URLS=1
 * (dev only) http:// URLs to localhost/127.0.0.1/::1 are also accepted.
 */
export async function downloadUrl(url, { limit = MAX_UPLOAD_BYTES, redirects = 5 } = {}) {
  let current = assertAllowedUrl(url).toString();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    let response = await fetch(current, { redirect: "manual", signal: controller.signal });
    let redirectCount = 0;
    while (response.status >= 300 && response.status < 400 && response.headers.get("location")) {
      if (++redirectCount > redirects) throw new Error("Too many redirects");
      const location = response.headers.get("location");
      // Validate every redirect target and resolve relative locations against
      // the immediately preceding URL.
      current = assertAllowedUrl(new URL(location, current).toString()).toString();
      response = await fetch(current, { redirect: "manual", signal: controller.signal });
    }
    if (!response.ok) throw new Error("Package download failed: HTTP " + response.status);
    const length = Number(response.headers.get("content-length") || 0);
    if (length > limit) throw new Error("Package is too large");
    // Enforce the byte limit while reading the body so a chunked or lying
    // upstream cannot force a large allocation before the size check trips.
    if (!response.body || !response.body.getReader) {
      const data = Buffer.from(await response.arrayBuffer());
      if (data.length > limit) throw new Error("Package is too large");
      return data;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > limit) {
        if (reader.cancel) reader.cancel().catch(() => {});
        throw new Error("Package is too large");
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
  }
}

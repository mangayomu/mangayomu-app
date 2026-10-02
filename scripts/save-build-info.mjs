/**
 * Post-build metadata for the downloadable APKs.
 *
 * `writeBuildInfo` is also called by `build-android.mjs`, so the file written
 * after a CLI build is the same one this script would write. Both flavours are
 * recorded next to each other: the with-server APK is self-contained, the
 * client-only one needs a server and is the small install for a phone.
 *
 * CLI: node scripts/save-build-info.mjs [apk-path]
 */

import fs from "fs";
import path from "path";

var BUILD_INFO_DIR = path.resolve(import.meta.dirname, "..", "builds");
var DEFAULT_APK = path.resolve(
  import.meta.dirname, "..",
  "android/app/build/outputs/apk/debug/app-withServer-debug.apk"
);

const WITH_SERVER = "mangayomu-with-server.apk";
const CLIENT = "mangayomu-client.apk";

/** "YYYY-MM-DD HH:MM:SS" in the local timezone, matching the recorded format. */
function formatDate(date) {
  var pad = (value) => String(value).padStart(2, "0");
  return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    " " + pad(date.getHours()) + ":" + pad(date.getMinutes()) + ":" + pad(date.getSeconds());
}

function variantOf(apkName) {
  return apkName === CLIENT ? "client" : "withServer";
}

/**
 * Copy an APK into builds/ and record it, keeping the other flavour intact.
 *
 * @param {string} apkPath  built APK to publish
 * @param {string} [apkName] name inside builds/ (default: the with-server APK)
 * @returns {object | null} the metadata written, or null when the APK is missing
 */
export function writeBuildInfo(apkPath, apkName = WITH_SERVER) {
  fs.mkdirSync(BUILD_INFO_DIR, { recursive: true });

  if (!fs.existsSync(apkPath)) {
    console.warn("[build-info] APK not found at", apkPath);
    return null;
  }

  var destApk = path.join(BUILD_INFO_DIR, apkName);
  fs.copyFileSync(apkPath, destApk);

  // The date comes from the APK itself, not from the clock: registering a file
  // that was built days ago (or copying one by hand) must not claim it is fresh.
  var entry = {
    buildDate: formatDate(fs.statSync(apkPath).mtime),
    apkSize: fs.statSync(destApk).size,
    apkName: apkName,
  };

  // Read what is already there so building one flavour never erases the other.
  var infoPath = path.join(BUILD_INFO_DIR, "build-info.json");
  var previous = {};
  try {
    if (fs.existsSync(infoPath)) previous = JSON.parse(fs.readFileSync(infoPath, "utf-8"));
  } catch (err) { /* a corrupt file is simply replaced */ }

  var builds = { ...(previous.builds || {}) };
  // A file written before this script knew about two flavours keeps its
  // meaning: the flat fields described the with-server build.
  for (const name of [WITH_SERVER, CLIENT]) {
    var variant = variantOf(name);
    if (!builds[variant] && previous.apkName === name && previous.buildDate) {
      builds[variant] = { buildDate: previous.buildDate, apkSize: previous.apkSize || 0, apkName: name };
    }
  }
  builds[variantOf(apkName)] = entry;

  // Whatever else is present on disk is part of the offer too.
  for (const name of [WITH_SERVER, CLIENT]) {
    var variant = variantOf(name);
    if (builds[variant]) continue;
    var other = path.join(BUILD_INFO_DIR, name);
    if (!fs.existsSync(other)) continue;
    var stats = fs.statSync(other);
    builds[variant] = {
      buildDate: formatDate(stats.mtime),
      apkSize: stats.size,
      apkName: name,
    };
  }

  // The flat fields keep describing the with-server flavour for readers that
  // predate the two-flavour file.
  var withServer = builds.withServer || entry;
  var info = {
    buildDate: withServer.buildDate,
    apkSize: withServer.apkSize,
    apkName: withServer.apkName,
    builds: builds,
  };

  fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
  console.log("[build-info] " + entry.apkName + " (" + entry.apkSize + " bytes) · " + entry.buildDate);
  return info;
}

// CLI entry: only when run directly, so importing this module stays silent.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  writeBuildInfo(process.argv[2] || DEFAULT_APK);
}

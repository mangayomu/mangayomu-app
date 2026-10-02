/**
 * Android entry point for the embedded Node.js server.
 * Bundled by scripts/bundle-android-server.mjs into server-bundle.js.
 */

import path from "path";
import { createApp } from "@mangayomu/server-core";
import { fileURLToPath } from "url";

// Force sql.js driver on Android — better-sqlite3 native addon cannot load here.
process.env.DB_DRIVER = "sqljs";

// The bundle script injects the WASM path at build time; here we ensure
// sql.js can locate its WASM binary relative to the bundle's directory.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
process.env.SQLJS_WASM_DIR = __dirname;

const PORT = parseInt(process.env.PORT || "4567", 10);
const APP_FILES_DIR = path.resolve(__dirname, "..", "..");
const DB_PATH = process.env.DB_PATH || path.join(APP_FILES_DIR, "mangayomu-data", "mangayomu.db");

// Wrap in an async function so the bundle can be CJS-compatible
const main = async () => {
  const { app } = await createApp({
    dbPath: DB_PATH,
    // Extensions live outside the copied nodejs-project assets and survive
    // both app restarts and APK re-extraction.
    defaultHome: path.resolve(__dirname, "..", "..", "extensions"),
    staticDir: path.join(__dirname, "..", "public")
  });

  const server = app.listen(PORT, "0.0.0.0", function () {
    console.log("MangaYomu (Android) running on http://0.0.0.0:" + PORT);
  });

  // nodejs-mobile runs inside the Android process: process.exit() would kill
  // the whole app. If another application owns the configured port, keep the
  // Capacitor fallback UI alive and let its health probe time out gracefully.
  server.on("error", (err) => {
    console.error("[server-android] listen failed:", err);
    keepRuntimeAlive();
  });
};

function keepRuntimeAlive() {
  setInterval(() => {}, 60 * 60 * 1000);
}

main().catch((err) => {
  console.error("[server-android] fatal:", err);
  keepRuntimeAlive();
});

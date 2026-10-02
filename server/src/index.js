import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { createApp } from "@mangayomu/server-core";
import {
  parsePort, findAvailablePort, writeRuntimeFile, ownsRuntimeFile, DEV_PORT,
} from "./dev-port.js";

// Dev-only (`npm run dev`): when the default API port is occupied, pick the
// next free loopback port and tell the Vite client where to connect by writing
// a runtime JSON file under client/public. An explicitly set PORT keeps the
// classic strict bind (no silent port change); production and Android are
// unaffected because they never set MANGAYOMU_DEV.
const IS_DEV = process.env.MANGAYOMU_DEV === "1";
const EXPLICIT_PORT = process.env.PORT;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

let host = "0.0.0.0";
let port = parsePort(EXPLICIT_PORT, DEV_PORT);

const options = {
  ...(process.env.MANGAYOMU_SERVE_STATIC === "1" ? { staticDir: path.join(root, "client", "dist") } : {}),
  ...(process.env.DB_PATH ? { dbPath: process.env.DB_PATH } : {})
};

let runtimePath = null;
if (IS_DEV) {
  if (!EXPLICIT_PORT) {
    const found = await findAvailablePort(port, Math.min(65535, port + 100));
    if (found === null) {
      console.error("[server] EADDRINUSE: no free port between " + port + " and " + (port + 100) + "; free one or set PORT");
      process.exit(1);
    }
    port = found;
    // Loopback is fine for local development; the browser reaches it directly.
    host = "127.0.0.1";
  }
  runtimePath = path.join(root, "client", "public", "mangayomu-runtime.json");
}

const { app } = await createApp(options);

// Only remove the runtime file we actually wrote; another dev process may
// currently own it with a different port.
process.on("exit", function () {
  if (runtimePath && ownsRuntimeFile(runtimePath, port)) {
    try { fs.unlinkSync(runtimePath); } catch (err) { /* best-effort */ }
  }
});

app.listen(port, host, function () {
  if (runtimePath) {
    try { writeRuntimeFile(runtimePath, port); } catch (err) {
      console.error("[server] failed to write dev runtime config: " + err.message);
    }
  }
  console.log("MangaYomu running on http://" + host + ":" + port);
  if (options.staticDir) console.log("Serving client from " + options.staticDir);
});
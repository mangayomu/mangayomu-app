/**
 * Development-only HTTP port helpers for `npm run dev`.
 *
 * The API server defaults to port 4567. When that port is already in use we
 * pick the next free loopback port and expose the chosen origin in a small
 * runtime JSON file under client/public, where the Vite client can discover it
 * (see client/src/connection.ts). Production (`npm run start`) and Android
 * never touch these paths.
 *
 * Helpers are pure so they can be exercised by fullfill/dev-port.mjs.
 */

import fs from "node:fs";
import net from "node:net";
import path from "node:path";

export const DEV_PORT = 4567;

/** Parse a PORT-style value. Invalid/out-of-range values fall back to `fallback`. */
export function parsePort(value, fallback = DEV_PORT) {
  const port = Number.parseInt(String(value ?? ""), 10);
  if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
  return fallback;
}

/** The exact payload the Vite client consumes when served the runtime file. */
export function runtimeConfig(port) {
  return { kind: "mangayomu-server", serverUrl: "http://127.0.0.1:" + port, apiBase: "/api" };
}

/**
 * Find the first free loopback port in [start, maxPort].
 * Returns null when no port in the range is free.
 */
export function findAvailablePort(start, maxPort) {
  return new Promise((resolve) => {
    function probe(port) {
      if (port > maxPort) return resolve(null);
      const server = net.createServer();
      server.once("error", () => {
        server.close(() => probe(port + 1));
      });
      server.listen(port, "127.0.0.1", () => {
        server.close(() => resolve(port));
      });
    }
    probe(start);
  });
}

/** Atomically write the runtime config (temp file + rename). */
export function writeRuntimeFile(filePath, port) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(runtimeConfig(port), null, 2) + "\n");
  fs.renameSync(tmp, filePath);
}

/** True when filePath exists and was written for `port` by a MangaYomu dev server. */
export function ownsRuntimeFile(filePath, port) {
  try {
    if (!fs.existsSync(filePath)) return false;
    const data = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return data && data.kind === "mangayomu-server" && data.serverUrl === "http://127.0.0.1:" + port;
  } catch {
    return false;
  }
}
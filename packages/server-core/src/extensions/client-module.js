/**
 * Client-module resolution for installed extension packages.
 *
 * A package with an `entrypoints.client` value ships a self-contained
 * browser module under its `client/` directory. The host app loads it
 * asynchronously (TinyBubble importComponent) and mounts the panels/actions
 * it registers. The server only ever serves files inside the installed
 * package's `client/` directory, never the extension home or host data.
 */

import path from "node:path";

const MIME_TYPES = {
  ".mjs": "text/javascript",
  ".js": "text/javascript",
  ".json": "application/json",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json",
};

/**
 * Resolve a client-relative file inside an installed package directory.
 * Only relative POSIX paths below `client/` are allowed.
 * @param {string} installDir absolute path to <home>/extensions/<id>
 * @param {string} file       package-relative file, e.g. "client/index.mjs"
 * @returns {string} absolute path to the file
 */
export function resolveClientModulePath(installDir, file) {
  if (typeof file !== "string" || !file) {
    throw new Error("Client module path is required");
  }
  if (file.startsWith("/") || file.includes("\\") || file.includes("\0")) {
    throw new Error("Client module path is not relative");
  }
  const parts = file.split("/");
  if (parts[0] !== "client" || parts.includes("..") || parts.includes("")) {
    throw new Error("Client module path must be inside the client directory");
  }
  const clientRoot = path.resolve(installDir, "client");
  const resolved = path.resolve(clientRoot, ...parts.slice(1));
  if (!resolved.startsWith(clientRoot + path.sep)) {
    throw new Error("Client module path escapes the client directory");
  }
  return resolved;
}

/** Content type for a client file name (defaults to text/plain). */
export function clientContentType(fileName) {
  const ext = path.extname(String(fileName)).toLowerCase();
  return MIME_TYPES[ext] || "text/plain";
}
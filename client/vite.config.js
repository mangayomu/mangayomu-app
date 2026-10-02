import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const clientDir = path.dirname(fileURLToPath(import.meta.url));

// TinyBubble and its bubble-translate plugin come from the package registry
// (a GitHub branch of antocorr/tinybubble), so they resolve through normal
// package resolution and need no alias here.
export default defineConfig({
  root: ".",
  resolve: {
    alias: [
      // bcryptjs and protobufjs probe Node APIs before taking their browser
      // paths. Supply those narrow browser implementations instead of letting
      // Vite inject noisy Node compatibility proxies.
      { find: "crypto", replacement: path.resolve(clientDir, "src/shims/crypto.ts") },
      { find: "fs", replacement: path.resolve(clientDir, "src/shims/fs.ts") }
    ]
  },
  server: {
    host: "0.0.0.0",
    port: 8910,
    cors: true
  }
});

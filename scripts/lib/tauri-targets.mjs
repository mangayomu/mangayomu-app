/**
 * Tauri target table shared by the staging script and the build entry point.
 *
 * Shorthand names keep the CLI usable (`--target win-x64`), while the Rust
 * triple is what Tauri and `rustc` need for the sidecar file name.
 */

import { execFileSync } from "node:child_process";

export const TARGETS = {
  "mac-arm64": { triple: "aarch64-apple-darwin", node: "darwin-arm64" },
  "mac-x64": { triple: "x86_64-apple-darwin", node: "darwin-x64" },
  "win-x64": { triple: "x86_64-pc-windows-msvc", node: "win-x64" },
};

/** Bundle formats that make sense on each platform. */
export const BUNDLES = {
  darwin: ["app"],
  win32: ["nsis"],
  linux: ["deb", "appimage"],
};

export function hostTriple() {
  return execFileSync("rustc", ["--print", "host-tuple"], { encoding: "utf8" }).trim();
}

/** Shorthand name of the machine running the build. */
export function hostShorthand() {
  const triple = hostTriple();
  for (const [shorthand, spec] of Object.entries(TARGETS)) {
    if (spec.triple === triple) return shorthand;
  }
  throw new Error("Unsupported host triple " + triple + "; pass --target " + Object.keys(TARGETS).join("|"));
}

export function parseTargets(argv) {
  const index = argv.indexOf("--target");
  if (index === -1) return [hostShorthand()];
  const values = argv
    .slice(index + 1)
    .flatMap((value) => value.split(","))
    .filter(Boolean);
  if (values.length === 0) throw new Error("--target needs a value");
  if (values.includes("all")) return Object.keys(TARGETS);
  for (const value of values) {
    if (!TARGETS[value]) {
      throw new Error("Unknown target " + value + " (expected " + Object.keys(TARGETS).join("|") + "|all)");
    }
  }
  return values;
}

export function targetTriple(shorthand) {
  const spec = TARGETS[shorthand];
  if (!spec) throw new Error("Unknown target " + shorthand);
  return spec.triple;
}

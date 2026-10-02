#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const variant = process.argv[2];

const variants = {
  client: {
    apk: "mangayomu-client.apk",
    applicationId: "com.mangayomu.app.client",
    component: "com.mangayomu.app.client/com.mangayomu.app.MainActivity"
  },
  withServer: {
    apk: "mangayomu-with-server.apk",
    applicationId: "com.mangayomu.app.server",
    component: "com.mangayomu.app.server/com.mangayomu.app.MainActivity"
  }
};

if (!variants[variant]) {
  throw new Error("Usage: node scripts/install-android.mjs <client|withServer>");
}

function runningEmulator() {
  const output = execFileSync("adb", ["devices"], { encoding: "utf8" });
  return output
    .split("\n")
    .slice(1)
    .map((line) => line.trim().split(/\s+/))
    .find(([serial, state]) => serial.startsWith("emulator-") && state === "device")?.[0] || null;
}

const apk = path.join(root, "builds", variants[variant].apk);
if (!fs.existsSync(apk)) throw new Error("APK not found: " + apk);

const emulator = runningEmulator();
if (!emulator) {
  console.log("No running Android emulator — APK is ready at " + apk);
  process.exit(0);
}

// Node owns a fixed loopback port. Stop an old process before replacing its
// APK so a stale Node runtime cannot keep :4567 bound during relaunch.
execFileSync("adb", ["-s", emulator, "shell", "am", "force-stop", variants[variant].applicationId], { stdio: "inherit" });
if (variant === "withServer") {
  // Migration convenience: the renamed predecessor used the same fixed port.
  execFileSync("adb", ["-s", emulator, "shell", "am", "force-stop", "com.mangadeno.app"], { stdio: "inherit" });
}
execFileSync("adb", ["-s", emulator, "install", "-r", apk], { stdio: "inherit" });
execFileSync("adb", ["-s", emulator, "shell", "am", "start", "-n", variants[variant].component], { stdio: "inherit" });
console.log("Installed and launched " + variant + " on " + emulator);

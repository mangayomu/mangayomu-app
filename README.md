# MangaYomu

MangaYomu is a manga reader built as a web application, a Node.js server, and an Android app. It supports server-backed manga sources through installable extensions while keeping the reader and local library available in the browser and on Android.

> **Development status:** MangaYomu is under active development. Server-backed browsing, authentication, favorites, reading progress, PDF chapters, backup import, account sync, and extension management are implemented.

## Features

- Browse manga catalogs and search through enabled server extensions.
- View manga details, chapters, metadata, covers, and available languages.
- Read image-based chapters with:
  - vertical scrolling;
  - left-to-right and right-to-left pagination;
  - panel-by-panel reading;
  - zoom and touch/mouse gestures.
- Read PDF chapters with the bundled PDF.js viewer, paginated or vertical modes, zoom, progress tracking, and browser/native fallbacks.
- Detect manga panels and speech balloons locally in the browser for the experimental panel-reading workflow.
- Save favorites and reading progress locally or to a connected MangaYomu server.
- Use separate client accounts stored only in the current browser/Android installation or server accounts stored by the connected server.
- Import Tachiyomi/Mihon backup files (`.proto`, `.proto.gz`, and `.tachibk`).
- Install, update, enable, disable, and remove source extensions.
- Run as a browser application or as two Android variants:
  - a client-only APK;
  - an APK with an embedded Node.js server.

## Architecture

```text
client/          Vite web client and Android WebView UI
server/          Desktop Node.js server entry point
server-android/  Embedded Android server entry point
packages/        Shared core, database, protocol, import, OCR, and extension packages
android/         Capacitor Android project
scripts/         Client/server bundling and Android build/install scripts
fullfill/        Local verification scripts and media (not tracked)
docs/            Architecture notes and review documents
```

The client is implemented with [TinyBubble](https://github.com/antocorr/tinybubble) and uses Vite. The server is an Express application created by `@mangayomu/server-core`. Shared packages expose account, library, database, protocol, backup-import, panel detection, and OCR functionality.

### Storage

- **Browser/client:** SQLite data is persisted in the browser through IndexedDB and used for local accounts, cached manga data, favorites, and reading progress.
- **Desktop server:** SQLite uses `better-sqlite3` when available.
- **Android server:** SQLite uses the `sql.js` WebAssembly driver because native `better-sqlite3` addons are not used in the embedded runtime.
- **Server extensions:** Installed packages and per-user extension configuration are stored in the server's configurable extensions home.

## Requirements

- Node.js with npm workspaces support (Node.js 20+ recommended).
- Network access to GitHub while installing: TinyBubble is installed from a Git branch (see below).
- For Android builds:
  - Java 21;
  - Android SDK and platform tools;
  - Android SDK Platform 36;
  - CMake 3.22.1;
  - an Android emulator or device when using the install scripts.

### TinyBubble dependency

The client uses TinyBubble from the `edge` branch of <https://github.com/antocorr/tinybubble>, so it always builds against the current framework sources instead of a local checkout:

```json
"tinybubble": "git+https://github.com/antocorr/tinybubble.git#edge",
"bubble-translate": "file:../node_modules/tinybubble/plugins/bubble-translate"
```

The plugin has no separate release, so it is installed from inside the TinyBubble package that npm has just fetched (upstream documents the same two-step install). The explicit `git+https` URL keeps the install key-free: npm resolves Git dependencies over HTTPS even though `package-lock.json` records the canonical `git+ssh` form. The lock pins the exact commit, so `npm ci` is reproducible while `npm install` follows the branch; run `npm update tinybubble` to pick up new commits.

## Getting started

```bash
npm install
npm run dev
```

The development command starts both processes:

- Vite client: <http://localhost:8910>
- API server: port `4567` by default

If port `4567` is already in use and `PORT` was not set explicitly, the development server finds the next available port and writes its runtime configuration to `client/public/mangayomu-runtime.json`. The client reads this file automatically.

Open <http://localhost:8910> in a browser, then connect to the running MangaYomu server and create or use a server account to browse enabled sources.

## Production-like local server

Build the client and serve it from the Node.js server:

```bash
npm run serve
```

The generated client is placed in `client/dist`. The server serves the application and API on port `4567` by default.

## Available commands

| Command | Description |
| --- | --- |
| `npm run dev` | Start the Vite client and development API server together. |
| `npm run dev:client` | Start only Vite. |
| `npm run dev:server` | Start only the development API server. |
| `npm run serve` | Build the client and serve it from the Node.js server. |
| `npm run build:client` | Create the Vite production build in `client/dist`. |
| `npm run build:server` | Build the server bundle used by Android packaging. |
| `npm run typecheck` | Run the TypeScript compiler without emitting files. |
| `npm run build:android` | Build the client-only Android debug APK. |
| `npm run build:android-with-server` | Build the Android debug APK with an embedded server. |
| `npm run install:android` | Build and install the client-only APK on a running emulator. |
| `npm run install:android-with-server` | Build and install the embedded-server APK on a running emulator. |
| `npm run build:tauri` | Build the desktop app (macOS `.app` and disk image; Windows installer on Windows). |
| `npm run release -- --tag vX.Y.Z` | Build every installer and publish them as assets of a GitHub Release. |

Behavior-level checks are kept under `fullfill/`, which is local scratch: it holds generated scripts and media and is not part of the repository.

## Android

Build both APK variants from the repository root:

```bash
# Client-only variant
npm run build:android

# Variant with an embedded Node.js server
npm run build:android-with-server
```

The APKs are copied to:

```text
builds/mangayomu-client.apk
builds/mangayomu-with-server.apk
```

If an emulator is already running, install and launch a variant with:

```bash
npm run install:android
# or
npm run install:android-with-server
```

The embedded server uses port `4567` and stores its database in the app-private `mangayomu-data` directory by default.

## Releases

Installers are **never committed**. `builds/` is ignored and every published file is an asset of a GitHub Release, which keeps the repository small and gives each download one permanent address:

```text
https://github.com/mangayomu/mangayomu-app/releases/latest/download/<asset>
```

| Asset | Contents |
| --- | --- |
| `mangayomu-with-server.apk` | Android app with the embedded Node.js server. |
| `mangayomu-client.apk` | Android client only; it needs a server on the same network. |
| `mangayomu-macos-arm64.dmg` | macOS app for Apple silicon, server included. |
| `build-info.json` | Build dates and sizes the server reports when it offers the APKs. |
| `SHA256SUMS` | Checksums for the files above. |

Create a release with:

```bash
npm run release -- --tag v0.1.0                 # client, both APKs, macOS disk image
npm run release -- --tag v0.1.0 --only=android   # Android assets only
npm run release -- --tag v0.2.0 --skip-build     # upload what is already in builds/
npm run release -- --tag v0.2.0 --dry-run        # build and print the plan, upload nothing
```

The command needs the `gh` CLI authenticated against an account that can publish releases, and it refuses to run on a working tree with uncommitted changes unless `--allow-dirty` is passed. Re-running it for an existing tag replaces the assets (`--clobber`) without changing the download URLs.

A server instance that never built the app fetches `build-info.json` from that address and redirects `/api/builds/apk` to the matching asset. Point it elsewhere with `MANGAYOMU_BUILDS_URL` or Settings → Advanced (Android builds → Published builds URL).

## Extensions

MangaYomu does not bundle individual manga source implementations into the host application. Sources are installed as extension packages at runtime.

An extension package has this general layout:

```text
extension.json
server/
client/
```

A package may provide:

- server-side manga sources and authenticated request handlers;
- client-side settings panels;
- client-side Browse contributions;
- extension-owned per-user configuration.

Installation is server-wide, while source activation is per-user. Administrators can manage extension repositories, upload ZIP packages, install packages from URLs, configure the extensions home, configure a trusted registry, and uninstall packages. Authenticated users can install packages exposed by configured repositories and enable sources for their own account.

The default official repository is:

<https://mangayomu.github.io/mangayomu-official-extensions/repository.json>

The official source implementations are maintained separately from this repository.

For development-only local extension URLs, explicitly opt in with:

```bash
MANGAYOMU_ALLOW_LOCAL_EXTENSION_URLS=1 npm run dev:server
```

Do not enable this option for an exposed production server.

## Configuration

| Environment variable | Purpose | Default |
| --- | --- | --- |
| `PORT` | Server listening port. | `4567` |
| `DB_PATH` | SQLite database path. | `./mangayomu.db` for the desktop server |
| `DB_DRIVER` | Force a database driver, for example `sqljs`. | Automatic selection |
| `MANGAYOMU_OFFICIAL_REPOSITORY_URL` | Override the seeded official extension repository. | Official MangaYomu repository URL |
| `MANGAYOMU_ALLOW_LOCAL_EXTENSION_URLS` | Allow local HTTP extension URLs during development. | Disabled |
| `MANGAYOMU_BUILDS_URL` | Where the published installers and `build-info.json` live. | The latest MangaYomu GitHub Release |

The first server account created is assigned the administrator role.

## Importing backups

Use the **Import** view to load Tachiyomi/Mihon backups. The backup is decoded on the current device first. The normalized data can then be saved to the local client library or sent to an authenticated remote server.

## Development notes

- The client uses hash-based routing so it works from the Vite dev server, the Node static server, and Capacitor WebViews.
- Source requests are executed by the selected server extension. Direct client mode does not execute installed server sources.
- Image and PDF resources from server sources are served through authenticated server routes when required.
- Client-facing text is in English and is wired through the `bubble-translate` integration.

# Extensions decoupling plan

## Goal

MangaYomu installs generic extension packages at runtime. The app repository contains no MangaDex, MangaWorld, or other extension implementation.

## Package contract

A package ZIP has an `extension.json` manifest and optional runtime targets:

```text
extension.json
server/
client/
```

A package can contribute sources, themes, client utilities, and future contribution types. The first delivery executes only server-side source contributions. Client targets are retained but not loaded.

## Repositories

`/Users/antonio/Documents/htdocs/mangayomu-extensions` is the separate Git repository for official extension sources and its repository catalog. It is distinct from installed runtime files.

A trusted registry links to trusted extension repositories and direct packages. A repository lists one or more package ZIP releases.

## Installation and activation

Installing a package is global to a server. Activating a source is per user.

- The first server user is an admin.
- Admins may upload ZIPs and install arbitrary package or repository URLs.
- Any authenticated user may install or update packages offered through the configured trusted registry.
- Reinstalling an installed package version is a no-op.
- A package does not activate any source automatically.

## Storage

The server home is an admin-configurable UI setting stored in the server database. Installed packages live under:

```text
<MANGAYOMU_HOME>/extensions/<extension-id>/
```

Changing the home migrates installed packages into staging, validates them, updates the setting only after success, then removes the old copies.

Android uses the same model with an app-private default home. Runtime extensions remain outside the copied `nodejs-project` assets.

## Initial scope

The desktop server and Android embedded server load installed server extensions. Direct client mode does not execute or install extensions in this milestone.

The app removes all static source imports, hard-coded source fallbacks, package dependencies, and Android-bundled source code.

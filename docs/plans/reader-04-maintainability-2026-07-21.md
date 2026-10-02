# Plan 04 — Reader maintainability

**Findings:** 22, 23, 24, 25, 26, 27, 28.

## Prerequisite

Plans 01–03 pass and the Reader-level fullfill exists. This plan must not change observable playback behaviour.

## Step 1: remove proved dead indirection

Remove only items that remain unnecessary after prior plans:

- `_clearPreload(releaseImages)` if it still has one call site and only forwards to the preloader.
- `detectedPanel` followed immediately by `sourcePanel = detectedPanel`.
- `_pausePlayback()` only if direct playback calls are consolidated or the method gains a real Reader-level semantic purpose.

Do not remove a method simply because it is short. Keep grouping methods that express a real user intent.

## Step 2: document Reader contracts

Add English JSDoc to methods that coordinate structured state or async lifecycle, including:

- `_panelPreparationInput()`;
- `_prepareCurrentPagePanels()`;
- `_goToPage()`;
- playback transition methods introduced by Plan 01;
- invalidation methods introduced by Plan 02.

Document inputs, state transition, cancellation rule, and return value. Do not add comments that restate obvious assignments.

## Step 3: clarify navigation names

`nextPage` and `prevPage` are panel-aware. `goToNextPage` and `goToPreviousPage` intentionally skip panel navigation. Rename the latter pair to make that distinction explicit, for example `skipToNextPage()` and `skipToPreviousPage()`, then update their UI call sites.

Do this only once existing callers and user-visible intent are confirmed. It is a naming improvement, not a behaviour change.

## Step 4: extract only stable responsibilities

`Reader.bub.js` remains large. Extract in this order only if the prior contracts are stable:

1. gesture controller: pointer, wheel, pinch, tap classification, and listener cleanup;
2. viewport controller: zoom, layout, centring, and resize coalescing;
3. development bridge, if it still adds material weight to Reader.

Before creating any new file, propose its path, exported API, state ownership, and cleanup lifecycle. Do not extract a controller merely to reduce line count.

## Step 5: apply the corrected style finding

Do not perform a broad `var` to `const` conversion as a response to finding 28. The reported widespread `var`/`let`/`const` mix is not present. Instead:

- follow the surrounding local style in touched code;
- keep comments in English;
- avoid chained optional access;
- make teardown order explicit and test it through Plan 02’s disposal scenario.

## Acceptance checks

- All prior fullfills remain green without changed behaviour assertions.
- No removed wrapper had more than one meaningful responsibility.
- Renamed navigation methods make panel-aware versus page-skip intent clear at every call site.
- Any extracted controller has one responsibility and detaches its listeners in `destroy()`.

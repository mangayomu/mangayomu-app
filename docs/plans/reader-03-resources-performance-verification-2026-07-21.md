# Plan 03 — Resource limits, performance, and verification

**Findings:** 9, 10, 11, 12, 14, 16, 17, 18, 19, 20, 21.

## Prerequisite

Plans 01 and 02 pass. Do not optimise unstable lifecycle code.

## Step 1: Reader-level orchestration fullfill

Create `fullfill/reader-playback-orchestration.mjs`. Use controllable fakes for camera, clock, router, deferred analysis, and requestAnimationFrame. Test collaboration, not individual private helpers.

Required cases:

| Case | Expected result |
| --- | --- |
| Manual camera action during tween | Playback pauses and no location hold is scheduled. |
| Resize during tween | Instant reframe then exactly one hold. |
| Long reading pan | Reveal survives lead to travel and completes once. |
| Rapid chapter requests | Only the newest request navigates. |
| `panelSecondPass` changes during detection | Old result is neither active nor cached. |
| Destroy during analysis | No cache or UI publication after resolution. |

## Step 2: cancel stale preload and OCR work

In `ReaderImagePreloader`, `clear(true)` must release actual pending loads, not only map bookkeeping:

```js
image.onload = null;
image.onerror = null;
image.src = "";
this._requests.delete(url);
```

Apply this only to pending images. Retain the browser cache benefit without retaining handlers or Reader callbacks.

`paddle-tiny-ocr.js` has a serial `predictionQueue`. Add a session generation or cancellation predicate before inference begins so old look-ahead pages do not delay the current page. Do not dispose the shared OCR model; its app-session reuse is intentional.

## Step 3: bound cache memory

Keep a window around the current page, initially current ±2. Evict completed panel/OCR/prepared entries outside it. Never evict a pending entry. Combine this with Plan 02’s disposal generation so a completed old job cannot restore evicted data.

## Step 4: make layout work proportional to frames, not events

- Coalesce resize to one animation frame before running layout, reschedule, and reframe.
- Coalesce vertical scroll to one animation frame before measuring image rectangles.
- In `PanelRevealController`, cache static source box data. During camera frames, update only overlay/container geometry when reveal state and sources did not change.
- Cache the Reader surface after `init()` and release the reference in `destroy()`. Do not cache remountable paged images without an explicit invalidation path.

## Step 5: consistency and diagnostics

### Ready image guard

Create one Reader helper used by preparation, reschedule, and precalculation:

```js
_readyPagedImage() {
  const image = this._getPagedImage();
  return image && image.complete && image.naturalWidth ? image : null;
}
```

Use the project’s supported JavaScript syntax. This example expresses the contract; adapt it if local style rules reject the exact expression.

### Precalculation diagnostic

Keep prefetch non-fatal, but replace the silent catch with a deduplicated DEV or `analysisDebug` warning. Do not show a user-facing error for a speculative preload failure.

### Progress saves

Serialize/debounce progress updates with last-write-wins semantics. Flush the newest payload in `destroy()`. A slower request for an older page must not overwrite the current page.

### Initial chapter request

Start `manga.chapters(source, mangaId)` beside detail/pages during Reader initialisation. Keep its failure non-blocking, but log a DEV diagnostic instead of silently disabling chapter navigation.

## Acceptance checks

- With unresolved fake images, page rapidly then destroy: old handlers are detached and active requests stay within the window.
- With deferred OCR, navigate away: old work does not run inference before the current page when it can be skipped.
- Traverse many pages: cache size remains bounded.
- Fire many resize/scroll events in one frame: layout/measurement executes once.
- A camera tween does not rebuild static reveal source boxes every frame.
- Resolve progress saves out of order: the final saved page is the latest page.

Run:

```sh
node fullfill/reader-image-preload.mjs
node fullfill/panel-reveal-controller.mjs
node fullfill/reader-playback-orchestration.mjs
```

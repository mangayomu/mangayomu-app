# Mega review — `Reader.bub.js`

**Date:** 2026-07-21  
**Scope:** read-only review of `client/src/views/Reader.bub.js` and the critical reader modules it coordinates: playback, camera, reveal, OCR/panel analysis, preloading and the TinyBubble stage.

No production source was changed for this review.

## Executive summary

The rewrite is headed in the right direction. The view delegates meaningful work to `PanelReaderController`, `PanelCameraExecutor`, `PanelRevealController`, `ReaderPlaybackController`, `ReaderImagePreloader` and `ScreenAwakeController`. Page-preparation generations reject stale UI results, teardown is generally disciplined, and OCR failures fall back to geometry instead of breaking Panels mode.

The main unresolved problem is orchestration: camera, playback clock, reveal and manual input each own a different cancellation path. That produces invalid states such as autoplay stuck in `preparing` without either a camera animation or a timer. Fix that lifecycle before further structural extraction.

## Priority P0 — correctness blockers

### 1. Cancelling a camera transition can strand autoplay in `preparing`

**Evidence:**

- `client/src/views/Reader.bub.js:472-477, 490-496, 1428-1452, 1489-1517`
- `client/src/panel-camera-executor.js:27-71`
- `client/src/reader-playback-controller.js:94-98`

**Scenario:** an autoplay location enters `preparing` in `_framePanel()` and starts the camera tween. Ctrl-wheel, pointer input, pinch, zoom buttons, reset zoom, or resize calls `PanelCameraExecutor.cancel()`. `cancel()` only cancels the animation frame; it does not call the `complete` callback. `_continueAfterPanelFrame()` therefore never schedules the hold timer. Playback remains `preparing`, with no camera work and no clock. `ScreenAwakeController` also remains active because `preparing` is considered active.

**Smallest safe fix:** define one Reader-owned manual-interruption path that pauses or stops playback *before* cancelling the camera. If resize must preserve autoplay, give camera cancellation an explicit completion/interruption result and deterministically reframe or schedule the active location.

**Required regression:** interrupt an autoplay camera transition and assert that playback cannot remain `preparing` unless a camera or timer is pending.

### 2. `reading-pan` cancels its progressive reveal midway

**Evidence:**

- `client/src/views/Reader.bub.js:1202-1238, 1258-1325`
- `client/src/reader-playback-controller.js:94-98, 172-185`
- `client/src/panel-reveal-controller.js:84-100, 192-202`
- `client/src/panel-playback-scheduler.js:45-65`

**Scenario:** the scheduler emits a short `reading-pan-lead` hold with a reveal duration spanning the full reading beat. Advancing to `reading-pan-travel` calls `_framePanel()`, which resets the playback clock. Reader maps that reset to `PanelRevealController.cancelSchedule()`. The active reveal timers and WAAPI fades are cancelled; the travel location owns no reveal units, so the reveal does not continue.

**Smallest safe fix:** model lead and travel as one logical playback/reveal beat, or preserve the reveal when the next camera sub-location continues the same reveal unit.

**Required regression:** use a long horizontal balloon and assert that its reveal remains active from lead through travel.

### 3. Stale chapter navigation can overwrite a newer user choice

**Evidence:** `client/src/views/Reader.bub.js:1525-1555`.

**Scenario:** the user taps Next Chapter, then immediately taps Previous Chapter or Back. Both `_jumpChapter()` calls await `manga.chapters()` without an operation token or a post-await `_destroyed` guard. An older request resolving last can navigate after the newer command or after this Reader was destroyed.

**Smallest safe fix:** maintain a monotonic chapter-navigation token; capture it before awaiting and ignore results unless it is still current and the Reader is alive. Invalidate it in `destroy()`.

### 4. Second-pass panel detection races with invalidation

**Evidence:**

- trigger: `client/src/views/Reader.bub.js:1152-1156`
- cache implementation: `client/src/panel-page-analysis.js:53-83, 159-165`
- composition cache: `client/src/panel-reader-controller.js:42-70`

**Scenario:** toggle `panelSecondPass` while the first detection is pending. `clearPage()` deletes map entries but cannot cancel or invalidate the old Promise. The old request can subsequently write `_panels` and delete a request entry belonging to a new request, leaving the page composed from old detection options.

**Smallest safe fix:** version requests per page, or key cache entries by asset and normalized detection options. Completion and `finally` must only write/delete if they still own the current version.

### 5. `panelSecondPass` does not invalidate pages already precomputed

**Evidence:**

- speculative precompute: `client/src/views/Reader.bub.js:182-185, 1013-1019`
- current-page-only invalidation: `client/src/views/Reader.bub.js:1152-1156`
- option-insensitive cache hit: `client/src/panel-page-analysis.js:53-55`

**Scenario:** page N+1 is precomputed with the old setting. Changing the preference only clears the current page. On N+1, `getPanels()` returns the old cached result before reading the new options.

**Smallest safe fix:** include normalized detection options in the cache key, or clear every prepared/detected page when `panelSecondPass` changes. A keyed cache retains useful work safely.

### 6. The scheduler fullfill is currently red

**Evidence:** `fullfill/panel-playback-scheduler.mjs:48`.

**Reproduced command:**

```text
node fullfill/panel-playback-scheduler.mjs
```

**Result:** expected `['entry', 'reading']`; actual `['reading', 'reading-pan']`.

The current Director appears to intentionally create a same-zoom horizontal pan. The test and behavior need a single agreed contract. If the pan is intended, update the fullfill to verify the fixed composition zoom and lead/travel reveal ownership. If it is not intended, change the planner instead.

## Priority P1 — stability and performance

### Speculative OCR jobs are not cancellable

**Evidence:** `Reader.bub.js:182-185, 1013-1019`, `paddle-tiny-ocr.js`.

The preloader starts full analysis, including OCR. The OCR module serializes jobs in a shared queue. Reader generations stop obsolete results from publishing, but stale queued inference still consumes CPU after rapid navigation or exit.

**Fix:** pass a session generation or `AbortSignal` into the OCR scheduler. Drop obsolete queued jobs before inference; keep only the current page and the bounded look-ahead set.

### Reveal overlays are rebuilt every camera frame

**Evidence:** `Reader.bub.js:1314-1325, 1372-1404`; `panel-reveal-controller.js:260-299`.

Every camera frame calls `_setZoom()`, which refreshes the reveal layout. This recreates all box objects and CSS strings and publishes a new reactive array, producing allocation and reconciliation while the image should animate smoothly.

**Fix:** cache projected per-box objects. During zoom/camera motion, update only the overlay container geometry. Rebuild box data only when sources, revealed state or timing-debug state changes.

### Vertical scrolling is O(N) layout work per scroll event

**Evidence:** `Reader.bub.js:1341-1350`.

`_trackScroll()` queries every reader-page image and calls `getBoundingClientRect()` for each native scroll event.

**Fix:** first coalesce to one `requestAnimationFrame` per frame. Prefer `IntersectionObserver` to track the active page without scanning every page.

### Per-chapter analysis cache is unbounded

Panel/OCR data, reading groups, camera plans and schedules remain in `PanelPageAnalysisService` and `PanelReaderController` until Reader destruction.

**Fix:** retain a small current/look-behind/look-ahead window with LRU eviction. Never evict pending work.

### OCR-unavailable state is forgotten after page navigation

**Evidence:** `Reader.bub.js:757, 892-900, 1034-1040`.

`_revealUnavailablePages.clear()` causes a known OCR-failed page to attempt OCR again when revisited.

**Fix:** keep unavailability per page asset for the Reader session. Clear only for an explicit Retry or a preference/input change that makes a retry meaningful.

### Preference changes can be lost while analysis is pending

**Evidence:** `Reader.bub.js:1000-1011, 1152-1162`.

`reschedulePage()` can return `null` before cached panel/page data exists. That result is ignored, and the in-flight preparation completes with old preferences.

**Fix:** if rescheduling is unavailable, increment the preparation generation and restart preparation. A preference version in the preparation token makes the invariant explicit.

### Reader-owned animation frames may run after destroy

**Evidence:** unguarded frames at `Reader.bub.js:439-449, 775-780, 1513-1516`.

**Fix:** guard every scheduled callback with `_destroyed`, or centralize/cancel Reader-owned rAF ids in `destroy()`.

### Resize performs repeated geometry and camera work

**Evidence:** `Reader.bub.js:1428-1453`.

**Fix:** coalesce with a single rAF or trailing debounce before layout refresh, reschedule and camera reposition.

## Favourite-coworker review

### Cleanup after P0/P1

- `Reader.bub.js` remains a 1,563-line view responsible for route orchestration, raw pointer/wheel/pinch handling, zoom math, playback/reveal coordination and the DEV bridge. The extracted controllers are a good base. After lifecycle correctness is fixed, split gesture handling and viewport/zoom first.
- `_pausePlayback()` (`1179`) and `_clearPreload()` (`862-864`) are one-to-one wrappers with no additional meaning. Inline them or make one the only meaningful public operation.
- `detectedPanel` followed immediately by `sourcePanel = detectedPanel` (`1287-1290`) is unnecessary indirection.
- Complex methods such as `_goToPage`, `_schedulePlayback`, `_panelPreparationInput` and `_prepareCurrentPagePanels` need JSDoc contracts. This is a direct local rule for JavaScript files.
- `manga.chapters()` failure is silently swallowed around line 319. A localStorage fallback may intentionally be quiet, but a navigation capability silently disappearing needs at least a DEV diagnostic.
- `_surface()` repeatedly calls `querySelector()` in high-frequency gesture paths. Cache it in `init()` or at least once per handler.

### Rules and design choices already respected

- No `??` operators.
- No chained optional-chaining expressions.
- TinyBubble usage is sound: one template root, component registration and props/emits wiring are consistent.
- The page-preparation generation checks correctly prevent stale OCR/detection results from publishing into a different current page.
- `destroy()` removes listeners and delegates camera/playback/reveal/analysis resource cleanup to the relevant owners.
- OCR failure falls back to geometry, which is the correct product behavior.

## Suggested implementation order

1. Establish a shared playback-beat lifecycle and fix manual camera interruption.
2. Preserve reveal through a `reading-pan` sub-location.
3. Add tokens for chapter navigation and panel detection invalidation.
4. Update the scheduler fullfill to the agreed Director contract and add Reader orchestration regressions.
5. Add bounded/cancellable preload analysis, then reduce per-frame reveal and scroll work.
6. Split gesture/viewport responsibilities only after the lifecycle contracts are stable.

## Validation gap

The controller-level fullfill coverage is useful, but there is no focused Reader orchestration harness that covers camera cancellation, chapter-route races, pending preference changes and detection invalidation. Those are the regressions to add first.

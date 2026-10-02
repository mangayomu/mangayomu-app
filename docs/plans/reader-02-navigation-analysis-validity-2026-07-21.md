# Plan 02 — Navigation, preferences, and analysis validity

**Findings:** 4, 5, 6, 7, 8, 13, 15.

## Goal

Every asynchronous result must have an owner. When a newer user action, changed detection option, or disposal supersedes it, the old result may finish but cannot navigate, write cache, or publish Reader state.

## Step 1: chapter navigation generation

In `Reader.bub.js`, create `_chapterNavigationGeneration` in `init()`. Increment it before each `_jumpChapter()` request and in `destroy()`.

```js
async _jumpChapter(dir) {
  const generation = ++this._chapterNavigationGeneration;
  const chapters = await manga.chapters(this.data.source.value, this.data.mangaId.value);
  if (this._destroyed || generation !== this._chapterNavigationGeneration) return;

  const index = chapters.findIndex((chapter) => chapter.id === this.data.chapterId.value);
  const chapter = chapters[index - dir];
  router.navigate(chapter
    ? "/reader/" + this.data.source.value + "/" + encodeURIComponent(this.data.mangaId.value) + "/" + chapter.id + "/0"
    : "/manga/" + this.data.source.value + "/" + encodeURIComponent(this.data.mangaId.value)
  );
}
```

Keep the existing error log. An old request resolving later must do nothing.

## Step 2: version detection requests

`PanelPageAnalysisService` keys `_panels` and `_panelRequests` only by page index. `clearPage()` cannot stop an older request from setting old panels or deleting a newer request entry.

Create a per-page version. A request may mutate a map only when its version is current. Check this rule in success, failure, and `finally`.

```js
const version = (this._pageVersions.get(pageIndex) || 0) + 1;
this._pageVersions.set(pageIndex, version);

const request = this._detectPanels(image, detectionOptions);
this._panelRequests.set(pageIndex, { version, request });

const boxes = await request;
if (this._pageVersions.get(pageIndex) !== version) return boxes;
this._panels.set(pageIndex, boxes);
```

Use the actual detector operation rather than adding an unnecessary generic abstraction. The important rule is ownership, not the exact helper shape.

## Step 3: invalidate all option-dependent panel data

`panelSecondPass` affects detected geometry. It must invalidate current and preloaded pages, not only the visible page.

Start with the simplest correct policy: clear all panel-derived/prepared cache in `PanelReaderController` when this preference changes. Keep OCR base analysis only if it is truly option-independent. Optimise to an options-based cache key later, after tests pass.

## Step 4: preferences changed while preparation is pending

`_rescheduleCurrentPagePanels()` currently does nothing when page data is not cached yet. It must return whether it rescheduled. If false while preparation is pending, increment the preparation generation and restart with the latest preference snapshot.

```js
const rescheduled = this._rescheduleCurrentPagePanels();
if (!rescheduled && this._panelReader.isPending(this.data.currentPage.value)) {
  this._restartCurrentPagePreparation();
}
```

The exact restart must preserve the chosen playback policy. Do not let an old input finish and make the UI look configured for new preferences.

## Step 5: retain OCR-unavailable state per page

Do not clear `_revealUnavailablePages` on every `_goToPage()`. Preserve it for the session. Remove an entry only on explicit Retry, a meaningful OCR/reveal preference change, or Reader destruction.

## Step 6: disposal and Reader-owned frames

Add disposal generations to `PanelPageAnalysisService` and `PanelReaderController`. Capture before awaited work; after await, return without cache mutation when disposal changed.

Track Reader-owned `requestAnimationFrame` callbacks created by `setMode`, `_goToPage`, and `resetZoom`. Cancel them in `destroy()` or guard every callback with `_destroyed`. Do not duplicate guards where the callback is already protected.

## Acceptance checks

- Resolve two chapter requests out of order: only the newest one navigates.
- Change `panelSecondPass` while detection is deferred: old result never reaches cache.
- Preload N+1 under one second-pass setting, change it, then navigate to N+1: detection uses the new setting.
- Change a timing/camera preference while preparation is pending: completed locations reflect the new preference.
- Return to an OCR-failed page: no OCR is retried until Retry.
- Destroy with deferred detection/OCR and pending Reader rAF: no controller cache or DOM work is restored afterward.

Run:

```sh
node fullfill/panel-page-analysis.mjs
node fullfill/panel-reader-controller.mjs
```

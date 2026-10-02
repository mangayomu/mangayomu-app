# Plan 01 — Playback, camera, and reveal

**Findings:** 1, 2, 3.

## Goal

Autoplay must have a complete lifecycle when the user interacts, when the viewport resizes, and when a long paragraph requires a reading pan.

## Invariants

- `preparing` has an active camera transition or immediately schedules the location.
- A manual camera action pauses playback before camera cancellation.
- A simple pointer-down does not cancel autoplay.
- Resize schedules one continuation only when it replaced a transition in `preparing`.
- A `reading-pan-lead` and its `reading-pan-travel` share one reveal lifetime.

## Step 1: repair the scheduler contract

`fullfill/panel-playback-scheduler.mjs` expects the old long-paragraph plan. Update it before changing runtime code:

```js
assert.deepEqual(
  schedule.locations.map((location) => location.kind),
  ["reading", "reading-pan"]
);
assert.equal(schedule.locations[0].movement.kind, "reading-pan-lead");
assert.equal(schedule.locations[1].movement.kind, "reading-pan-travel");
```

Add assertions for one shared reveal beat after Step 3.

## Step 2: distinguish a touch from manual camera control

In `Reader.bub.js`, remove camera cancellation from `_onPointerDown()`. Invoke a semantic helper only when the user actually changes the camera:

- Ctrl-wheel: immediately.
- Zoom buttons and reset zoom: immediately.
- Drag: on the first movement beyond `TAP_THRESHOLD`.
- Pinch: when the second pointer starts the pinch.

```js
_pausePlaybackForManualCameraControl() {
  this._playback.pause();
  this._panelCamera.cancel();
  this._clearSpotlightOnInteraction();
  this._panelFrameZoom = false;
}
```

This is not an empty wrapper: it represents one user intent that changes playback, camera, spotlight, and zoom persistence state. Do not call it for an ordinary tap; `_doTapAction()` keeps ownership of tap navigation and resume.

## Step 3: preserve a beat across resize

`_onReaderResize()` replaces the active camera tween with an instant execute. Capture the playback generation and whether state is `preparing` before replacement. Supply `complete` only for that case.

```js
const generation = this._playback.generation;
const wasPreparing = this._playback.state === PLAYBACK_STATES.PREPARING;

this._panelCamera.execute({
  // Keep the existing geometry input.
  instant: true,
  complete: wasPreparing
    ? () => {
      if (!this._playback.isCurrent(generation)) return;
      if (this.data.panelIndex.value !== index) return;
      this._continueAfterPanelFrame(location, index);
    }
    : undefined,
});
```

Never call `_continueAfterPanelFrame()` while an existing hold is already `playing`; that duplicates location clocks.

## Step 4: model the reading pan as one reveal beat

Give the lead and travel locations the same explicit `revealBeatId`. Do not copy reveal units to travel to hide the failure; that would create a second reveal.

```js
const revealBeatId = "panel-" + panelIndex + "-pan-" + groupIndex;
lead.revealBeatId = revealBeatId;
travel.revealBeatId = revealBeatId;
```

Add a specifically named playback transition, such as `advanceLocationKeepingReveal()`. It may replace the location clock but must not invalidate the reveal generation or call `cancelSchedule()`. Use it only when adjacent locations have the same non-null `revealBeatId`; retain reset semantics everywhere else.

## Step 5: unexpected zero locations

Director currently produces geometric coverage for no-balloon pages, and panel detection falls back to a whole-page panel. Still make `_prepareCurrentPagePanels()` handle `prepared.locations.length === 0` deliberately:

- show the full page;
- set `panelFramePending` false;
- stop playback if it was awaiting a location;
- emit one DEV warning.

This is a safety policy, not a Director rewrite.

## Acceptance checks

- Ctrl-wheel, drag, pinch, zoom in/out, and reset pause a camera tween.
- Pointer-down and ordinary tap do not pre-emptively pause it.
- Resize during transition creates one hold; resize during hold creates none.
- A long paragraph reveals continuously from lead through travel, pauses/resumes correctly, and reveals each source once.
- Empty locations return to a coherent stopped full-page state.

Run:

```sh
node fullfill/panel-playback-scheduler.mjs
node fullfill/reader-playback-controller.mjs
node fullfill/panel-reveal-controller.mjs
node fullfill/panel-camera-executor.mjs
```

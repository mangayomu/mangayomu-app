export const PLAYBACK_STATES = {
  STOPPED: "stopped",
  PREPARING: "preparing",
  PLAYING: "playing",
  PAUSED: "paused",
};

/** Owns playback state and the cancellable clock for the current location. */
export class ReaderPlaybackController {
  /**
   * @param {{onCancel: (reason:"pause"|"reset") => void, onProgress: (progress: number) => void, onStateChange?: (state: string) => void}} callbacks
   */
  constructor({ onCancel, onProgress, onStateChange = () => {} }) {
    this._onCancel = onCancel;
    this._onProgress = onProgress;
    this._onStateChange = onStateChange;
    this._state = PLAYBACK_STATES.STOPPED;
    this._generation = 0;
    this._timer = null;
    this._progressFrame = null;
    this._startedAt = 0;
    this._duration = 0;
    this._elapsedDuration = 0;
    this._remainingDuration = 0;
    this._progress = 0;
    this._showProgress = false;
    this._onComplete = null;
  }

  get generation() {
    return this._generation;
  }

  get state() {
    return this._state;
  }

  get progress() {
    return this._progress;
  }

  get remainingDuration() {
    return this._remainingDuration;
  }

  isStopped() {
    return this._state === PLAYBACK_STATES.STOPPED;
  }

  isPaused() {
    return this._state === PLAYBACK_STATES.PAUSED;
  }

  canSchedule() {
    return this._state === PLAYBACK_STATES.PREPARING || this._state === PLAYBACK_STATES.PLAYING;
  }

  hasScheduledLocation() {
    return typeof this._onComplete === "function" && this._remainingDuration > 0;
  }

  isCurrent(generation) {
    return generation === this._generation;
  }

  start() {
    if (!this.isStopped()) return false;
    this._cancelClock(true);
    this._setState(PLAYBACK_STATES.PREPARING);
    return true;
  }

  pause() {
    if (this.isStopped() || this.isPaused()) return false;
    if (this._state === PLAYBACK_STATES.PLAYING && this.hasScheduledLocation()) {
      this._captureElapsedTime();
    }
    this._cancelClock(false);
    this._setState(PLAYBACK_STATES.PAUSED);
    this._setProgress(this._progress);
    return true;
  }

  resume() {
    if (!this.isPaused()) return false;
    if (this.hasScheduledLocation()) {
      this._armClock();
    } else {
      this._setState(PLAYBACK_STATES.PREPARING);
    }
    return true;
  }

  enterLocation() {
    if (this.isStopped()) return false;
    this._cancelClock(true);
    if (!this.isPaused()) this._setState(PLAYBACK_STATES.PREPARING);
    return true;
  }

  /**
   * Replaces the location clock without cancelling the reveal schedule.
   * Use when adjacent locations share the same revealBeatId so the reveal
   * animation can continue uninterrupted across lead → travel.
   */
  advanceLocationKeepingReveal() {
    if (this.isStopped()) return false;
    this._generation++;
    if (this._timer) clearTimeout(this._timer);
    if (this._progressFrame) cancelAnimationFrame(this._progressFrame);
    this._timer = null;
    this._progressFrame = null;
    this._duration = 0;
    this._elapsedDuration = 0;
    this._remainingDuration = 0;
    this._showProgress = false;
    this._onComplete = null;
    this._setProgress(0);
    this._setState(PLAYBACK_STATES.PREPARING);
    this._onCancel("preserveReveal");
    return true;
  }

  stop() {
    this._cancelClock(true);
    this._setState(PLAYBACK_STATES.STOPPED);
  }

  /**
   * @param {number} duration
   * @param {boolean} showProgress
   * @param {() => void} onComplete
   */
  schedule(duration, showProgress, onComplete) {
    if (!this.canSchedule()) return false;

    this._duration = Math.max(0, Number(duration) || 0);
    this._elapsedDuration = 0;
    this._remainingDuration = this._duration;
    this._showProgress = showProgress;
    this._onComplete = onComplete;
    this._setProgress(0);
    this._armClock();
    return true;
  }

  _armClock() {
    this._setState(PLAYBACK_STATES.PLAYING);
    const generation = this._generation;
    const startedAt = performance.now();
    this._startedAt = startedAt;

    if (this._showProgress) {
      const paintProgress = (now) => {
        if (!this.isCurrent(generation) || this._state !== PLAYBACK_STATES.PLAYING) return;
        const elapsed = Math.min(this._remainingDuration, Math.max(0, now - startedAt));
        this._setProgress(this._duration > 0
          ? Math.min(100, ((this._elapsedDuration + elapsed) / this._duration) * 100)
          : 100);
        if (this._progress < 100) this._progressFrame = requestAnimationFrame(paintProgress);
      };
      this._progressFrame = requestAnimationFrame(paintProgress);
    }

    this._timer = setTimeout(() => {
      this._timer = null;
      if (!this.isCurrent(generation) || this._state !== PLAYBACK_STATES.PLAYING) return;
      const onComplete = this._onComplete;
      this._elapsedDuration = this._duration;
      this._remainingDuration = 0;
      this._onComplete = null;
      this._setProgress(0);
      onComplete();
    }, this._remainingDuration);
  }

  _captureElapsedTime() {
    const elapsed = Math.min(
      this._remainingDuration,
      Math.max(0, performance.now() - this._startedAt)
    );
    this._elapsedDuration += elapsed;
    this._remainingDuration = Math.max(0, this._duration - this._elapsedDuration);
    if (this._showProgress) {
      this._progress = this._duration > 0
        ? Math.min(100, (this._elapsedDuration / this._duration) * 100)
        : 100;
    }
  }

  /**
   * Cancels the active clock and external work tied to the location.
   * @param {boolean} resetLocation
   */
  _cancelClock(resetLocation) {
    this._generation++;
    if (this._timer) clearTimeout(this._timer);
    if (this._progressFrame) cancelAnimationFrame(this._progressFrame);
    this._timer = null;
    this._progressFrame = null;
    this._onCancel(resetLocation ? "reset" : "pause");
    if (!resetLocation) return;
    this._duration = 0;
    this._elapsedDuration = 0;
    this._remainingDuration = 0;
    this._showProgress = false;
    this._onComplete = null;
    this._setProgress(0);
  }

  _setProgress(progress) {
    this._progress = progress;
    this._onProgress(progress);
  }

  _setState(state) {
    if (this._state === state) return;
    this._state = state;
    this._onStateChange(state);
  }
}

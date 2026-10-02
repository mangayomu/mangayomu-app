import { textReadingMs } from "./panel-playback-scheduler.js";
import { boundsFromPoly, characterCount } from "./panel-page-analysis.js";

const DEFAULT_FADE_MS = 300;
const DEFAULT_FINAL_PAUSE_MS = 800;

/**
 * @param {{mode:string,playbackStopped:boolean,enabled:boolean,unavailable:boolean}} input
 */
export function isPanelRevealRequired(input) {
  return input.mode === "panels"
    && !input.playbackStopped
    && input.enabled
    && !input.unavailable;
}

/** Owns progressive reveal state, timing, animations, and layout projection. */
export class PanelRevealController {
  /**
   * @param {{
   *   onViewModel?:(viewModel:{boxes:Array,overlayStyle:string})=>void,
   *   setTimer?:(callback:()=>void,delay:number)=>ReturnType<typeof setTimeout>,
   *   clearTimer?:(timer:ReturnType<typeof setTimeout>)=>void,
   *   now?:()=>number
   * }} [dependencies]
   */
  constructor(dependencies = {}) {
    this._onViewModel = dependencies.onViewModel || (() => {});
    this._setTimer = dependencies.setTimer || ((callback, delay) => globalThis.setTimeout(callback, delay));
    this._clearTimer = dependencies.clearTimer || ((timer) => globalThis.clearTimeout(timer));
    this._now = dependencies.now || (() => performance.now());
    this._pageIndex = null;
    this._sources = [];
    this._revealedIds = new Set();
    this._timings = new Map();
    this._visitedPanelSources = new Set();
    this._activePanelSource = null;
    this._units = [];
    this._animations = [];
    this._elapsed = 0;
    this._startedAt = 0;
    this._paused = false;
    this._token = 0;
    this._generation = 0;
    this._isCurrent = () => true;
    this._getElements = () => [];
    this._layout = null;
    this._cachedStageKey = null;
    this._cachedSources = null;
    this._cachedScale = null;
    this._cachedOffsetX = null;
    this._cachedOffsetY = null;
  }

  get ready() {
    return this._pageIndex !== null;
  }

  get pageIndex() {
    return this._pageIndex;
  }

  /** @param {number} pageIndex @param {Array} sources */
  activate(pageIndex, sources) {
    this.clear();
    this._pageIndex = pageIndex;
    this._sources = sources.slice();
    this._publish();
  }

  /**
   * Projects source-image reveal geometry into the paged stage.
   * @param {HTMLImageElement|{naturalWidth:number,naturalHeight:number}} image
   * @param {HTMLElement|{clientWidth:number,clientHeight:number}} stage
   * @param {boolean} [showTimingDebug]
   */
  refreshLayout(image, stage, showTimingDebug = false) {
    if (!this.ready || !image || !image.naturalWidth || !stage) return;
    this._layout = { image, stage, showTimingDebug };
    this._publish();
  }

  /**
   * Schedules every unrevealed unit owned by one location.
   * @param {{revealUnitIds?:Array,frame:Object,panelOrder?:number}} location
   * @param {number} duration
   * @param {{generation:number,isCurrent:(generation:number)=>boolean,readingPaceMultiplier:number,getElements:()=>ArrayLike<HTMLElement>,fadeMs?:number,finalPauseMs?:number}} runtime
   */
  reveal(location, duration, runtime) {
    if (!this.ready) return duration;
    this.cancelSchedule();
    this._generation = runtime.generation;
    this._isCurrent = runtime.isCurrent;
    this._getElements = runtime.getElements;
    const fallbackUnitIds = this._sources
      .filter((source) => sourceBelongsToLocation(source, location))
      .map((source) => source.unitId);
    const ownedUnitIds = Object.prototype.hasOwnProperty.call(location, "revealUnitIds")
      ? location.revealUnitIds
      : fallbackUnitIds;
    const unitIds = new Set(ownedUnitIds || []);
    const boxes = this._sources.filter((source) => (
      !this._revealedIds.has(source.id) && unitIds.has(source.unitId)
    ));
    if (!boxes.length) return duration;

    const units = [];
    boxes.forEach((source) => {
      let unit = units.find((candidate) => candidate.id === source.unitId);
      if (!unit) {
        unit = { id: source.unitId, sources: [], characters: 0, delay: 0, timer: null, started: false };
        units.push(unit);
      }
      unit.sources.push(source);
      unit.characters += Math.max(1, characterCount(source.text));
    });
    const finalPauseMs = Number.isFinite(runtime.finalPauseMs) ? runtime.finalPauseMs : DEFAULT_FINAL_PAUSE_MS;
    units.forEach((unit) => {
      unit.readingMs = textReadingMs(
        unit.sources.map((source) => source.text).join(" "),
        runtime.readingPaceMultiplier
      );
    });
    units[units.length - 1].readingMs += finalPauseMs;
    const rawReadingMs = units.reduce((total, unit) => total + unit.readingMs, 0);
    const readingScale = duration / Math.max(1, rawReadingMs);
    const fadeMs = Number.isFinite(runtime.fadeMs) ? runtime.fadeMs : DEFAULT_FADE_MS;
    let elapsed = 0;
    units.forEach((unit) => {
      const readingMs = unit.readingMs * readingScale;
      unit.delay = elapsed;
      unit.fadeMs = fadeMs;
      this._timings.set(unit.id, unit.characters + " char · " + Math.round(readingMs) + " ms");
      elapsed += fadeMs + readingMs;
    });
    this._units = units;
    this._elapsed = 0;
    this._startedAt = this._now();
    this._paused = false;
    this._armPendingUnits();
    this._publish();
    return elapsed;
  }

  pause() {
    if (this._paused || !this._units.length) return false;
    this._elapsed += Math.max(0, this._now() - this._startedAt);
    this._units.forEach((unit) => {
      if (unit.timer !== null) this._clearTimer(unit.timer);
      unit.timer = null;
    });
    this._animations.forEach((entry) => entry.animation.pause());
    this._paused = true;
    return true;
  }

  /** @param {number} generation @param {(generation:number)=>boolean} isCurrent */
  resume(generation, isCurrent) {
    if (!this._paused) return false;
    this._generation = generation;
    this._isCurrent = isCurrent;
    this._startedAt = this._now();
    this._animations.forEach((entry) => entry.animation.play());
    this._paused = false;
    this._armPendingUnits();
    return true;
  }

  /**
   * Resets reveal state when a physical source panel is revisited.
   * @param {number} pageIndex
   * @param {number} sourcePanelIndex
   * @param {Object} sourcePanel
   */
  enterPanel(pageIndex, sourcePanelIndex, sourcePanel) {
    const sourceKey = pageIndex + ":" + sourcePanelIndex;
    if (this._activePanelSource !== sourceKey && this._visitedPanelSources.has(sourceKey)) {
      this.resetPanel(sourcePanel);
    }
    this._visitedPanelSources.add(sourceKey);
    this._activePanelSource = sourceKey;
  }

  /** @param {Object} panel */
  resetPanel(panel) {
    const unitIds = new Set(this._sources
      .filter((source) => sourceBelongsToLocation(source, panel))
      .map((source) => source.unitId));
    this._sources.forEach((source) => {
      if (!unitIds.has(source.unitId)) return;
      this._revealedIds.delete(source.id);
      this._timings.delete(source.unitId);
    });
    this._publish();
  }

  cancelSchedule() {
    this._token++;
    this._units.forEach((unit) => {
      if (unit.timer !== null) this._clearTimer(unit.timer);
    });
    this._animations.forEach((entry) => entry.animation.cancel());
    this._units = [];
    this._animations = [];
    this._elapsed = 0;
    this._paused = false;
  }

  clear() {
    this.cancelSchedule();
    this._pageIndex = null;
    this._sources = [];
    this._revealedIds.clear();
    this._timings.clear();
    this._visitedPanelSources.clear();
    this._activePanelSource = null;
    this._layout = null;
    this._onViewModel({ boxes: [], overlayStyle: "display:none" });
  }

  destroy() {
    this.clear();
  }

  _armPendingUnits() {
    const token = this._token;
    this._units.forEach((unit) => {
      if (unit.started) return;
      const remainingDelay = Math.max(0, unit.delay - this._elapsed);
      unit.timer = this._setTimer(() => {
        unit.timer = null;
        if (this._paused || token !== this._token || !this._isCurrent(this._generation)) return;
        unit.started = true;
        this._startUnitAnimation(unit, token);
      }, remainingDelay);
    });
  }

  _startUnitAnimation(unit, token) {
    const elements = [...(this._getElements() || [])];
    const entries = unit.sources.map((source) => {
      const element = elements.find((candidate) => candidate.dataset.revealId === source.id);
      if (!element) return null;
      const animation = element.animate(
        [{ opacity: 1 }, { opacity: 0 }],
        { duration: Math.max(1, unit.fadeMs), easing: "ease-in-out", fill: "forwards" }
      );
      const entry = { animation, unitId: unit.id };
      this._animations.push(entry);
      animation.finished.then(() => {
        if (token !== this._token || !this._isCurrent(this._generation)) return;
        source && this._revealedIds.add(source.id);
        this._animations = this._animations.filter((candidate) => candidate !== entry);
        animation.cancel();
        this._publish();
      }, () => {});
      return entry;
    }).filter(Boolean);
    if (!entries.length) {
      unit.sources.forEach((source) => this._revealedIds.add(source.id));
      this._publish();
    }
  }

  _publish() {
    if (!this._layout || !this.ready) return;
    const image = this._layout.image;
    const stage = this._layout.stage;
    const stageKey = stage.clientWidth + "x" + stage.clientHeight;
    if (this._cachedStageKey !== stageKey || this._cachedSources !== this._sources) {
      this._cachedStageKey = stageKey;
      this._cachedSources = this._sources;
      this._cachedScale = Math.min(stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight);
      this._cachedOffsetX = (stage.clientWidth - image.naturalWidth * this._cachedScale) / 2;
      this._cachedOffsetY = (stage.clientHeight - image.naturalHeight * this._cachedScale) / 2;
    }
    const scale = this._cachedScale;
    const renderedWidth = image.naturalWidth * scale;
    const renderedHeight = image.naturalHeight * scale;
    const offsetX = this._cachedOffsetX;
    const offsetY = this._cachedOffsetY;
    const overlayStyle = [
      "display:block",
      "left:" + offsetX + "px",
      "top:" + offsetY + "px",
      "width:" + renderedWidth + "px",
      "height:" + renderedHeight + "px",
    ].join(";");
    const boxes = this._sources.map((source) => {
      const bounds = boundsFromPoly(source.poly);
      if (!bounds) return null;
      return {
        id: source.id,
        debugLabel: this._layout.showTimingDebug ? this._timings.get(source.unitId) || "" : "",
        debugStyle: [
          "left:" + (bounds.left / image.naturalWidth * 100) + "%",
          "top:" + (bounds.top / image.naturalHeight * 100) + "%",
          "max-width:" + ((bounds.right - bounds.left) / image.naturalWidth * 100) + "%",
        ].join(";"),
        style: [
          "left:" + (bounds.left / image.naturalWidth * 100) + "%",
          "top:" + (bounds.top / image.naturalHeight * 100) + "%",
          "width:" + ((bounds.right - bounds.left) / image.naturalWidth * 100) + "%",
          "height:" + ((bounds.bottom - bounds.top) / image.naturalHeight * 100) + "%",
          "background:" + source.color,
          "opacity:" + (this._revealedIds.has(source.id) ? "0" : "1"),
          "will-change:opacity",
        ].join(";"),
      };
    }).filter(Boolean);
    this._onViewModel({ boxes, overlayStyle });
  }
}

function sourceBelongsToLocation(source, location) {
  if (location.partCount > 1) return lineBelongsToLocation(source.line, location.frame || location);
  if (source.panelOrder !== null && source.panelOrder !== undefined
    && location.panelOrder !== null && location.panelOrder !== undefined) {
    return source.panelOrder === location.panelOrder;
  }
  return lineBelongsToLocation(source.line, location.frame || location);
}

function lineBelongsToLocation(line, frame) {
  const bounds = boundsFromPoly(line.poly);
  if (!bounds) return false;
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  return centerX >= frame.x && centerX <= frame.x + frame.w
    && centerY >= frame.y && centerY <= frame.y + frame.h;
}


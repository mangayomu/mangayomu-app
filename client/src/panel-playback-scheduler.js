import { boundsFromPoly, characterCount } from "./panel-page-analysis.js";

const DEFAULT_CHARACTERS_PER_SECOND = 20;
const DEFAULT_SPACE_PAUSE_MS = 50;
const DEFAULT_FINAL_PAUSE_MS = 800;
// Artwork-only Director beats need time to be looked at, not just traversed.
const DEFAULT_COVERAGE_HOLD_MS = 2000;
const DEFAULT_ENTRY_HOLD_MS = 300;
const DEFAULT_ENTRY_TRANSITION_MS = 1000;
const DEFAULT_TRANSITION_MIN_MS = 700;
const DEFAULT_TRANSITION_MAX_MS = 2400;

/**
 * Adds playback timing to a strategy-independent camera plan.
 * @param {{strategy:string,locations:Array}} cameraPlan
 * @param {{eligibleLines?:Array,balloonIdByLine?:Map,frameBalloons?:Array,sources?:Array}} pageData
 * @param {{timingPolicy:"text"|"panelArea",minimumHoldMs:number,readingPaceMultiplier:number,overviewHoldMs:number,movementDurationMs:number,finalPauseMs?:number,imageArea?:number}} preferences
 * @returns {{strategy:string,locations:Array}}
 */
export function createPanelPlaybackSchedule(cameraPlan, pageData, preferences) {
  const lines = pageData && Array.isArray(pageData.eligibleLines) ? pageData.eligibleLines : [];
  const subjects = pageData && Array.isArray(pageData.frameBalloons) ? pageData.frameBalloons : [];
  return {
    strategy: cameraPlan.strategy,
    locations: cameraPlan.locations.map((location, locationIndex) => {
      const timingLines = timingLinesForLocation(location, cameraPlan.locations, locationIndex, lines, pageData && pageData.balloonIdByLine);
      const subjectReadingMs = cameraPlan.strategy === "director"
        ? readingMsForSubjects(location.subjectIds, subjects, preferences.readingPaceMultiplier)
        : 0;
      const textDuration = subjectReadingMs || textReadingMsForLines(timingLines, preferences.readingPaceMultiplier);
      const timing = timingFor(
        location,
        cameraPlan.locations[locationIndex - 1] || null,
        textDuration,
        preferences,
        cameraPlan.strategy
      );
      return {
        ...location,
        transitionDurationMs: timing.transitionDurationMs,
        transitionEasing: location.movement.easing,
        holdDurationMs: timing.holdDurationMs,
        revealDurationMs: timing.revealDurationMs,
        timingLines,
      };
    }),
  };
}

/**
 * @param {string} text
 * @param {number} multiplier
 */
export function textReadingMs(text, multiplier) {
  const trimmed = String(text || "").trim();
  if (!trimmed) return 0;
  const spaces = (trimmed.match(/\s/g) || []).length;
  return characterCount(trimmed) / DEFAULT_CHARACTERS_PER_SECOND * multiplier * 1000
    + spaces * DEFAULT_SPACE_PAUSE_MS;
}

function timingFor(location, previousLocation, textDuration, preferences, strategy) {
  const minimumHoldMs = Math.max(0, Number(preferences.minimumHoldMs) || 0);
  const finalPauseMs = Number.isFinite(preferences.finalPauseMs)
    ? Math.max(0, preferences.finalPauseMs)
    : DEFAULT_FINAL_PAUSE_MS;
  let transitionDurationMs = transitionDurationFor(location, previousLocation, preferences, strategy);
  let holdDurationMs;
  let revealDurationMs;

  const readingPan = location.movement.kind === "reading-pan-lead"
    || location.movement.kind === "reading-pan-travel";
  const readingDuration = readingPan ? Math.max(1200, textDuration) : textDuration;
  if (location.movement.kind === "reading-pan-travel") {
    const leadDuration = clamp(readingDuration * .2, 600, 1000);
    transitionDurationMs = Math.max(1200, readingDuration - leadDuration);
  } else if (location.movement.kind === "coverage-pan") {
    transitionDurationMs = Math.max(3500, transitionDurationMs);
  }

  if (location.kind === "overview") {
    holdDurationMs = Math.max(0, Number(preferences.overviewHoldMs) || 0);
  } else if (preferences.timingPolicy === "panelArea") {
    const imageArea = Math.max(1, Number(preferences.imageArea) || 1);
    const areaFraction = Math.min(1, location.frame.w * location.frame.h / imageArea);
    holdDurationMs = Math.max(
      minimumHoldMs,
      areaFraction * 15000 * preferences.readingPaceMultiplier
    );
  } else if (location.movement.kind === "entry") {
    holdDurationMs = DEFAULT_ENTRY_HOLD_MS;
  } else if (location.movement.kind === "reading-pan-lead") {
    holdDurationMs = clamp(readingDuration * .2, 600, 1000);
    revealDurationMs = readingDuration;
  } else if (location.movement.kind === "reading-pan-travel") {
    holdDurationMs = finalPauseMs;
  } else if (location.movement.kind === "coverage-pan") {
    holdDurationMs = 700;
  } else if (location.kind === "coverage" && strategy === "director") {
    holdDurationMs = Math.max(minimumHoldMs, DEFAULT_COVERAGE_HOLD_MS);
  } else {
    holdDurationMs = Math.max(minimumHoldMs, textDuration + (textDuration ? finalPauseMs : 0));
  }

  if (!Number.isFinite(revealDurationMs)) revealDurationMs = holdDurationMs;
  return { transitionDurationMs, holdDurationMs, revealDurationMs };
}

function transitionDurationFor(location, previousLocation, preferences, strategy) {
  if (location.movement.stationary) return 0;
  if (location.movement.kind === "reading-pan-travel") return 0;
  if (strategy !== "director") return Math.max(0, Number(preferences.movementDurationMs) || 0);
  if (!previousLocation || location.movement.kind === "entry") return DEFAULT_ENTRY_TRANSITION_MS;

  const previous = previousLocation.frame;
  const next = location.frame;
  const previousCenterX = previous.x + previous.w / 2;
  const previousCenterY = previous.y + previous.h / 2;
  const nextCenterX = next.x + next.w / 2;
  const nextCenterY = next.y + next.h / 2;
  const viewportDiagonal = Math.max(1, Math.hypot(next.w, next.h));
  const panDistance = Math.hypot(nextCenterX - previousCenterX, nextCenterY - previousCenterY) / viewportDiagonal;
  const zoomDistance = Math.abs(Math.log2(Math.max(.001, next.zoom) / Math.max(.001, previous.zoom)));
  return Math.round(clamp(
    650 + panDistance * 1200 + zoomDistance * 650,
    DEFAULT_TRANSITION_MIN_MS,
    DEFAULT_TRANSITION_MAX_MS
  ));
}

function timingLinesForLocation(location, locations, locationIndex, lines, balloonIdByLine) {
  if (location.subjectIds.length && balloonIdByLine instanceof Map) {
    const subjectIds = new Set(location.subjectIds);
    return lines.filter((line) => subjectIds.has(balloonIdByLine.get(line)));
  }
  return lines.filter((line) => {
    const firstVisibleLocation = locations.findIndex((candidate) => (
      candidate.kind !== "overview"
      && candidate.sourcePanelIndex === location.sourcePanelIndex
      && lineBelongsToLocation(line, candidate)
    ));
    return firstVisibleLocation < 0
      ? lineBelongsToLocation(line, location)
      : firstVisibleLocation === locationIndex;
  });
}

function readingMsForSubjects(subjectIds, subjects, multiplier) {
  if (!subjectIds.length) return 0;
  const ids = new Set(subjectIds);
  return subjects
    .filter((subject) => ids.has(subject.id))
    .reduce((total, subject) => total + textReadingMs(subject.readingText, multiplier), 0);
}

function textReadingMsForLines(lines, multiplier) {
  return lines.reduce((total, line) => total + textReadingMs(line.text, multiplier), 0);
}

function lineBelongsToLocation(line, location) {
  const bounds = boundsFromPoly(line.poly);
  if (!bounds) return false;
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const frame = location.frame;
  return centerX >= frame.x && centerX <= frame.x + frame.w
    && centerY >= frame.y && centerY <= frame.y + frame.h;
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

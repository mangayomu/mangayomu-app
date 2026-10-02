import { PanelDirector } from "./panel-director.js";
import { planReadablePanelFrames } from "./panel-frame-planner.js";

/**
 * Creates one strategy-independent camera plan.
 * @param {{
 *   strategy:"classic"|"director",
 *   panels:Array,
 *   subjects:Array,
 *   context:Object,
 *   readingDirection:"rtl"|"ltr"
 * }} input
 * @returns {{strategy:"classic"|"director",locations:Array,coverage:Array,detectedBalloons:Array}}
 */
export function createPanelCameraPlan(input) {
  if (input.strategy === "classic") return createClassicCameraPlan(input);
  return createDirectorCameraPlan(input);
}

function createClassicCameraPlan(input) {
  const frames = planReadablePanelFrames(input.panels, input.subjects, input.context);
  const panelCounts = new Map();
  frames.forEach((frame) => {
    panelCounts.set(frame.sourcePanelIndex, (panelCounts.get(frame.sourcePanelIndex) || 0) + 1);
  });
  const panelIndexes = new Map();
  const locations = frames.map((frame, index) => {
    const partIndex = panelIndexes.get(frame.sourcePanelIndex) || 0;
    panelIndexes.set(frame.sourcePanelIndex, partIndex + 1);
    const subjects = input.subjects.filter((subject) => subjectBelongsToFrame(subject, frame));
    return createLocation({
      id: "classic-location-" + index,
      kind: frame.kind === "overview" ? "overview" : subjects.length ? "reading" : "coverage",
      frame,
      sourcePanelIndex: frame.sourcePanelIndex,
      panelOrder: frame.order,
      partIndex,
      partCount: panelCounts.get(frame.sourcePanelIndex),
      subjectIds: subjects.map((subject) => subject.id).filter(Boolean),
      revealUnitIds: unique(subjects.flatMap((subject) => subject.revealUnitIds || [])),
      textDirection: null,
      movement: {
        kind: frame.kind === "overview" ? "overview" : "classic",
        stationary: false,
        easing: "easeOutCubic",
      },
    });
  });
  return { strategy: "classic", locations, coverage: [], detectedBalloons: [] };
}

function createDirectorCameraPlan(input) {
  const directorPlan = new PanelDirector({
    panels: input.panels,
    balloons: input.subjects,
    context: input.context,
    readingDirection: input.readingDirection,
  }).plan();
  const shots = new Map(directorPlan.shots.map((shot) => [shot.id, shot]));
  const panelCounts = new Map();
  directorPlan.beats.forEach((beat) => {
    panelCounts.set(beat.panelIndex, (panelCounts.get(beat.panelIndex) || 0) + 1);
  });
  const panelIndexes = new Map();
  let previousShotId = null;
  let panRevealBeatId = null;
  const locations = directorPlan.beats.map((beat, index) => {
    const shot = shots.get(beat.shotId);
    if (!shot) throw new Error("Director beat references a missing shot: " + beat.shotId);
    const partIndex = panelIndexes.get(beat.panelIndex) || 0;
    panelIndexes.set(beat.panelIndex, partIndex + 1);
    const sameShot = previousShotId === shot.id;
    const panel = input.panels[beat.panelIndex];
    previousShotId = shot.id;
    // reading-pan-lead and reading-pan-travel share one reveal beat
    const isReadingPan = beat.timingRole === "reading-pan-lead" || beat.timingRole === "reading-pan-travel";
    if (isReadingPan && !panRevealBeatId) {
      panRevealBeatId = "panel-" + beat.panelIndex + "-pan-" + partIndex;
    }
    if (!isReadingPan) panRevealBeatId = null;
    return createLocation({
      id: beat.id || "director-location-" + index,
      kind: beat.kind,
      frame: shot.frame,
      sourcePanelIndex: beat.panelIndex,
      panelOrder: panel && panel.order !== undefined ? panel.order : null,
      partIndex,
      partCount: panelCounts.get(beat.panelIndex),
      subjectIds: beat.balloonIds.slice(),
      revealUnitIds: beat.revealUnitIds.slice(),
      revealBeatId: panRevealBeatId || null,
      textDirection: beat.textDirection || null,
      movement: {
        kind: beat.timingRole || beat.kind,
        stationary: sameShot,
        easing: shot.transition.easing,
      },
    });
  });
  return {
    strategy: "director",
    locations,
    coverage: directorPlan.coverage,
    detectedBalloons: directorPlan.detectedBalloons,
    composition: directorPlan.composition,
  };
}

function createLocation(input) {
  return {
    id: input.id,
    kind: input.kind,
    frame: {
      x: input.frame.x,
      y: input.frame.y,
      w: input.frame.w,
      h: input.frame.h,
      zoom: input.frame.zoom,
    },
    sourcePanelIndex: input.sourcePanelIndex,
    panelOrder: input.panelOrder === undefined ? null : input.panelOrder,
    partIndex: input.partIndex,
    partCount: input.partCount,
    subjectIds: input.subjectIds,
    revealUnitIds: input.revealUnitIds,
    revealBeatId: input.revealBeatId || null,
    textDirection: input.textDirection,
    movement: input.movement,
  };
}

function subjectBelongsToFrame(subject, frame) {
  const box = subject && subject.box;
  if (!box) return false;
  const centerX = (box.left + box.right) / 2;
  const centerY = (box.top + box.bottom) / 2;
  return centerX >= frame.x && centerX <= frame.x + frame.w
    && centerY >= frame.y && centerY <= frame.y + frame.h;
}

function unique(values) {
  return [...new Set(values)];
}

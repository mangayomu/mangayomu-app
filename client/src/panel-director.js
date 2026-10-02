import { panelReadingBounds } from "./panel-reading-bounds.js";

const DEFAULT_COMPOSITION_ZOOM = 1.2;
const DEFAULT_MINIMUM_COVERAGE_GAIN = .2;
const DEFAULT_MAXIMUM_SUBJECT_OCCUPANCY = .78;
const DEFAULT_SHARED_READING_VERTICAL_SPAN = .65;
const DEFAULT_COMPOSITION_GUTTER = 18;

/**
 * Plans camera compositions separately from reading beats.
 *
 * The director is pure: it never touches the DOM, clocks, or Reader state.
 * Balloons are reading subjects; panel regions are geometric coverage
 * subjects. The swept area of every camera movement contributes to coverage.
 */
export class PanelDirector {
  /**
   * @param {{
   *   panels:Array<{x:number,y:number,w:number,h:number,order?:number}>,
   *   balloons:Array<{id:string,box:{left:number,right:number,top:number,bottom:number},revealUnitIds?:string[]}>,
   *   context:{imageWidth:number,imageHeight:number,viewportWidth:number,viewportHeight:number,minZoom:number,maxZoom:number,directorCompositionZoom?:number,compositionGutter?:number,minimumCoverageGain?:number},
   *   readingDirection?:"rtl"|"ltr"
   * }} input
   */
  constructor(input) {
    this.panels = Array.isArray(input?.panels) ? input.panels : [];
    this.balloons = Array.isArray(input?.balloons) ? input.balloons : [];
    this.context = input?.context || {};
    this.readingDirection = input?.readingDirection === "ltr" ? "ltr" : "rtl";
  }

  plan() {
    if (!hasUsableContext(this.context)) return { shots: [], beats: [], coverage: [], detectedBalloons: [] };

    const scale = Math.min(
      this.context.viewportWidth / this.context.imageWidth,
      this.context.viewportHeight / this.context.imageHeight
    );
    const assigned = assignBalloonsToPanels(this.panels, this.balloons);
    const shots = [];
    const beats = [];
    const coverage = [];
    const detectedBalloons = [];

    this.panels.forEach((panel, panelIndex) => {
      const panelBalloons = assigned[panelIndex];
      const panelPlan = this._planPanel(panel, panelIndex, panelBalloons, scale);
      shots.push(...panelPlan.shots);
      beats.push(...panelPlan.beats);
      coverage.push({ panelIndex, fraction: panelPlan.coverage });
      detectedBalloons.push({
        panelIndex,
        balloons: groupDetectedBalloonParagraphs(panelBalloons).map((paragraphs, balloonIndex) => ({
          id: "panel-" + panelIndex + "-balloon-" + balloonIndex,
          paragraphIds: paragraphs.map((paragraph) => paragraph.id),
          paragraphCount: paragraphs.reduce((total, paragraph) => total + Math.max(1, Number(paragraph.paragraphCount) || 1), 0),
          textDirections: [...new Set(paragraphs.map((paragraph) => inferTextDirection(paragraph.readingText, this.readingDirection)))],
        })),
      });
    });
    attachTransitionEasings(shots);
    return {
      shots,
      beats,
      coverage,
      detectedBalloons,
      composition: {
        profile: this.context.directorCompositionProfile || "custom",
        zoom: compositionZoomFor(this.context),
      },
    };
  }

  _planPanel(panel, panelIndex, balloons, scale) {
    const panelBox = toBounds(panelReadingBounds(panel, balloons, {
      width: this.context.imageWidth,
      height: this.context.imageHeight,
    }));
    const zoom = compositionZoomFor(this.context);
    if (!balloons.length) return planGeometricCoverage(
      panelBox,
      panelIndex,
      zoom,
      this.context,
      scale,
      this.readingDirection
    );

    if (panelFitsInComposition(panelBox, zoom, this.context, scale)
      && allBalloonsFitInComposition(balloons, panelBox, zoom, this.context, scale)
      && balloonsShareReadingComposition(balloons, panelBox, zoom, this.context, scale)) {
      const shot = createShot(panelIndex, "reading-0", "reading", panelBox, zoom);
      return {
        shots: [shot],
        beats: groupDetectedBalloonParagraphs(balloons)
          .map((paragraphs) => createDetectedBalloonBeat(panelIndex, shot.id, paragraphs)),
        coverage: 1,
      };
    }

    const shots = [];
    const beats = [];
    const groups = groupConsecutiveBalloons(balloons, panelBox, zoom, this.context, scale);
    const forceFullArtworkCoverage = !panelFitsInComposition(panelBox, zoom, this.context, scale);
    const coverage = createCoverageGrid(panelBox);
    const covered = new Set();
    let previousFrame = null;

    groups.forEach((group, groupIndex) => {
      const candidates = cameraCandidates(panelBox, group, zoom, this.context, scale);
      const nextBalloon = balloons[balloons.indexOf(group[group.length - 1]) + 1] || null;
      const paragraphPan = group.length === 1
        ? createLongParagraphPan(panelBox, group[0], this.context, scale, this.readingDirection, zoom)
        : null;
      const directionalReadingFrame = paragraphPan?.start || (groupIndex === 0
        ? createStartEdgeReadingFrame(
          panelBox,
          group,
          this.context,
          scale,
          this.readingDirection,
          zoom
        )
        : null);
      const frame = directionalReadingFrame || chooseCameraFrame({
        candidates,
        group,
        groupIndex,
        groupCount: groups.length,
        nextBalloon,
        previousFrame,
        coverage,
        covered,
        readingDirection: this.readingDirection,
        panel: panelBox,
      });

      if (!previousFrame && !directionalReadingFrame) {
        const entryFrame = createDirectionalEntryFrame(panelBox, frame, this.readingDirection);
        const entryShot = createShot(panelIndex, "entry", "entry", frameBounds(entryFrame), entryFrame.zoom);
        shots.push(entryShot);
        beats.push(createBeat(panelIndex, entryShot.id, "entry", [], []));
        markCovered(coverage, covered, frameBounds(entryFrame));
        previousFrame = entryFrame;
      }

      const shot = createShot(panelIndex, "reading-" + groupIndex, "reading", frameBounds(frame), frame.zoom);
      shots.push(shot);
      if (paragraphPan) {
        const readingBeat = createBeat(
          panelIndex,
          shot.id,
          "reading",
          [group[0].id],
          Array.isArray(group[0].revealUnitIds) ? group[0].revealUnitIds.slice() : []
        );
        readingBeat.textDirection = paragraphPan.textDirection;
        readingBeat.timingRole = "reading-pan-lead";
        beats.push(readingBeat);
      } else {
        groupDetectedBalloonParagraphs(group).forEach((paragraphs) => {
          beats.push(createDetectedBalloonBeat(panelIndex, shot.id, paragraphs));
        });
      }
      if (previousFrame) markTransitionCoverage(coverage, covered, previousFrame, frame);
      else markCovered(coverage, covered, frameBounds(frame));
      previousFrame = frame;

      if (paragraphPan) {
        const panShot = createShot(panelIndex, "reading-pan-" + groupIndex, "reading-pan", frameBounds(paragraphPan.end), paragraphPan.end.zoom);
        shots.push(panShot);
        const panBeat = createBeat(
          panelIndex,
          panShot.id,
          "reading-pan",
          [group[0].id],
          []
        );
        panBeat.textDirection = paragraphPan.textDirection;
        panBeat.timingRole = "reading-pan-travel";
        beats.push(panBeat);
        markTransitionCoverage(coverage, covered, previousFrame, paragraphPan.end);
        previousFrame = paragraphPan.end;
      }
    });

    const coverageShot = createSupplementalCoverageShot({
      panel: panelBox,
      previousFrame,
      coverage,
      covered,
      context: this.context,
      scale,
      panelIndex,
      readingDirection: this.readingDirection,
      forceFullArtworkCoverage,
    });
    if (coverageShot) {
      shots.push(coverageShot);
      beats.push(createBeat(panelIndex, coverageShot.id, "coverage", [], []));
      markTransitionCoverage(coverage, covered, previousFrame, coverageShot.frame);
    }

    return { shots, beats, coverage: covered.size / Math.max(1, coverage.length) };
  }
}

function hasUsableContext(context) {
  return context.imageWidth > 0
    && context.imageHeight > 0
    && context.viewportWidth > 0
    && context.viewportHeight > 0
    && context.minZoom > 0
    && context.maxZoom >= context.minZoom;
}

function assignBalloonsToPanels(panels, balloons) {
  const assigned = panels.map(() => []);
  balloons.forEach((balloon) => {
    if (!isValidBounds(balloon?.box)) return;
    let bestIndex = -1;
    let bestOverlap = 0;
    panels.forEach((panel, panelIndex) => {
      const overlap = overlapArea(balloon.box, boundsFromPanel(panel));
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = panelIndex;
      }
    });
    if (bestIndex < 0) bestIndex = nearestPanelIndex(balloon.box, panels);
    if (bestIndex >= 0) assigned[bestIndex].push(balloon);
  });
  return assigned;
}

function groupDetectedBalloonParagraphs(paragraphs) {
  const balloons = [];
  paragraphs.forEach((paragraph) => {
    const balloon = balloons.find((candidate) => (
      candidate.every((item) => sameDetectedBalloonBounds(item.orderingBox, paragraph.orderingBox))
    ));
    if (balloon) balloon.push(paragraph);
    else balloons.push([paragraph]);
  });
  return balloons;
}

function groupConsecutiveBalloons(balloons, panel, zoom, context, scale) {
  const groups = [];
  let group = [];
  balloons.forEach((balloon) => {
    const candidate = group.concat(balloon);
    const sameDetectedBalloon = group.length && group.every((item) => sameDetectedBalloonBounds(item.orderingBox, balloon.orderingBox));
    if (group.length && !sameDetectedBalloon && (
      !balloonsFit(candidate, panel, zoom, context, scale)
      || !balloonsShareReadingComposition(candidate, panel, zoom, context, scale)
    )) {
      groups.push(group);
      group = [balloon];
    } else {
      group = candidate;
    }
  });
  if (group.length) groups.push(group);
  return groups;
}

function panelFitsInComposition(panel, zoom, context, scale) {
  return panel.right - panel.left <= context.viewportWidth / (scale * zoom)
    && panel.bottom - panel.top <= context.viewportHeight / (scale * zoom);
}

function allBalloonsFitInComposition(balloons, panel, zoom, context, scale) {
  return balloonsFit(balloons, panel, zoom, context, scale);
}

function balloonsShareReadingComposition(balloons, panel, zoom, context, scale) {
  const visibleHeight = Math.min(panel.bottom - panel.top, context.viewportHeight / (scale * zoom));
  const bounds = paddedBalloonBounds(balloons, context);
  return bounds.bottom - bounds.top <= visibleHeight * DEFAULT_SHARED_READING_VERTICAL_SPAN;
}

function balloonsFit(balloons, panel, zoom, context, scale) {
  const visibleWidth = Math.min(panel.right - panel.left, context.viewportWidth / (scale * zoom));
  const visibleHeight = Math.min(panel.bottom - panel.top, context.viewportHeight / (scale * zoom));
  const bounds = paddedBalloonBounds(balloons, context);
  const maximumOccupancy = Number(context.maximumSubjectOccupancy) || DEFAULT_MAXIMUM_SUBJECT_OCCUPANCY;
  return bounds.right - bounds.left <= visibleWidth * maximumOccupancy
    && bounds.bottom - bounds.top <= visibleHeight * maximumOccupancy;
}

function cameraCandidates(panel, balloons, zoom, context, scale) {
  const subject = keepInside(paddedBalloonBounds(balloons, context), panel);
  const width = Math.min(panel.right - panel.left, context.viewportWidth / (scale * zoom));
  const height = Math.min(panel.bottom - panel.top, context.viewportHeight / (scale * zoom));
  const minimumLeft = Math.max(panel.left, subject.right - width);
  const maximumLeft = Math.min(panel.right - width, subject.left);
  const minimumTop = Math.max(panel.top, subject.bottom - height);
  const maximumTop = Math.min(panel.bottom - height, subject.top);
  const centerLeft = clamp((subject.left + subject.right - width) / 2, minimumLeft, maximumLeft);
  const centerTop = clamp((subject.top + subject.bottom - height) / 2, minimumTop, maximumTop);
  const candidates = [];

  uniqueNumbers([minimumLeft, centerLeft, maximumLeft]).forEach((left) => {
    uniqueNumbers([minimumTop, centerTop, maximumTop]).forEach((top) => {
      candidates.push({ x: left, y: top, w: width, h: height, zoom });
    });
  });
  return candidates;
}

function chooseCameraFrame(input) {
  const groupBounds = unionBounds(input.group.map((balloon) => balloon.box));
  const nextBounds = input.nextBalloon?.box || null;
  return input.candidates.slice().sort((first, second) => {
    if (input.groupIndex === 0 && input.groupCount > 1) {
      const firstStart = startEdgeScore(first, input.panel, input.readingDirection);
      const secondStart = startEdgeScore(second, input.panel, input.readingDirection);
      if (secondStart !== firstStart) return secondStart - firstStart;
    }
    if (input.groupIndex === input.groupCount - 1) {
      const firstEnd = endEdgeScore(first, input.panel, input.readingDirection);
      const secondEnd = endEdgeScore(second, input.panel, input.readingDirection);
      if (secondEnd !== firstEnd) return secondEnd - firstEnd;
    }
    if (nextBounds) {
      const firstAhead = spaceToward(first, groupBounds, nextBounds);
      const secondAhead = spaceToward(second, groupBounds, nextBounds);
      if (secondAhead !== firstAhead) return secondAhead - firstAhead;
    }
    const firstNew = newCoverageCount(input.coverage, input.covered, frameBounds(first));
    const secondNew = newCoverageCount(input.coverage, input.covered, frameBounds(second));
    if (secondNew !== firstNew) return secondNew - firstNew;
    if (input.previousFrame) {
      return frameDistance(first, input.previousFrame) - frameDistance(second, input.previousFrame);
    }
    return first.y - second.y || directionalX(first.x, second.x, input.readingDirection);
  })[0];
}

function createLongParagraphPan(panel, paragraph, context, scale, panelDirection, zoom) {
  const textDirection = inferTextDirection(paragraph.readingText, panelDirection);
  const width = Math.min(panel.right - panel.left, context.viewportWidth / (scale * zoom));
  const height = Math.min(panel.bottom - panel.top, context.viewportHeight / (scale * zoom));
  const subject = keepInside(paddedBalloonBounds([paragraph], context), panel);
  const subjectWidth = subject.right - subject.left;
  const paragraphWidth = paragraph.box.right - paragraph.box.left;
  const paragraphHeight = Math.max(1, paragraph.box.bottom - paragraph.box.top);
  if (subjectWidth <= width * .92 || paragraphWidth / paragraphHeight < 6) return null;

  const spansMostOfPanel = subjectWidth >= (panel.right - panel.left) * .7;
  const leftX = spansMostOfPanel
    ? panel.left
    : clamp(subject.left, panel.left, panel.right - width);
  const rightX = spansMostOfPanel
    ? panel.right - width
    : clamp(subject.right - width, panel.left, panel.right - width);
  if (Math.abs(rightX - leftX) < width * .12) return null;

  const minimumTop = Math.max(panel.top, subject.bottom - height);
  const maximumTop = Math.min(panel.bottom - height, subject.top);
  const y = clamp((subject.top + subject.bottom - height) / 2, minimumTop, maximumTop);
  const leftFrame = { x: leftX, y, w: width, h: height, zoom };
  const rightFrame = { x: rightX, y, w: width, h: height, zoom };
  return {
    textDirection,
    start: textDirection === "ltr" ? leftFrame : rightFrame,
    end: textDirection === "ltr" ? rightFrame : leftFrame,
  };
}

function inferTextDirection(text, fallback) {
  const value = String(text || "");
  const rtlCharacters = (value.match(/[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/g) || []).length;
  const ltrCharacters = (value.match(/[0-9A-Za-zÀ-ž\u0370-\u052f]/g) || []).length;
  if (ltrCharacters > rtlCharacters) return "ltr";
  if (rtlCharacters > ltrCharacters) return "rtl";
  return fallback;
}

function createStartEdgeReadingFrame(panel, balloons, context, scale, direction, zoom) {
  const subject = keepInside(paddedBalloonBounds(balloons, context), panel);
  const width = Math.min(panel.right - panel.left, context.viewportWidth / (scale * zoom));
  const height = Math.min(panel.bottom - panel.top, context.viewportHeight / (scale * zoom));
  const x = direction === "rtl" ? panel.right - width : panel.left;
  const minimumTop = Math.max(panel.top, subject.bottom - height);
  const maximumTop = Math.min(panel.bottom - height, subject.top);
  const y = clamp((subject.top + subject.bottom - height) / 2, minimumTop, maximumTop);
  const frame = { x, y, w: width, h: height, zoom };
  return contains(frameBounds(frame), subject) ? frame : null;
}

function createDirectionalEntryFrame(panel, readingFrame, direction) {
  return {
    x: direction === "rtl" ? panel.right - readingFrame.w : panel.left,
    y: clamp(readingFrame.y, panel.top, panel.bottom - readingFrame.h),
    w: readingFrame.w,
    h: readingFrame.h,
    zoom: readingFrame.zoom,
  };
}

function planGeometricCoverage(panel, panelIndex, zoom, context, scale, readingDirection) {
  const visibleWidth = Math.min(panel.right - panel.left, context.viewportWidth / (scale * zoom));
  const visibleHeight = Math.min(panel.bottom - panel.top, context.viewportHeight / (scale * zoom));
  const horizontalOverflow = panel.right - panel.left > visibleWidth * 1.02;
  const verticalOverflow = panel.bottom - panel.top > visibleHeight * 1.02;
  const xStarts = horizontalOverflow
    ? (readingDirection === "rtl" ? [panel.right - visibleWidth, panel.left] : [panel.left, panel.right - visibleWidth])
    : [panel.left];
  const yStarts = verticalOverflow ? [panel.top, panel.bottom - visibleHeight] : [panel.top];
  const frames = horizontalOverflow
    ? xStarts.map((x) => ({ x, y: clamp((panel.top + panel.bottom - visibleHeight) / 2, panel.top, panel.bottom - visibleHeight), w: visibleWidth, h: visibleHeight, zoom }))
    : yStarts.map((y) => ({ x: clamp((panel.left + panel.right - visibleWidth) / 2, panel.left, panel.right - visibleWidth), y, w: visibleWidth, h: visibleHeight, zoom }));
  const grid = createCoverageGrid(panel);
  const covered = new Set();
  const shots = frames.map((frame, index) => {
    markCovered(grid, covered, frameBounds(frame));
    return createShot(panelIndex, "coverage-" + index, "coverage", frameBounds(frame), zoom);
  });
  return {
    shots,
    beats: shots.map((shot, index) => createBeat(
      panelIndex,
      shot.id,
      shots.length === 1 ? "coverage" : (index === 0 ? "entry" : "coverage-pan"),
      [],
      []
    )),
    coverage: covered.size / Math.max(1, grid.length),
  };
}

function createSupplementalCoverageShot(input) {
  if (!input.previousFrame || !input.coverage.length) return null;
  const currentCoverage = input.covered.size / input.coverage.length;
  if (currentCoverage >= .999) return null;
  const minimumGain = Number(input.context.minimumCoverageGain) || DEFAULT_MINIMUM_COVERAGE_GAIN;
  if (!input.forceFullArtworkCoverage && 1 - currentCoverage < minimumGain) return null;

  const previous = input.previousFrame;
  const width = previous.w;
  const height = previous.h;
  const xStarts = uniqueNumbers([input.panel.left, input.panel.right - width]);
  const yStarts = uniqueNumbers([input.panel.top, input.panel.bottom - height]);
  const candidates = [];
  xStarts.forEach((x) => yStarts.forEach((y) => {
    const frame = { x, y, w: width, h: height, zoom: previous.zoom };
    const gain = newCoverageCount(input.coverage, input.covered, frameBounds(frame)) / input.coverage.length;
    candidates.push({ frame, gain });
  }));
  candidates.sort((first, second) => second.gain - first.gain
    || endEdgeScore(second.frame, input.panel, input.readingDirection) - endEdgeScore(first.frame, input.panel, input.readingDirection)
    || frameDistance(first.frame, previous) - frameDistance(second.frame, previous));
  const best = candidates[0];
  if (!best || (!input.forceFullArtworkCoverage && best.gain < minimumGain)) return null;
  return createShot(input.panelIndex, "coverage", "coverage", frameBounds(best.frame), best.frame.zoom);
}

function createShot(panelIndex, key, kind, bounds, zoom) {
  return {
    id: "panel-" + panelIndex + "-shot-" + key,
    panelIndex,
    kind,
    frame: {
      x: bounds.left,
      y: bounds.top,
      w: bounds.right - bounds.left,
      h: bounds.bottom - bounds.top,
      zoom,
    },
    transition: { easing: "easeInOutCubic" },
  };
}

function createBeat(panelIndex, shotId, kind, balloonIds, revealUnitIds) {
  return {
    id: "panel-" + panelIndex + "-beat-" + kind + "-" + (balloonIds.join("+") || shotId),
    panelIndex,
    shotId,
    kind,
    balloonIds,
    revealUnitIds,
  };
}

function createDetectedBalloonBeat(panelIndex, shotId, paragraphs) {
  return createBeat(
    panelIndex,
    shotId,
    "reading",
    [...new Set(paragraphs.map((paragraph) => paragraph.id))],
    [...new Set(paragraphs.flatMap((paragraph) => (
      Array.isArray(paragraph.revealUnitIds) ? paragraph.revealUnitIds : []
    )))]
  );
}

function attachTransitionEasings(shots) {
  let previous = null;
  shots.forEach((shot) => {
    const zoomDistance = previous
      ? Math.abs(Math.log2(Math.max(.001, shot.frame.zoom) / Math.max(.001, previous.frame.zoom)))
      : 0;
    shot.transition = {
      easing: shot.kind === "entry" || zoomDistance > .2 ? "easeInOutCubic" : "easeOutCubic",
    };
    previous = shot;
  });
}

function compositionZoomFor(context) {
  return clamp(
    Number(context.directorCompositionZoom) || DEFAULT_COMPOSITION_ZOOM,
    context.minZoom,
    context.maxZoom
  );
}

function paddedBalloonBounds(balloons, context) {
  const bounds = unionBounds(balloons.map((balloon) => balloon.box));
  const padding = Math.max(0, Number(context.compositionGutter) || DEFAULT_COMPOSITION_GUTTER);
  return keepInside({
    left: bounds.left - padding,
    right: bounds.right + padding,
    top: bounds.top - padding,
    bottom: bounds.bottom + padding,
  }, { left: 0, top: 0, right: context.imageWidth, bottom: context.imageHeight });
}

function createCoverageGrid(panel) {
  const columns = 12;
  const rows = Math.max(4, Math.round(columns * (panel.bottom - panel.top) / Math.max(1, panel.right - panel.left)));
  const cells = [];
  for (let row = 0; row < rows; row++) {
    for (let column = 0; column < columns; column++) {
      cells.push({
        x: panel.left + (column + .5) * (panel.right - panel.left) / columns,
        y: panel.top + (row + .5) * (panel.bottom - panel.top) / rows,
      });
    }
  }
  return cells;
}

function markCovered(grid, covered, bounds) {
  grid.forEach((cell, index) => {
    if (pointInside(cell, bounds)) covered.add(index);
  });
}

function markTransitionCoverage(grid, covered, from, to) {
  const distance = frameDistance(from, to);
  const stepSize = Math.max(1, Math.min(from.w, from.h, to.w, to.h) / 8);
  const steps = Math.max(1, Math.ceil(distance / stepSize));
  for (let step = 0; step <= steps; step++) {
    const progress = step / steps;
    markCovered(grid, covered, {
      left: from.x + (to.x - from.x) * progress,
      right: from.x + from.w + (to.x + to.w - from.x - from.w) * progress,
      top: from.y + (to.y - from.y) * progress,
      bottom: from.y + from.h + (to.y + to.h - from.y - from.h) * progress,
    });
  }
}

function newCoverageCount(grid, covered, bounds) {
  let count = 0;
  grid.forEach((cell, index) => {
    if (!covered.has(index) && pointInside(cell, bounds)) count++;
  });
  return count;
}

function startEdgeScore(frame, panel, direction) {
  return direction === "rtl"
    ? proximityScore(frame.x + frame.w, panel.right)
    : proximityScore(frame.x, panel.left);
}

function endEdgeScore(frame, panel, direction) {
  return direction === "rtl"
    ? proximityScore(frame.x, panel.left)
    : proximityScore(frame.x + frame.w, panel.right);
}

function proximityScore(value, target) {
  return -Math.abs(value - target);
}

function spaceToward(frame, current, next) {
  const currentCenter = centerOfBounds(current);
  const nextCenter = centerOfBounds(next);
  const dx = nextCenter.x - currentCenter.x;
  const dy = nextCenter.y - currentCenter.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return dx >= 0 ? frame.x + frame.w - current.right : current.left - frame.x;
  }
  return dy >= 0 ? frame.y + frame.h - current.bottom : current.top - frame.y;
}

function directionalX(first, second, direction) {
  return direction === "rtl" ? second - first : first - second;
}

function nearestPanelIndex(box, panels) {
  const center = centerOfBounds(box);
  let nearest = -1;
  let distance = Infinity;
  panels.forEach((panel, index) => {
    const panelCenter = centerOfBounds(boundsFromPanel(panel));
    const candidate = Math.hypot(center.x - panelCenter.x, center.y - panelCenter.y);
    if (candidate < distance) {
      nearest = index;
      distance = candidate;
    }
  });
  return nearest;
}

function unionBounds(bounds) {
  return {
    left: Math.min(...bounds.map((box) => box.left)),
    right: Math.max(...bounds.map((box) => box.right)),
    top: Math.min(...bounds.map((box) => box.top)),
    bottom: Math.max(...bounds.map((box) => box.bottom)),
  };
}

function keepInside(bounds, container) {
  const width = Math.min(container.right - container.left, bounds.right - bounds.left);
  const height = Math.min(container.bottom - container.top, bounds.bottom - bounds.top);
  const left = clamp(bounds.left, container.left, container.right - width);
  const top = clamp(bounds.top, container.top, container.bottom - height);
  return { left, right: left + width, top, bottom: top + height };
}

function frameDistance(first, second) {
  const a = centerOfFrame(first);
  const b = centerOfFrame(second);
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function centerOfFrame(frame) {
  return { x: frame.x + frame.w / 2, y: frame.y + frame.h / 2 };
}

function centerOfBounds(bounds) {
  return { x: (bounds.left + bounds.right) / 2, y: (bounds.top + bounds.bottom) / 2 };
}

function frameBounds(frame) {
  return { left: frame.x, right: frame.x + frame.w, top: frame.y, bottom: frame.y + frame.h };
}

function boundsFromPanel(panel) {
  return { left: panel.x, right: panel.x + panel.w, top: panel.y, bottom: panel.y + panel.h };
}

function toBounds(panel) {
  return { left: panel.left, right: panel.right, top: panel.top, bottom: panel.bottom };
}

function overlapArea(first, second) {
  return Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left))
    * Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
}

function contains(outer, inner) {
  return outer.left <= inner.left && outer.right >= inner.right
    && outer.top <= inner.top && outer.bottom >= inner.bottom;
}

function pointInside(point, bounds) {
  return point.x >= bounds.left && point.x <= bounds.right
    && point.y >= bounds.top && point.y <= bounds.bottom;
}

function sameDetectedBalloonBounds(first, second) {
  if (!isValidBounds(first) || !isValidBounds(second)) return false;
  const firstArea = (first.right - first.left) * (first.bottom - first.top);
  const secondArea = (second.right - second.left) * (second.bottom - second.top);
  if (Math.max(firstArea, secondArea) / Math.max(1, Math.min(firstArea, secondArea)) > 2.5) return false;
  return overlapArea(first, second) / Math.max(1, Math.min(firstArea, secondArea)) >= .85;
}

function isValidBounds(bounds) {
  return bounds && Number.isFinite(bounds.left) && Number.isFinite(bounds.right)
    && Number.isFinite(bounds.top) && Number.isFinite(bounds.bottom)
    && bounds.right > bounds.left && bounds.bottom > bounds.top;
}

function uniqueNumbers(values) {
  return values.filter((value, index) => values.findIndex((candidate) => Math.abs(candidate - value) < .001) === index);
}

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

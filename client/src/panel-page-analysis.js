import { preloadPaddleTinyOcr, recognizePaddleTinyText } from "./paddle-tiny-ocr.js";
import { createBalloonEdgeDetector } from "./balloon-edge.js";
import { findBestPanelIndex, orderTextItems, sameBalloonOrderingBounds } from "./balloon-reading-order.js";

/** Owns page-scoped panel detection and OCR analysis caches for one Reader session. */
export class PanelPageAnalysisService {
  /**
   * @param {{
   *   loadPanelDetector?:() => Promise<{detectPanels:(image:HTMLImageElement) => {boxes:Array}}>,
   *   preloadOcr?:() => Promise<unknown>,
   *   recognizeText?:(image:HTMLImageElement) => Promise<Array>,
   *   createEdgeDetector?:(image:HTMLImageElement) => Promise<Function|null>,
   *   analyzeAppearance?:(image:HTMLImageElement,item:{poly:Array}) => {coverColor:string,hasWhitish:boolean,hasColour:boolean}
   * }} [dependencies]
   */
  constructor(dependencies = {}) {
    this._loadPanelDetector = dependencies.loadPanelDetector || (() => import("panel-detect"));
    this._preloadOcr = dependencies.preloadOcr || preloadPaddleTinyOcr;
    this._recognizeText = dependencies.recognizeText || recognizePaddleTinyText;
    this._createEdgeDetector = dependencies.createEdgeDetector || createBalloonEdgeDetector;
    this._analyzeAppearance = dependencies.analyzeAppearance || analyzeTextLineAppearance;
    this._panelDetectorPromise = null;
    this._panels = new Map();
    this._panelRequests = new Map();
    this._panelFailures = new Set();
    this._baseRequests = new Map();
    this._pageVersions = new Map();
    this._analysisVersions = new Map();
    this._generation = 0;
  }

  preloadOcr() {
    return this._preloadOcr();
  }

  /** @param {number} pageIndex */
  hasPanels(pageIndex) {
    return this._panels.has(pageIndex);
  }

  /** @param {number} pageIndex */
  isPanelDetectionFailed(pageIndex) {
    return this._panelFailures.has(pageIndex);
  }

  /** @param {number} pageIndex */
  getCachedPanels(pageIndex) {
    return this._panels.get(pageIndex) || null;
  }

  /** @returns {Set<number>} page indexes with cached panel or OCR analysis. */
  getCachedPageIndexes() {
    return new Set([
      ...this._panels.keys(),
      ...this._baseRequests.keys(),
    ]);
  }

  /** @param {number} pageIndex */
  isPagePending(pageIndex) {
    return this._panelRequests.has(pageIndex)
      || this._baseRequests.get(pageIndex)?.pending === true;
  }

  /**
   * @param {number} pageIndex
   * @param {HTMLImageElement} image
   * @returns {Promise<Array>}
   */
  async getPanels(pageIndex, image, detectionOptions = {}) {
    if (this._panels.has(pageIndex)) return this._panels.get(pageIndex);
    const pending = this._panelRequests.get(pageIndex);
    if (pending) return pending.request;

    const version = (this._pageVersions.get(pageIndex) || 0) + 1;
    const generation = this._generation;
    this._pageVersions.set(pageIndex, version);
    const entry = { version, generation, request: null, pending: true };
    const request = (async () => {
      try {
        if (!this._panelDetectorPromise) this._panelDetectorPromise = this._loadPanelDetector();
        const detector = await this._panelDetectorPromise;
        const result = detector.detectPanels(image, detectionOptions);
        if (detectionOptions.splitFusedPanels) {
          console.log("[Panel detection] second pass", "page", pageIndex + 1, "boxes", result.boxes.length, "totalMs", Math.round(result.timings.total));
          result.boxes.forEach(({ x, y, w, h, kind, order }, index) => {
            console.log("[Panel detection]", "page", pageIndex + 1, "P" + (index + 1), kind, "order", order, "x", x, "y", y, "w", w, "h", h);
          });
        }
        const boxes = result.boxes.length > 1
          ? result.boxes
          : [wholePagePanel(image)];
        if (this._isCurrentPanelRequest(pageIndex, entry)) this._panels.set(pageIndex, boxes);
        return boxes;
      } catch (error) {
        const fallback = [wholePagePanel(image)];
        if (this._isCurrentPanelRequest(pageIndex, entry)) {
          this._panelFailures.add(pageIndex);
          this._panels.set(pageIndex, fallback);
        }
        return fallback;
      } finally {
        if (this._isCurrentPanelRequest(pageIndex, entry)) {
          entry.pending = false;
          this._panelRequests.delete(pageIndex);
        }
      }
    })();
    entry.request = request;
    this._panelRequests.set(pageIndex, entry);
    return request;
  }

  /**
   * Returns setting-independent OCR, balloon, panel, and debug geometry.
   * @param {number} pageIndex
   * @param {HTMLImageElement} image
   */
  async analyze(pageIndex, image, panelDetectionOptions = {}) {
    const assetId = pageAssetId(pageIndex, image);
    const cached = this._baseRequests.get(pageIndex);
    if (cached && cached.assetId === assetId) return cached.request;

    const version = (this._analysisVersions.get(pageIndex) || 0) + 1;
    const generation = this._generation;
    this._analysisVersions.set(pageIndex, version);
    const entry = { assetId, version, generation, request: null, pending: true };
    const request = Promise.all([
      this.getPanels(pageIndex, image, panelDetectionOptions),
      this._recognizeText(image),
    ]).then(async ([panels, items]) => {
      const lines = items.filter(isRecognizedTextLine)
        .filter(isValidatedPaddleLine)
        .map((line) => ({
          ...line,
          appearance: this._analyzeAppearance(image, line),
        }));
      const balloonGroups = buildBalloonGroups(lines);
      await attachBalloonOrderingBounds(image, balloonGroups, this._createEdgeDetector);
      balloonGroups.forEach((group) => {
        group.revealCoverColor = this._analyzeAppearance(image, group).coverColor;
        const colourFilteredLines = group.lines.filter((line) => (
          line.appearance.hasWhitish && !line.appearance.hasColour
        ));
        const colourFilteredGroup = mergeBalloonLines(colourFilteredLines);
        group.colourFilteredRevealCoverColor = colourFilteredGroup && colourFilteredLines.length !== group.lines.length
          ? this._analyzeAppearance(image, colourFilteredGroup).coverColor
          : group.revealCoverColor;
      });
      return {
        pageIndex,
        assetId,
        panels,
        lines,
        balloonGroups,
        orderingBoxes: createOrderingDebugBoxes(balloonGroups),
      };
    });
    entry.request = request;
    this._baseRequests.set(pageIndex, entry);
    try {
      return await request;
    } catch (error) {
      if (this._isCurrentAnalysisRequest(pageIndex, entry)) this._baseRequests.delete(pageIndex);
      throw error;
    } finally {
      if (this._baseRequests.get(pageIndex) === entry) entry.pending = false;
    }
  }

  /**
   * Creates the geometry-only analysis used when OCR is unavailable.
   * @param {number} pageIndex
   * @param {HTMLImageElement} image
   * @param {Array} panels
   */
  createGeometricFallback(pageIndex, image, panels) {
    return {
      pageIndex,
      assetId: pageAssetId(pageIndex, image),
      panels,
      lines: [],
      balloonGroups: [],
      orderingBoxes: [],
    };
  }

  /** Clears OCR and balloon analysis while preserving detected panels for a retry. */
  clearAnalysis(pageIndex) {
    this._analysisVersions.set(pageIndex, (this._analysisVersions.get(pageIndex) || 0) + 1);
    this._baseRequests.delete(pageIndex);
  }

  /** @param {number} pageIndex */
  clearPage(pageIndex) {
    this._pageVersions.set(pageIndex, (this._pageVersions.get(pageIndex) || 0) + 1);
    this._analysisVersions.set(pageIndex, (this._analysisVersions.get(pageIndex) || 0) + 1);
    this._baseRequests.delete(pageIndex);
    this._panels.delete(pageIndex);
    this._panelRequests.delete(pageIndex);
    this._panelFailures.delete(pageIndex);
  }

  /** Invalidates every option-dependent page cache, including preloaded pages. */
  clearAllPages() {
    this._generation++;
    this._baseRequests.clear();
    this._panels.clear();
    this._panelRequests.clear();
    this._panelFailures.clear();
    this._pageVersions.clear();
    this._analysisVersions.clear();
  }

  destroy() {
    this._generation++;
    this._baseRequests.clear();
    this._panels.clear();
    this._panelRequests.clear();
    this._panelFailures.clear();
    this._pageVersions.clear();
    this._analysisVersions.clear();
    this._panelDetectorPromise = null;
  }

  _isCurrentPanelRequest(pageIndex, entry) {
    const current = this._panelRequests.get(pageIndex);
    return this._generation === entry.generation
      && this._pageVersions.get(pageIndex) === entry.version
      && current === entry;
  }

  _isCurrentAnalysisRequest(pageIndex, entry) {
    const current = this._baseRequests.get(pageIndex);
    return this._generation === entry.generation
      && this._analysisVersions.get(pageIndex) === entry.version
      && current === entry;
  }
}

/**
 * Applies user reading preferences without mutating or repeating base analysis.
 * @param {{pageIndex:number,panels:Array,lines:Array,balloonGroups:Array,orderingBoxes:Array}} base
 * @param {{readingDirection:"rtl"|"ltr",ignoreSingleWord:boolean,ignoreColouredText:boolean,dialogueOnly:boolean,revealMode:"balloon"|"line"|"word"|"letter"}} profile
 */
export function derivePageReadingData(base, profile) {
  const readingDirection = profile.readingDirection === "ltr" ? "ltr" : "rtl";
  const revealMode = normalizeRevealMode(profile.revealMode);
  const balloonGroups = base.balloonGroups.map((group) => ({
    ...group,
    lines: group.lines.slice(),
    selectedRevealCoverColor: profile.ignoreColouredText
      ? group.colourFilteredRevealCoverColor
      : group.revealCoverColor,
  }));
  const selectedGroups = profile.dialogueOnly
    ? balloonGroups.filter(isDialogueBalloon)
    : balloonGroups;
  const groupByLine = new Map();
  selectedGroups.forEach((group) => {
    group.lines.forEach((line) => groupByLine.set(line, group));
  });
  const eligibleLines = base.lines.filter((line) => shouldUseTextLine(
    line,
    groupByLine.get(line),
    profile.ignoreSingleWord,
    profile.ignoreColouredText,
    profile.dialogueOnly
  ));
  const balloons = orderTextItems(selectedGroups, base.panels, readingDirection);
  const detectedBalloons = [];
  const balloonIdByLine = new Map();
  balloons.forEach((balloon) => {
    const orderingBounds = orderingBoundsFor(balloon);
    const textBounds = boundsFromPoly(balloon.poly);
    const panelIndex = findBestPanelIndex(textBounds, base.panels);
    let detected = detectedBalloons.find((candidate) => (
      candidate.panelIndex === panelIndex
      && candidate.bounds.every((bounds) => sameBalloonOrderingBounds(bounds, orderingBounds))
    ));
    if (!detected) {
      detected = {
        id: base.pageIndex + ":director-balloon:" + detectedBalloons.length,
        panelIndex,
        bounds: [],
      };
      detectedBalloons.push(detected);
    }
    detected.bounds.push(orderingBounds);
    balloon.directorBalloonId = detected.id;
    balloon.lines.forEach((line) => balloonIdByLine.set(line, detected.id));
  });
  const sources = createRevealSources(
    base.pageIndex,
    eligibleLines,
    selectedGroups,
    revealMode,
    base.panels,
    balloonIdByLine,
    readingDirection
  );
  return {
    eligibleLines,
    sources,
    balloons,
    balloonIdByLine,
    frameBalloons: createFrameBalloons(balloons, eligibleLines, sources),
    // The overlay is a Director aid: its labels must match the route order,
    // not Paddle's incidental detection order.
    orderingBoxes: createOrderingDebugBoxes(balloons),
  };
}

/** @param {unknown} value */
export function normalizeRevealMode(value) {
  return ["balloon", "line", "word", "letter"].includes(value) ? value : "balloon";
}

/** @param {Array<Array<number>>} points */
export function boundsFromPoly(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const xs = points.map((point) => Number(point && point[0]));
  const ys = points.map((point) => Number(point && point[1]));
  if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) return null;
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

/** @param {string} text */
export function characterCount(text) {
  return [...String(text || "").replace(/\s/g, "")].length;
}

function wholePagePanel(image) {
  return {
    x: 0,
    y: 0,
    w: image.naturalWidth,
    h: image.naturalHeight,
    kind: "panel",
    order: 1,
  };
}

function pageAssetId(pageIndex, image) {
  return String(image.currentSrc || image.src || pageIndex);
}

function isRecognizedTextLine(item) {
  return !!item && typeof item.text === "string" && item.text.trim() && Array.isArray(item.poly);
}

function isValidatedPaddleLine(line) {
  const bounds = boundsFromPoly(line.poly);
  if (!bounds) return false;
  const letters = (String(line.text || "").match(/[a-z]/gi) || []).length;
  const confidence = Number(line.score || 0) * 100;
  return letters >= 2 && confidence >= 60 && bounds.bottom - bounds.top >= 10;
}

function groupLinesIntoBalloons(lines) {
  const valid = lines.map((line) => ({ line, bounds: boundsFromPoly(line.poly) })).filter((item) => item.bounds);
  const lineHeights = valid
    .map((item) => item.bounds.bottom - item.bounds.top)
    .sort((first, second) => first - second);
  const medianLineHeight = lineHeights[Math.floor(lineHeights.length / 2)] || 1;
  const maximumGap = Math.max(18, medianLineHeight * 1.5);
  const groups = [];

  valid.slice().sort((first, second) => (
    first.bounds.top - second.bounds.top || second.bounds.right - first.bounds.right
  )).forEach((item) => {
    const group = groups.find((candidate) => {
      const previous = candidate.items[candidate.items.length - 1];
      const verticalGap = item.bounds.top - previous.bounds.bottom;
      const horizontalOverlap = Math.max(
        0,
        Math.min(item.bounds.right, previous.bounds.right) - Math.max(item.bounds.left, previous.bounds.left)
      );
      const narrowestLine = Math.max(1, Math.min(
        item.bounds.right - item.bounds.left,
        previous.bounds.right - previous.bounds.left
      ));
      // Paddle line boxes can overlap vertically even for plainly stacked
      // lines in one balloon; accept that overlap within the normal line gap.
      return verticalGap >= -maximumGap && verticalGap <= maximumGap && horizontalOverlap / narrowestLine >= .25;
    });
    if (group) group.items.push(item);
    else groups.push({ items: [item] });
  });

  const ids = new Map();
  groups.forEach((group, groupIndex) => {
    group.items.forEach((item) => ids.set(item.line, groupIndex));
  });
  return ids;
}

function buildBalloonGroups(lines) {
  const groupIds = groupLinesIntoBalloons(lines);
  const groups = new Map();
  lines.forEach((line, index) => {
    const knownGroupId = groupIds.get(line);
    const groupId = knownGroupId === undefined ? "line:" + index : knownGroupId;
    if (!groups.has(groupId)) groups.set(groupId, []);
    groups.get(groupId).push(line);
  });
  return [...groups.values()].map(mergeBalloonLines).filter(Boolean).map((group) => {
    const groupBounds = boundsFromPoly(group.poly);
    group.lines.forEach((line) => { line.balloonOrderingBounds = groupBounds; });
    return group;
  });
}

function mergeBalloonLines(lines) {
  if (!lines.length) return null;
  const orderedLines = lines.slice().sort((firstLine, secondLine) => {
    const first = boundsFromPoly(firstLine.poly);
    const second = boundsFromPoly(secondLine.poly);
    return first.top - second.top || second.right - first.right;
  });
  const bounds = orderedLines.map((line) => boundsFromPoly(line.poly)).filter(Boolean);
  if (!bounds.length) return null;
  const left = Math.min(...bounds.map((box) => box.left));
  const right = Math.max(...bounds.map((box) => box.right));
  const top = Math.min(...bounds.map((box) => box.top));
  const bottom = Math.max(...bounds.map((box) => box.bottom));
  return {
    lines: orderedLines,
    text: orderedLines.map((line) => line.text.trim()).join(" "),
    score: orderedLines.reduce((total, line) => total + Number(line.score || 0), 0) / orderedLines.length,
    poly: [[left, top], [right, top], [right, bottom], [left, bottom]],
  };
}

async function attachBalloonOrderingBounds(image, balloonGroups, createEdgeDetector) {
  const detectBalloonEdge = await createEdgeDetector(image);
  if (!detectBalloonEdge) return;
  balloonGroups.forEach((group) => {
    const padding = detectBalloonEdge.inspectPadding(group.poly);
    if (padding) {
      group.textBounds = padding.textBounds;
      group.paddingBounds = padding.paddingBounds;
      group.paddingLuminance = padding.luminance;
      group.horizontalPadding = padding.horizontalPadding;
      group.verticalPadding = padding.verticalPadding;
    }
    const bounds = detectBalloonEdge(group.poly);
    if (!bounds) return;
    group.orderingBounds = bounds;
    group.lines.forEach((line) => { line.balloonOrderingBounds = bounds; });
  });
}

function createOrderingDebugBoxes(balloonGroups) {
  return balloonGroups.map((group, index) => ({
    id: index,
    text: group.text,
    // Debug exposes the raw flood-fill boundary, not a derived ordering union.
    bounds: group.balloonOrderingBounds || group.orderingBounds || orderingBoundsFor(group),
    textBounds: group.textBounds,
    paddingBounds: group.paddingBounds,
    paddingLuminance: group.paddingLuminance,
    horizontalPadding: group.horizontalPadding,
    verticalPadding: group.verticalPadding,
  })).filter((box) => box.bounds);
}

function shouldUseTextLine(line, balloonGroup, ignoreSingleWord, ignoreColouredText, dialogueOnly) {
  if (dialogueOnly && !isDialogueBalloon(balloonGroup)) return false;
  if (ignoreSingleWord && balloonGroup && wordCount(balloonGroup.text) === 1) return false;
  if (ignoreColouredText && (!line.appearance.hasWhitish || line.appearance.hasColour)) return false;
  return true;
}

function isDialogueBalloon(group) {
  return !!group && (group.paddingLuminance > 195 || group.paddingLuminance < 60);
}

function createRevealSources(pageIndex, eligibleLines, balloonGroups, revealMode, panels, balloonIdByLine, readingDirection) {
  if (revealMode === "balloon") {
    const eligibleSet = new Set(eligibleLines);
    const balloons = balloonGroups.map((group) => {
      const balloon = mergeBalloonLines(group.lines.filter((line) => eligibleSet.has(line)));
      if (!balloon) return null;
      balloon.directorBalloonId = group.directorBalloonId;
      balloon.coverColor = group.selectedRevealCoverColor;
      if (group.orderingBounds) balloon.orderingBounds = group.orderingBounds;
      return balloon;
    }).filter(Boolean);
    return orderTextItems(balloons, panels, readingDirection).map((balloon, index) => ({
      id: pageIndex + ":balloon:" + index,
      unitId: pageIndex + ":balloon-unit:" + balloon.directorBalloonId,
      directorBalloonId: balloon.directorBalloonId,
      panelOrder: findBestPanelOrder(orderingBoundsFor(balloon), panels),
      line: balloon,
      poly: balloon.poly,
      text: balloon.text,
      color: balloon.coverColor,
    }));
  }

  const sources = [];
  orderTextItems(eligibleLines, panels, readingDirection).forEach((line, lineIndex) => {
    const segments = revealMode === "word" || revealMode === "letter"
      ? splitTextLine(line, revealMode)
      : [{ text: line.text, poly: line.poly }];
    segments.forEach((segment, segmentIndex) => {
      const id = pageIndex + ":" + lineIndex + ":" + segmentIndex;
      sources.push({
        id,
        unitId: revealMode === "line" ? pageIndex + ":line:" + lineIndex : id,
        directorBalloonId: balloonIdByLine.get(line),
        panelOrder: findBestPanelOrder(orderingBoundsFor(line), panels),
        line,
        poly: segment.poly,
        text: segment.text,
        color: line.appearance.coverColor,
      });
    });
  });
  return sources;
}

function createFrameBalloons(balloons, eligibleLines, sources) {
  const eligibleSet = new Set(eligibleLines);
  const physicalBalloons = [];
  balloons.forEach((balloon) => {
    let physical = physicalBalloons.find((candidate) => candidate.id === balloon.directorBalloonId);
    if (!physical) {
      physical = { id: balloon.directorBalloonId, groups: [] };
      physicalBalloons.push(physical);
    }
    physical.groups.push(balloon);
  });

  return physicalBalloons.map((physical) => {
    const lines = physical.groups.flatMap((group) => group.lines).filter((line) => eligibleSet.has(line));
    const merged = mergeBalloonLines(lines);
    const box = merged ? boundsFromPoly(merged.poly) : null;
    if (!box) return null;
    const heights = lines.map((line) => {
      const lineBounds = boundsFromPoly(line.poly);
      return lineBounds ? lineBounds.bottom - lineBounds.top : 0;
    }).filter((height) => height > 0).sort((first, second) => first - second);
    if (!heights.length) return null;
    const orderingBounds = physical.groups.map(orderingBoundsFor).filter(Boolean);
    const revealUnitIds = [...new Set(sources
      .filter((source) => source.directorBalloonId === physical.id)
      .map((source) => source.unitId))];
    return {
      id: physical.id,
      box,
      orderingBox: unionReaderBounds(orderingBounds),
      lineHeight: heights[Math.floor(heights.length / 2)],
      readingText: merged.text,
      paragraphCount: physical.groups.length,
      revealUnitIds,
    };
  }).filter(Boolean);
}

function orderingBoundsFor(item) {
  return item.orderingBounds || item.balloonOrderingBounds || boundsFromPoly(item.poly);
}

function unionReaderBounds(bounds) {
  if (!bounds.length) return null;
  return {
    left: Math.min(...bounds.map((item) => item.left)),
    right: Math.max(...bounds.map((item) => item.right)),
    top: Math.min(...bounds.map((item) => item.top)),
    bottom: Math.max(...bounds.map((item) => item.bottom)),
  };
}

function findBestPanelOrder(bounds, panels) {
  if (!bounds) return null;
  const index = findBestPanelIndex(bounds, panels);
  const panel = panels[index];
  return panel && panel.order !== undefined ? panel.order : null;
}

function splitTextLine(line, mode) {
  const text = String(line.text || "");
  const spans = [];
  if (mode === "word") {
    for (const match of text.matchAll(/\S+/g)) {
      spans.push({ text: match[0], start: match.index, end: match.index + match[0].length });
    }
  } else {
    let offset = 0;
    for (const character of Array.from(text)) {
      const start = offset;
      offset += character.length;
      if (!/\s/u.test(character)) spans.push({ text: character, start, end: offset });
    }
  }
  const length = Math.max(1, text.length);
  return spans.map((span) => ({
    text: span.text,
    poly: slicePoly(line.poly, span.start / length, span.end / length),
  })).filter((segment) => segment.poly);
}

function slicePoly(poly, start, end) {
  if (!Array.isArray(poly) || poly.length < 4) return null;
  const points = poly.slice(0, 4).map((point) => [Number(point && point[0]), Number(point && point[1])]);
  if (points.flat().some((value) => !Number.isFinite(value))) return null;
  const topLength = Math.hypot(points[1][0] - points[0][0], points[1][1] - points[0][1]);
  const sideLength = Math.hypot(points[3][0] - points[0][0], points[3][1] - points[0][1]);
  if (topLength >= sideLength) {
    return [
      interpolatePoint(points[0], points[1], start),
      interpolatePoint(points[0], points[1], end),
      interpolatePoint(points[3], points[2], end),
      interpolatePoint(points[3], points[2], start),
    ];
  }
  return [
    interpolatePoint(points[0], points[3], start),
    interpolatePoint(points[1], points[2], start),
    interpolatePoint(points[1], points[2], end),
    interpolatePoint(points[0], points[3], end),
  ];
}

function interpolatePoint(from, to, progress) {
  return [
    from[0] + (to[0] - from[0]) * progress,
    from[1] + (to[1] - from[1]) * progress,
  ];
}

function analyzeTextLineAppearance(image, line) {
  const fallback = { coverColor: "rgb(255, 255, 255)", hasWhitish: true, hasColour: false };
  const bounds = boundsFromPoly(line.poly);
  if (!bounds) return fallback;
  const left = Math.max(0, Math.floor(bounds.left));
  const top = Math.max(0, Math.floor(bounds.top));
  const right = Math.min(image.naturalWidth, Math.ceil(bounds.right));
  const bottom = Math.min(image.naturalHeight, Math.ceil(bounds.bottom));
  const width = right - left;
  const height = bottom - top;
  if (width <= 0 || height <= 0) return fallback;

  try {
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, left, top, width, height, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height).data;
    const pixelCount = pixels.length / 4;
    const whitishThreshold = Math.max(1, Math.ceil(pixelCount * .01));
    const colourThreshold = Math.max(3, Math.ceil(pixelCount * .003));
    let whitishPixels = 0;
    let colourPixels = 0;
    let lightest = [255, 255, 255];
    let highestLuminance = -1;

    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] === 0) continue;
      const red = pixels[index];
      const green = pixels[index + 1];
      const blue = pixels[index + 2];
      const maximum = Math.max(red, green, blue);
      const minimum = Math.min(red, green, blue);
      const luminance = red * .2126 + green * .7152 + blue * .0722;
      if (red >= 210 && green >= 210 && blue >= 210 && maximum - minimum <= 24) whitishPixels++;
      if (maximum - minimum >= 40 && maximum >= 70 && luminance >= 25 && luminance <= 240) colourPixels++;
      if (luminance > highestLuminance) {
        highestLuminance = luminance;
        lightest = [red, green, blue];
      }
    }
    return {
      coverColor: "rgb(" + lightest.join(", ") + ")",
      hasWhitish: whitishPixels >= whitishThreshold,
      hasColour: colourPixels >= colourThreshold,
    };
  } catch {
    return fallback;
  }
}

function wordCount(text) {
  const normalized = String(text || "").trim();
  return normalized ? normalized.split(/\s+/).length : 0;
}

export const COMFORTABLE_TEXT_HEIGHT = 20;

/**
 * Builds panel-reader frames that keep detected balloon bounds whole while
 * adapting their zoom to the rendered reader viewport. CSS pixels are the
 * appropriate measurement here: browser and OS scaling already normalize
 * them across phones, tablets, and desktop displays.
 *
 * @param {Array<{x:number,y:number,w:number,h:number,order?:number}>} panels
 * @param {Array<{box:{left:number,right:number,top:number,bottom:number},lineHeight:number}>} balloons
 * @param {{imageWidth:number,imageHeight:number,viewportWidth:number,viewportHeight:number,minZoom:number,maxZoom:number,padding:number,artworkOmittedFraction?:number,maxFullViewZoomDelta?:number}} context
 * @returns {Array<{x:number,y:number,w:number,h:number,order?:number,sourcePanelIndex:number,partIndex:number,partCount:number,zoom:number,kind?:string}>}
 */
export function planReadablePanelFrames(panels, balloons, context) {
  if (!hasUsableContext(context)) return createWholePanelFrames(panels, context && context.minZoom || 1);

  const scale = Math.min(
    context.viewportWidth / context.imageWidth,
    context.viewportHeight / context.imageHeight
  );
  const panelBalloons = assignBalloonsToPanels(panels, balloons || []);
  const frames = [];

  for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
    const panel = panels[panelIndex];
    const assigned = panelBalloons[panelIndex];
    const planned = planPanelFrames(panel, assigned, context, scale);
    for (let frameIndex = 0; frameIndex < planned.length; frameIndex++) {
      const frame = planned[frameIndex];
      frames.push({
        x: frame.x,
        y: frame.y,
        w: frame.w,
        h: frame.h,
        order: panel.order,
        sourcePanelIndex: panelIndex,
        partIndex: frameIndex,
        partCount: planned.length,
        zoom: frame.zoom,
        kind: frame.kind,
      });
    }
  }

  return frames;
}

function hasUsableContext(context) {
  return context
    && context.imageWidth > 0
    && context.imageHeight > 0
    && context.viewportWidth > 0
    && context.viewportHeight > 0;
}

function createWholePanelFrames(panels, zoom) {
  return panels.map((panel, panelIndex) => ({
    x: panel.x,
    y: panel.y,
    w: panel.w,
    h: panel.h,
    order: panel.order,
    sourcePanelIndex: panelIndex,
    partIndex: 0,
    partCount: 1,
    zoom,
  }));
}

function assignBalloonsToPanels(panels, balloons) {
  const assigned = panels.map(() => []);
  for (let balloonIndex = 0; balloonIndex < balloons.length; balloonIndex++) {
    const balloon = balloons[balloonIndex];
    if (!isValidBalloon(balloon)) continue;
    let intersectsPanel = false;
    for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
      if (overlapArea(balloon.box, panelBounds(panels[panelIndex])) <= 0) continue;
      assigned[panelIndex].push(balloon);
      intersectsPanel = true;
    }
    if (!intersectsPanel) {
      const panelIndex = findNearestPanelIndex(balloon.box, panels);
      if (panelIndex >= 0) assigned[panelIndex].push(balloon);
    }
  }
  return assigned;
}

function isValidBalloon(balloon) {
  const box = balloon && balloon.box;
  return box
    && Number.isFinite(box.left)
    && Number.isFinite(box.right)
    && Number.isFinite(box.top)
    && Number.isFinite(box.bottom)
    && box.right > box.left
    && box.bottom > box.top;
}

function findNearestPanelIndex(box, panels) {
  const centerX = (box.left + box.right) / 2;
  const centerY = (box.top + box.bottom) / 2;
  let nearestIndex = -1;
  let nearestDistance = Infinity;
  for (let panelIndex = 0; panelIndex < panels.length; panelIndex++) {
    const bounds = panelBounds(panels[panelIndex]);
    const panelCenterX = (bounds.left + bounds.right) / 2;
    const panelCenterY = (bounds.top + bounds.bottom) / 2;
    const distance = Math.hypot(centerX - panelCenterX, centerY - panelCenterY);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestIndex = panelIndex;
    }
  }
  return nearestIndex;
}

function panelBounds(panel) {
  return {
    left: panel.x,
    right: panel.x + panel.w,
    top: panel.y,
    bottom: panel.y + panel.h,
  };
}

function containsBounds(outer, inner) {
  return outer.left <= inner.left
    && outer.right >= inner.right
    && outer.top <= inner.top
    && outer.bottom >= inner.bottom;
}

function overlapArea(first, second) {
  const width = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
  const height = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
  return width * height;
}

function planPanelFrames(panel, balloons, context, scale) {
  const wholePanel = panelBounds(panel);
  if (!balloons.length) return [createFrame(wholePanel, [], context, scale)];

  const requiredZoom = balloons.reduce((maximum, balloon) => Math.max(maximum, balloonComfortZoom(balloon, scale, context)), context.minZoom);
  const panelZoom = fitZoom(wholePanel, context, scale);
  const containsEveryBalloon = balloons.every((balloon) => containsBounds(wholePanel, balloon.box));
  if (panelZoom >= requiredZoom && containsEveryBalloon) return [createFrame(wholePanel, balloons, context, scale)];

  const groups = [];
  let group = [];
  for (let balloonIndex = 0; balloonIndex < balloons.length; balloonIndex++) {
    const balloon = balloons[balloonIndex];
    const candidate = group.concat(balloon);
    const candidateBounds = readableBounds(candidate, context, scale);
    const candidateRequiredZoom = candidate.reduce((maximum, item) => Math.max(maximum, balloonComfortZoom(item, scale, context)), context.minZoom);
    if (group.length && fitZoom(candidateBounds, context, scale) < candidateRequiredZoom) {
      groups.push(group);
      group = [balloon];
    } else {
      group = candidate;
    }
  }
  if (group.length) groups.push(group);

  const frames = [];
  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const focus = createFrame(readableBounds(groups[groupIndex], context, scale), groups[groupIndex], context, scale);
    frames.push(expandFocusFrame(focus, wholePanel, context, scale));
  }
  appendArtworkFrames(frames, wholePanel, frames[frames.length - 1], balloons, context, scale);
  return planPanelOverview(wholePanel, frames, context, scale);
}

function planPanelOverview(panel, frames, context, scale) {
  const focus = frames[0];
  const panelArea = (panel.right - panel.left) * (panel.bottom - panel.top);
  const visibleArtwork = overlapArea(panel, frameBounds(focus));
  const omittedArtwork = 1 - visibleArtwork / panelArea;
  const omittedThreshold = context.artworkOmittedFraction || .1;
  if (omittedArtwork <= omittedThreshold) return frames;

  const overviewZoom = Math.max(context.minZoom, Math.min(context.maxZoom, fitZoom(panel, context, scale)));
  const maxFullViewZoomDelta = context.maxFullViewZoomDelta || .4;
  const zoomDelta = Math.abs((overviewZoom - focus.zoom) / focus.zoom);
  const overview = {
    x: panel.left,
    y: panel.top,
    w: panel.right - panel.left,
    h: panel.bottom - panel.top,
    zoom: overviewZoom,
  };
  if (zoomDelta <= maxFullViewZoomDelta) return [overview];

  overview.kind = "overview";
  return [overview].concat(frames);
}

function expandFocusFrame(frame, panel, context, scale) {
  const visibleWidth = context.viewportWidth / (scale * frame.zoom);
  const visibleHeight = context.viewportHeight / (scale * frame.zoom);
  const container = mergeBounds(panel, frameBounds(frame));
  const width = Math.min(container.right - container.left, Math.max(frame.w, visibleWidth));
  const height = Math.min(container.bottom - container.top, Math.max(frame.h, visibleHeight));
  return windowAroundBounds(frameBounds(frame), container, width, height, frame.zoom);
}

function appendArtworkFrames(frames, panel, focus, balloons, context, scale) {
  const visibleWidth = Math.min(panel.right - panel.left, context.viewportWidth / (scale * focus.zoom));
  const visibleHeight = Math.min(panel.bottom - panel.top, context.viewportHeight / (scale * focus.zoom));
  const candidates = [];
  const focusBounds = frameBounds(focus);
  const xStarts = tileStarts(panel.left, panel.right, visibleWidth);
  const yStarts = tileStarts(panel.top, panel.bottom, visibleHeight);

  for (let yIndex = 0; yIndex < yStarts.length; yIndex++) {
    for (let xIndex = 0; xIndex < xStarts.length; xIndex++) {
      const candidate = {
        left: xStarts[xIndex],
        right: Math.min(panel.right, xStarts[xIndex] + visibleWidth),
        top: yStarts[yIndex],
        bottom: Math.min(panel.bottom, yStarts[yIndex] + visibleHeight),
      };
      if (overlapArea(candidate, focusBounds) >= (candidate.right - candidate.left) * (candidate.bottom - candidate.top) * .9) continue;
      if (balloons.some((balloon) => overlapArea(candidate, balloon.box) > 0)) continue;
      candidates.push(candidate);
    }
  }

  candidates.sort((first, second) => distanceFromBounds(first, focusBounds) - distanceFromBounds(second, focusBounds)
    || second.right - first.right
    || first.top - second.top);
  for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
    const candidate = candidates[candidateIndex];
    frames.push({
      x: candidate.left,
      y: candidate.top,
      w: candidate.right - candidate.left,
      h: candidate.bottom - candidate.top,
      zoom: focus.zoom,
    });
  }
}

function tileStarts(start, end, size) {
  if (size >= end - start) return [start];
  const starts = [];
  for (let position = start; position < end - size; position += size) starts.push(position);
  const last = end - size;
  if (starts[starts.length - 1] !== last) starts.push(last);
  return starts;
}

function distanceFromBounds(first, second) {
  const horizontal = Math.max(0, second.left - first.right, first.left - second.right);
  const vertical = Math.max(0, second.top - first.bottom, first.top - second.bottom);
  return horizontal + vertical;
}

function frameBounds(frame) {
  return {
    left: frame.x,
    right: frame.x + frame.w,
    top: frame.y,
    bottom: frame.y + frame.h,
  };
}

function mergeBounds(first, second) {
  return {
    left: Math.min(first.left, second.left),
    right: Math.max(first.right, second.right),
    top: Math.min(first.top, second.top),
    bottom: Math.max(first.bottom, second.bottom),
  };
}

function windowAroundBounds(bounds, container, width, height, zoom) {
  const left = Math.max(container.left, Math.min(
    (bounds.left + bounds.right - width) / 2,
    container.right - width
  ));
  const top = Math.max(container.top, Math.min(
    (bounds.top + bounds.bottom - height) / 2,
    container.bottom - height
  ));
  return { x: left, y: top, w: width, h: height, zoom };
}

function balloonComfortZoom(balloon, scale, context) {
  const lineHeight = Math.max(1, Number(balloon.lineHeight) || 1);
  const required = COMFORTABLE_TEXT_HEIGHT / (lineHeight * scale);
  return Math.max(context.minZoom, Math.min(context.maxZoom, required));
}

function readableBounds(balloons, context, scale) {
  const padded = paddedBounds(balloons, context);
  const requiredZoom = balloons.reduce((maximum, balloon) => Math.max(maximum, balloonComfortZoom(balloon, scale, context)), context.minZoom);
  if (fitZoom(padded, context, scale) >= requiredZoom) return padded;
  // A balloon boundary is the final fallback: it is always whole, and no
  // decorative padding is worth making its detected text smaller than the
  // comfort target.
  return balloonBounds(balloons, context);
}

function paddedBounds(balloons, context) {
  const bounds = balloonBounds(balloons, context);
  let largestLineHeight = 1;
  for (let balloonIndex = 0; balloonIndex < balloons.length; balloonIndex++) {
    largestLineHeight = Math.max(largestLineHeight, Number(balloons[balloonIndex].lineHeight) || 1);
  }
  const padding = Math.max(16, largestLineHeight * 1.5);
  return keepBoundsInsidePage({
    left: bounds.left - padding,
    right: bounds.right + padding,
    top: bounds.top - padding,
    bottom: bounds.bottom + padding,
  }, context);
}

function balloonBounds(balloons, context) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;
  for (let balloonIndex = 0; balloonIndex < balloons.length; balloonIndex++) {
    const box = balloons[balloonIndex].box;
    left = Math.min(left, box.left);
    right = Math.max(right, box.right);
    top = Math.min(top, box.top);
    bottom = Math.max(bottom, box.bottom);
  }
  return keepBoundsInsidePage({ left, right, top, bottom }, context);
}

function keepBoundsInsidePage(bounds, context) {
  const width = Math.min(context.imageWidth, bounds.right - bounds.left);
  const height = Math.min(context.imageHeight, bounds.bottom - bounds.top);
  const left = Math.max(0, Math.min(bounds.left, context.imageWidth - width));
  const top = Math.max(0, Math.min(bounds.top, context.imageHeight - height));
  return { left, right: left + width, top, bottom: top + height };
}

function createFrame(bounds, balloons, context, scale) {
  const requiredZoom = balloons.reduce((maximum, balloon) => Math.max(maximum, balloonComfortZoom(balloon, scale, context)), context.minZoom);
  const fittedZoom = fitZoom(bounds, context, scale);
  const sharpZoom = Math.min(context.maxZoom, 1 / scale);
  const comfortableMaximum = Math.max(requiredZoom, Math.min(sharpZoom, viewportComfortZoom(context)));
  return {
    x: bounds.left,
    y: bounds.top,
    w: bounds.right - bounds.left,
    h: bounds.bottom - bounds.top,
    zoom: Math.max(context.minZoom, Math.min(fittedZoom, comfortableMaximum)),
  };
}

function viewportComfortZoom(context) {
  const shortestSide = Math.min(context.viewportWidth, context.viewportHeight);
  return Math.min(context.maxZoom, Math.max(2.5, Math.min(4, shortestSide / 128)));
}

function fitZoom(bounds, context, scale) {
  return Math.min(
    context.viewportWidth * context.padding / ((bounds.right - bounds.left) * scale),
    context.viewportHeight * context.padding / ((bounds.bottom - bounds.top) * scale)
  );
}

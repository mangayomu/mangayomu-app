/**
 * Orders text units by the containing balloon when its bounds are known.
 * OCR polygons remain the fallback and are not changed by this module.
 *
 * @param {Array<{poly:Array<Array<number>>,orderingBounds?:{left:number,right:number,top:number,bottom:number},balloonOrderingBounds?:{left:number,right:number,top:number,bottom:number}}>} items
 * @param {Array<{x:number,y:number,w:number,h:number}>} panels
 * @param {"rtl"|"ltr"} [readingDirection]
 * @returns {Array}
 */
export function orderTextItems(items, panels, readingDirection = "rtl") {
  const entries = items.map((item, originalIndex) => {
    const textBounds = boundsFromPoly(item.poly);
    const orderingBounds = item.orderingBounds || item.balloonOrderingBounds || textBounds;
    return {
      item,
      textBounds,
      orderingBounds,
      originalIndex,
      // OCR geometry owns panel membership. Flood-fill may legitimately spill
      // into a neighbouring panel and is used only after ownership is known.
      panelIndex: findBestPanelIndex(textBounds, panels),
    };
  }).filter((entry) => entry.textBounds && entry.orderingBounds);

  const balloons = [];
  entries.forEach((entry) => {
    const balloon = balloons.find((candidate) => (
      candidate.panelIndex === entry.panelIndex
      && candidate.entries.every((item) => sameBalloonOrderingBounds(item.orderingBounds, entry.orderingBounds))
    ));
    if (balloon) {
      balloon.entries.push(entry);
      balloon.orderingBounds = unionBounds(balloon.entries.map((item) => item.orderingBounds));
      balloon.textBounds = unionBounds(balloon.entries.map((item) => item.textBounds));
    } else {
      balloons.push({
        panelIndex: entry.panelIndex,
        orderingBounds: entry.orderingBounds,
        textBounds: entry.textBounds,
        entries: [entry],
      });
    }
  });

  balloons.sort((first, second) => {
    if (first.panelIndex !== second.panelIndex) {
      return compareReadingBounds(
        boundsFromPanel(panels[first.panelIndex]) || first.textBounds,
        boundsFromPanel(panels[second.panelIndex]) || second.textBounds,
        readingDirection
      ) || first.panelIndex - second.panelIndex;
    }
    return compareReadingBounds(first.orderingBounds, second.orderingBounds, readingDirection)
      || Math.min(...first.entries.map((entry) => entry.originalIndex))
        - Math.min(...second.entries.map((entry) => entry.originalIndex));
  });

  return balloons.flatMap((balloon) => balloon.entries
    .sort((first, second) => (
      first.textBounds.top - second.textBounds.top
      || second.textBounds.right - first.textBounds.right
      || first.originalIndex - second.originalIndex
    ))
    .map((entry) => entry.item));
}

function compareReadingBounds(first, second, readingDirection, horizontalFirst = first, horizontalSecond = second) {
  const sameRow = sharesReadingRow(first, second);
  const horizontalOrder = readingDirection === "ltr"
    ? horizontalFirst.left - horizontalSecond.left
    : horizontalSecond.right - horizontalFirst.right;
  return (sameRow ? horizontalOrder : first.top - second.top)
    || (sameRow ? first.top - second.top : horizontalOrder);
}

function boundsFromPanel(panel) {
  if (!panel) return null;
  return { left: panel.x, right: panel.x + panel.w, top: panel.y, bottom: panel.y + panel.h };
}

function sharesReadingRow(first, second) {
  const overlap = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
  const shortestHeight = Math.max(1, Math.min(first.bottom - first.top, second.bottom - second.top));
  return overlap / shortestHeight >= .5;
}

export function sameBalloonOrderingBounds(first, second) {
  if (!first || !second) return false;
  const overlapWidth = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
  const overlapHeight = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
  const overlap = overlapWidth * overlapHeight;
  const firstArea = Math.max(1, (first.right - first.left) * (first.bottom - first.top));
  const secondArea = Math.max(1, (second.right - second.left) * (second.bottom - second.top));
  // A flood-fill may swallow a whole panel around a small speech bubble. Full
  // containment alone must not merge those two physical balloons.
  if (Math.max(firstArea, secondArea) / Math.min(firstArea, secondArea) > 2.5) return false;
  return overlap / Math.min(firstArea, secondArea) >= .85;
}

function unionBounds(bounds) {
  return {
    left: Math.min(...bounds.map((item) => item.left)),
    right: Math.max(...bounds.map((item) => item.right)),
    top: Math.min(...bounds.map((item) => item.top)),
    bottom: Math.max(...bounds.map((item) => item.bottom)),
  };
}

export function findBestPanelIndex(bounds, panels) {
  let bestIndex = panels.length;
  let bestOverlap = 0;
  panels.forEach((panel, index) => {
    const overlapWidth = Math.max(0, Math.min(bounds.right, panel.x + panel.w) - Math.max(bounds.left, panel.x));
    const overlapHeight = Math.max(0, Math.min(bounds.bottom, panel.y + panel.h) - Math.max(bounds.top, panel.y));
    const overlap = overlapWidth * overlapHeight;
    if (overlap > bestOverlap) {
      bestOverlap = overlap;
      bestIndex = index;
    }
  });
  return bestIndex;
}

function boundsFromPoly(points) {
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

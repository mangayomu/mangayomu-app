/**
 * Experimental speech-balloon expansion for high-contrast manga pages.
 *
 * OCR gives us text bounds. We flood-fill the connected light regions around
 * those bounds; ink and the balloon outline stop the fill. The result is an
 * axis-aligned balloon bounding box in the source image coordinate space.
 */
export async function createBalloonEdgeDetector(image, options = {}) {
  const width = image?.naturalWidth || image?.width;
  const height = image?.naturalHeight || image?.height;
  if (!width || !height) return null;

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) return null;

  try {
    context.drawImage(image, 0, 0, width, height);
    return createBalloonEdgeDetectorFromImageData(context.getImageData(0, 0, width, height), options);
  } catch {
    // CORS/decoding failures leave the OCR bounds untouched.
    return null;
  }
}

export function createBalloonEdgeDetectorFromImageData(imageData, options = {}) {
  const detect = (poly) => detectBalloonEdge(imageData, poly, options);
  detect.inspectPadding = (poly) => inspectFloodFillPadding(imageData, poly);
  return detect;
}

export function detectBalloonEdge(imageData, poly, {
  lightThreshold = 210,
  seedStep = 6,
  maxPadding = 360,
  maxAreaMultiplier = 36,
} = {}) {
  const originalBounds = boundsFromPoly(poly);
  if (!originalBounds || !imageData || !imageData.data) return null;
  // Flood-fill seeds start in the central half of the OCR box. The separate
  // expanded padding region below is only for reveal/graphic-text analysis.
  const sourceBounds = expandBounds(originalBounds, .5);

  const imageWidth = imageData.width;
  const imageHeight = imageData.height;
  const textWidth = Math.max(1, originalBounds.right - originalBounds.left);
  const textHeight = Math.max(1, originalBounds.bottom - originalBounds.top);
  const padding = Math.min(maxPadding, Math.max(32, Math.max(textWidth, textHeight) * 2));
  const left = Math.max(0, Math.floor(sourceBounds.left - padding));
  const top = Math.max(0, Math.floor(sourceBounds.top - padding));
  const right = Math.min(imageWidth, Math.ceil(sourceBounds.right + padding));
  const bottom = Math.min(imageHeight, Math.ceil(sourceBounds.bottom + padding));
  const regionWidth = right - left;
  const regionHeight = bottom - top;
  if (regionWidth <= 0 || regionHeight <= 0) return null;

  const visited = new Uint8Array(regionWidth * regionHeight);
  const queue = new Int32Array(regionWidth * regionHeight);
  let head = 0;
  let tail = 0;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const indexAt = (x, y) => (y - top) * regionWidth + (x - left);
  const isLight = (x, y) => {
    const offset = (y * imageWidth + x) * 4;
    const red = imageData.data[offset];
    const green = imageData.data[offset + 1];
    const blue = imageData.data[offset + 2];
    // White/grey balloon interiors are accepted; saturated coloured art is not.
    const luminance = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    return luminance >= lightThreshold && Math.max(red, green, blue) - Math.min(red, green, blue) <= 48;
  };
  const enqueue = (x, y) => {
    if (x < left || x >= right || y < top || y >= bottom) return;
    const index = indexAt(x, y);
    if (visited[index] || !isLight(x, y)) return;
    visited[index] = 1;
    queue[tail++] = index;
  };

  // Text ink can divide an otherwise white balloon. Several seeds across the
  // OCR bounds collect the separated white regions without crossing its outline.
  for (let y = Math.floor(sourceBounds.top) - seedStep; y <= Math.ceil(sourceBounds.bottom) + seedStep; y += seedStep) {
    for (let x = Math.floor(sourceBounds.left) - seedStep; x <= Math.ceil(sourceBounds.right) + seedStep; x += seedStep) {
      enqueue(x, y);
    }
  }

  while (head < tail) {
    const index = queue[head++];
    const x = left + index % regionWidth;
    const y = top + Math.floor(index / regionWidth);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    enqueue(x - 1, y);
    enqueue(x + 1, y);
    enqueue(x, y - 1);
    enqueue(x, y + 1);
  }

  if (!Number.isFinite(minX)) return null;
  const detected = { left: minX, top: minY, right: maxX + 1, bottom: maxY + 1 };
  const detectedArea = (detected.right - detected.left) * (detected.bottom - detected.top);
  const textArea = textWidth * textHeight;
  if (detectedArea < textArea || detectedArea > textArea * maxAreaMultiplier) return null;
  return detected;
}

function inspectFloodFillPadding(imageData, poly) {
  const textBounds = boundsFromPoly(poly);
  if (!textBounds || !imageData || !imageData.data) return null;
  const paddingBounds = clampBounds(expandBounds(textBounds, 1.1), imageData.width, imageData.height);
  let red = 0;
  let green = 0;
  let blue = 0;
  let count = 0;
  for (let y = Math.floor(paddingBounds.top); y < Math.ceil(paddingBounds.bottom); y++) {
    for (let x = Math.floor(paddingBounds.left); x < Math.ceil(paddingBounds.right); x++) {
      if (x >= textBounds.left && x <= textBounds.right && y >= textBounds.top && y <= textBounds.bottom) continue;
      const offset = (y * imageData.width + x) * 4;
      red += imageData.data[offset];
      green += imageData.data[offset + 1];
      blue += imageData.data[offset + 2];
      count++;
    }
  }
  if (!count) return null;
  const averageRed = red / count;
  const averageGreen = green / count;
  const averageBlue = blue / count;
  return {
    textBounds,
    paddingBounds,
    horizontalPadding: Math.round((paddingBounds.right - paddingBounds.left - (textBounds.right - textBounds.left)) / 2),
    verticalPadding: Math.round((paddingBounds.bottom - paddingBounds.top - (textBounds.bottom - textBounds.top)) / 2),
    luminance: Math.round(averageRed * .2126 + averageGreen * .7152 + averageBlue * .0722),
  };
}

function expandBounds(bounds, factor) {
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  const halfWidth = (bounds.right - bounds.left) * factor / 2;
  const halfHeight = (bounds.bottom - bounds.top) * factor / 2;
  return {
    left: centerX - halfWidth,
    right: centerX + halfWidth,
    top: centerY - halfHeight,
    bottom: centerY + halfHeight,
  };
}

function clampBounds(bounds, width, height) {
  return {
    left: Math.max(0, bounds.left),
    right: Math.min(width, bounds.right),
    top: Math.max(0, bounds.top),
    bottom: Math.min(height, bounds.bottom),
  };
}

function boundsFromPoly(points) {
  if (!Array.isArray(points) || !points.length) return null;
  const xs = points.map((point) => Number(point?.[0]));
  const ys = points.map((point) => Number(point?.[1]));
  if (xs.some((value) => !Number.isFinite(value)) || ys.some((value) => !Number.isFinite(value))) return null;
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  };
}

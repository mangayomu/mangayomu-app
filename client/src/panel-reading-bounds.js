/**
 * Expands a detected panel only when a reading balloon visibly crosses it.
 * Detection remains untouched; this bound is for camera, spotlight, and reveal.
 */
export function panelReadingBounds(panel, subjects, image = {}) {
  let bounds = boundsFromPanel(panel);
  subjects.forEach((subject) => {
    const envelope = balloonEnvelopeBounds(subject);
    if (!envelope) return;
    bounds = {
      left: Math.min(bounds.left, envelope.left),
      top: Math.min(bounds.top, envelope.top),
      right: Math.max(bounds.right, envelope.right),
      bottom: Math.max(bounds.bottom, envelope.bottom),
    };
  });
  return clampBounds(bounds, image.naturalWidth || image.width, image.naturalHeight || image.height);
}

/** A focused reading spotlight: only the active balloons, never a detector panel. */
export function readingFocusBounds(subjects, image = {}) {
  let bounds = null;
  subjects.forEach((subject) => {
    const envelope = balloonEnvelopeBounds(subject);
    if (!envelope) return;
    bounds = bounds ? {
      left: Math.min(bounds.left, envelope.left),
      top: Math.min(bounds.top, envelope.top),
      right: Math.max(bounds.right, envelope.right),
      bottom: Math.max(bounds.bottom, envelope.bottom),
    } : envelope;
  });
  return bounds && clampBounds(bounds, image.naturalWidth || image.width, image.naturalHeight || image.height);
}

export function balloonEnvelopeBounds(subject) {
  const text = subject?.box;
  if (!isBounds(text)) return null;
  // Flood-fill ordering bounds frequently describe the surrounding panel,
  // not the physical speech bubble. They must never drive camera or dimmer geometry.
  const padding = Math.max(32, Math.min(160, Math.max(text.right - text.left, text.bottom - text.top) * .6));
  return {
    left: text.left - padding,
    top: text.top - padding,
    right: text.right + padding,
    bottom: text.bottom + padding,
  };
}

function boundsFromPanel(panel) {
  return {
    left: Number(panel?.x) || 0,
    top: Number(panel?.y) || 0,
    right: (Number(panel?.x) || 0) + Math.max(1, Number(panel?.w) || 1),
    bottom: (Number(panel?.y) || 0) + Math.max(1, Number(panel?.h) || 1),
  };
}

function clampBounds(bounds, width, height) {
  if (!width || !height) return bounds;
  return {
    left: Math.max(0, bounds.left),
    top: Math.max(0, bounds.top),
    right: Math.min(width, bounds.right),
    bottom: Math.min(height, bounds.bottom),
  };
}

function isBounds(bounds) {
  return bounds && Number.isFinite(bounds.left) && Number.isFinite(bounds.top)
    && Number.isFinite(bounds.right) && Number.isFinite(bounds.bottom)
    && bounds.right > bounds.left && bounds.bottom > bounds.top;
}

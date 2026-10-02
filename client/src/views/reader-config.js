export const TAP_THRESHOLD = 30;
export const MIN_ZOOM = 1;
export const MAX_ZOOM = 5;
export const ZOOM_STEP = 0.1;
export const WHEEL_ZOOM_SENSITIVITY = 0.01;

export const STORAGE_KEY = "manga-reading-mode";
export const ZOOM_STORAGE_KEY = "manga-zoom";

export const PANEL_FRAME_DURATION = 350;
export const PANEL_FRAME_PADDING = 0.95;
export const PANEL_ARTWORK_OMITTED_FRACTION = 0.1;
export const PANEL_MAX_FULL_VIEW_ZOOM_DELTA = 0.4;
export const PANEL_OVERVIEW_DURATION = 1500;
export const PANEL_FINAL_READING_PAUSE_MS = 800;
export const READER_REVEAL_TIMING_DEBUG = false;

export const DIRECTOR_COMPOSITION_PROFILES = {
  phone: { maxShortestSide: 599, zoom: 1.35 },
  tablet: { maxShortestSide: 959, zoom: 1.2 },
  desktop: { maxShortestSide: Infinity, zoom: 1.1 },
};

/** Returns the fixed, artwork-inclusive Director zoom for the current device class. */
export function directorCompositionProfile(viewportWidth, viewportHeight) {
  const shortestSide = Math.min(viewportWidth, viewportHeight);
  const longestSide = Math.max(viewportWidth, viewportHeight);
  if (shortestSide <= DIRECTOR_COMPOSITION_PROFILES.phone.maxShortestSide) return "phone";
  if (longestSide >= 1200 || longestSide / shortestSide >= 1.4) return "desktop";
  return "tablet";
}

export function directorCompositionZoom(viewportWidth, viewportHeight) {
  return DIRECTOR_COMPOSITION_PROFILES[directorCompositionProfile(viewportWidth, viewportHeight)].zoom;
}

export const MODES = [
  { id: "vertical", label: "Vertical Scroll", icon: "unfold_more" },
  { id: "ltr", label: "Left to Right", icon: "arrow_forward" },
  { id: "rtl", label: "Right to Left", icon: "arrow_back" },
  { id: "panels", label: "Panel by Panel", icon: "grid_view" },
];

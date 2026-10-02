export const DEFAULT_PANEL_PREFERENCES = Object.freeze({
  cameraStrategy: "director",
  readingDirection: "rtl",
  timingPolicy: "text",
  readingPaceMultiplier: 1,
  minimumHoldSeconds: 2,
  ignoreSingleWord: true,
  ignoreColouredText: false,
  dialogueOnly: false,
  revealEnabled: false,
  revealMode: "balloon",
  showPlaybackProgress: false,
  showDirectorPlanningLog: false,
  movementDurationMs: 800,
  panelSecondPass: false,
  directorZoom: null,
});

const STORAGE_KEYS = Object.freeze({
  cameraStrategy: "manga-panel-camera-strategy",
  readingDirection: "manga-panel-reading-direction",
  timingPolicy: "manga-panel-timing-policy",
  readingPaceMultiplier: "manga-panel-reading-pace-multiplier",
  minimumHoldSeconds: "manga-panel-minimum-hold-seconds",
  ignoreSingleWord: "manga-panel-ignore-single-word",
  ignoreColouredText: "manga-panel-ignore-coloured-text",
  dialogueOnly: "manga-panel-dialogue-only",
  revealEnabled: "manga-panel-reveal-enabled",
  revealMode: "manga-panel-reveal-mode",
  showPlaybackProgress: "manga-panel-show-playback-progress",
  showDirectorPlanningLog: "manga-panel-show-director-planning-log",
  movementDurationMs: "manga-panel-movement-duration-ms",
  panelSecondPass: "manga-panel-second-pass",
  directorZoom: "manga-panel-director-zoom",
  analysisDebug: "manga-reader-analysis-debug",
});

const LEGACY_KEYS = Object.freeze({
  cameraStrategy: "manga-auto-skip-camera-mode",
  readingDirection: "manga-auto-skip-reading-direction",
  timingPolicy: "manga-auto-skip-method",
  readingPaceMultiplier: "manga-auto-skip-multiplier",
  minimumHoldSeconds: "manga-auto-skip-min-seconds",
  ignoreSingleWord: "manga-auto-skip-single-word",
  ignoreColouredText: "manga-auto-skip-coloured-words",
  dialogueOnly: "manga-auto-skip-focus-dialogue",
  revealEnabled: "manga-auto-skip-progressive-reveal",
  revealMode: "manga-auto-skip-reveal-mode",
  showPlaybackProgress: "manga-auto-skip-show-progress",
  movementDurationMs: "manga-auto-skip-panel-frame-duration",
  enabled: "manga-auto-skip-enabled",
  analysisDebug: "manga-balloon-detection-debug",
});

/**
 * Loads semantic Reader preferences and removes legacy storage keys after migration.
 * @param {Storage|{getItem:(key:string)=>string|null,setItem:(key:string,value:string)=>void,removeItem:(key:string)=>void}} storage
 */
export function loadReaderPreferences(storage) {
  const cameraStrategy = readMigrated(storage, STORAGE_KEYS.cameraStrategy, LEGACY_KEYS.cameraStrategy);
  const readingDirection = readMigrated(storage, STORAGE_KEYS.readingDirection, LEGACY_KEYS.readingDirection);
  const timingPolicy = readMigrated(storage, STORAGE_KEYS.timingPolicy, LEGACY_KEYS.timingPolicy);
  const readingPaceMultiplier = readMigrated(storage, STORAGE_KEYS.readingPaceMultiplier, LEGACY_KEYS.readingPaceMultiplier);
  const minimumHoldSeconds = readMigrated(storage, STORAGE_KEYS.minimumHoldSeconds, LEGACY_KEYS.minimumHoldSeconds);
  const ignoreSingleWord = readMigrated(storage, STORAGE_KEYS.ignoreSingleWord, LEGACY_KEYS.ignoreSingleWord);
  const ignoreColouredText = readMigrated(storage, STORAGE_KEYS.ignoreColouredText, LEGACY_KEYS.ignoreColouredText);
  const dialogueOnly = readMigrated(storage, STORAGE_KEYS.dialogueOnly, LEGACY_KEYS.dialogueOnly);
  const revealEnabled = readMigrated(storage, STORAGE_KEYS.revealEnabled, LEGACY_KEYS.revealEnabled);
  const revealMode = readMigrated(storage, STORAGE_KEYS.revealMode, LEGACY_KEYS.revealMode);
  const showPlaybackProgress = readMigrated(storage, STORAGE_KEYS.showPlaybackProgress, LEGACY_KEYS.showPlaybackProgress);
  const showDirectorPlanningLog = storage.getItem(STORAGE_KEYS.showDirectorPlanningLog);
  const movementDurationMs = readMigrated(storage, STORAGE_KEYS.movementDurationMs, LEGACY_KEYS.movementDurationMs);
  const panelSecondPass = storage.getItem(STORAGE_KEYS.panelSecondPass);
  const directorZoom = storage.getItem(STORAGE_KEYS.directorZoom);
  const analysisDebug = readMigrated(storage, STORAGE_KEYS.analysisDebug, LEGACY_KEYS.analysisDebug);
  storage.removeItem(LEGACY_KEYS.enabled);

  const panelPreferences = normalizePanelPreferences({
    cameraStrategy,
    readingDirection,
    timingPolicy: timingPolicy === "panelSize" ? "panelArea" : timingPolicy,
    readingPaceMultiplier,
    minimumHoldSeconds,
    ignoreSingleWord: parseBoolean(ignoreSingleWord, DEFAULT_PANEL_PREFERENCES.ignoreSingleWord),
    ignoreColouredText: parseBoolean(ignoreColouredText, DEFAULT_PANEL_PREFERENCES.ignoreColouredText),
    dialogueOnly: parseBoolean(dialogueOnly, DEFAULT_PANEL_PREFERENCES.dialogueOnly),
    revealEnabled: parseBoolean(revealEnabled, DEFAULT_PANEL_PREFERENCES.revealEnabled),
    revealMode,
    showPlaybackProgress: parseBoolean(showPlaybackProgress, DEFAULT_PANEL_PREFERENCES.showPlaybackProgress),
    showDirectorPlanningLog: parseBoolean(showDirectorPlanningLog, DEFAULT_PANEL_PREFERENCES.showDirectorPlanningLog),
    movementDurationMs,
    panelSecondPass: parseBoolean(panelSecondPass, DEFAULT_PANEL_PREFERENCES.panelSecondPass),
    directorZoom,
  });
  savePanelPreferences(storage, panelPreferences);
  storage.setItem(STORAGE_KEYS.analysisDebug, String(parseBoolean(analysisDebug, false)));
  return { panelPreferences, analysisDebug: parseBoolean(analysisDebug, false) };
}

/** @param {Partial<typeof DEFAULT_PANEL_PREFERENCES>} input */
export function normalizePanelPreferences(input = {}) {
  return {
    cameraStrategy: input.cameraStrategy === "classic" || input.cameraStrategy === "balloon" ? "classic" : "director",
    readingDirection: input.readingDirection === "ltr" ? "ltr" : "rtl",
    timingPolicy: input.timingPolicy === "panelArea" ? "panelArea" : "text",
    readingPaceMultiplier: Math.max(.5, Number(input.readingPaceMultiplier) || DEFAULT_PANEL_PREFERENCES.readingPaceMultiplier),
    minimumHoldSeconds: Math.max(1, Number(input.minimumHoldSeconds) || DEFAULT_PANEL_PREFERENCES.minimumHoldSeconds),
    ignoreSingleWord: input.ignoreSingleWord === undefined ? DEFAULT_PANEL_PREFERENCES.ignoreSingleWord : !!input.ignoreSingleWord,
    ignoreColouredText: !!input.ignoreColouredText,
    dialogueOnly: !!input.dialogueOnly,
    revealEnabled: !!input.revealEnabled,
    revealMode: ["balloon", "line", "word", "letter"].includes(input.revealMode) ? input.revealMode : DEFAULT_PANEL_PREFERENCES.revealMode,
    showPlaybackProgress: !!input.showPlaybackProgress,
    showDirectorPlanningLog: !!input.showDirectorPlanningLog,
    movementDurationMs: Math.max(300, Math.min(2000, Number(input.movementDurationMs) || DEFAULT_PANEL_PREFERENCES.movementDurationMs)),
    panelSecondPass: !!input.panelSecondPass,
    directorZoom: normalizeDirectorZoom(input.directorZoom),
  };
}

/**
 * @param {Storage|{setItem:(key:string,value:string)=>void}} storage
 * @param {typeof DEFAULT_PANEL_PREFERENCES} preferences
 */
export function savePanelPreferences(storage, preferences) {
  const normalized = normalizePanelPreferences(preferences);
  storage.setItem(STORAGE_KEYS.cameraStrategy, normalized.cameraStrategy);
  storage.setItem(STORAGE_KEYS.readingDirection, normalized.readingDirection);
  storage.setItem(STORAGE_KEYS.timingPolicy, normalized.timingPolicy);
  storage.setItem(STORAGE_KEYS.readingPaceMultiplier, String(normalized.readingPaceMultiplier));
  storage.setItem(STORAGE_KEYS.minimumHoldSeconds, String(normalized.minimumHoldSeconds));
  storage.setItem(STORAGE_KEYS.ignoreSingleWord, String(normalized.ignoreSingleWord));
  storage.setItem(STORAGE_KEYS.ignoreColouredText, String(normalized.ignoreColouredText));
  storage.setItem(STORAGE_KEYS.dialogueOnly, String(normalized.dialogueOnly));
  storage.setItem(STORAGE_KEYS.revealEnabled, String(normalized.revealEnabled));
  storage.setItem(STORAGE_KEYS.revealMode, normalized.revealMode);
  storage.setItem(STORAGE_KEYS.showPlaybackProgress, String(normalized.showPlaybackProgress));
  storage.setItem(STORAGE_KEYS.showDirectorPlanningLog, String(normalized.showDirectorPlanningLog));
  storage.setItem(STORAGE_KEYS.movementDurationMs, String(normalized.movementDurationMs));
  storage.setItem(STORAGE_KEYS.panelSecondPass, String(normalized.panelSecondPass));
  if (normalized.directorZoom === null) storage.removeItem(STORAGE_KEYS.directorZoom);
  else storage.setItem(STORAGE_KEYS.directorZoom, String(normalized.directorZoom));
}

/** @param {Storage|{setItem:(key:string,value:string)=>void}} storage */
export function saveAnalysisDebug(storage, enabled) {
  storage.setItem(STORAGE_KEYS.analysisDebug, String(!!enabled));
}

function readMigrated(storage, semanticKey, legacyKey) {
  const semanticValue = storage.getItem(semanticKey);
  const legacyValue = storage.getItem(legacyKey);
  storage.removeItem(legacyKey);
  if (semanticValue !== null) return semanticValue;
  if (legacyValue !== null) storage.setItem(semanticKey, legacyValue);
  return legacyValue;
}

function normalizeDirectorZoom(value) {
  if (value === null || value === undefined || value === "") return null;
  const zoom = Number(value);
  return Number.isFinite(zoom) && zoom >= 1 && zoom <= 5 ? Math.round(zoom * 100) / 100 : null;
}

function parseBoolean(value, fallback) {
  if (value === null || value === undefined) return fallback;
  return value === true || value === "true";
}

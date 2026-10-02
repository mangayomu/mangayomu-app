import { PanelPageAnalysisService, derivePageReadingData } from "./panel-page-analysis.js";
import { createPanelCameraPlan } from "./panel-camera-plan.js";
import { createPanelPlaybackSchedule } from "./panel-playback-scheduler.js";

/** Composes page analysis, reading subjects, camera planning, and playback scheduling for Panels mode. */
export class PanelReaderController {
  /**
   * @param {{analysisService?:PanelPageAnalysisService}} [dependencies]
   */
  constructor(dependencies = {}) {
    this._analysis = dependencies.analysisService || new PanelPageAnalysisService();
    this._pageData = new Map();
    this._preparedPages = new Map();
    this._pendingPages = new Map();
    this._pageVersions = new Map();
    this._generation = 0;
    this._currentPage = null;
    this._cacheWindow = dependencies.cacheWindow ?? 2;
  }

  /**
   * Informs the controller of the active page so stale cache entries outside
   * the window [current - window, current + window] are evicted.
   * Never evicts a pending page.
   * @param {number} pageIndex
   */
  setCurrentPage(pageIndex) {
    this._currentPage = pageIndex;
    this._evictCacheWindow();
  }

  _evictCacheWindow() {
    if (this._currentPage == null) return;
    const w = this._cacheWindow;
    const min = Math.max(0, this._currentPage - w);
    const max = this._currentPage + w;
    const pending = new Set(this._pendingPages.keys());
    const cached = new Set([
      ...this._pageData.keys(),
      ...this._preparedPages.keys(),
      ...this._analysis.getCachedPageIndexes(),
    ]);

    for (const pageIndex of cached) {
      if (pageIndex >= min && pageIndex <= max) continue;
      if (pending.has(pageIndex) || this._analysis.isPagePending(pageIndex)) continue;
      this.clearPage(pageIndex);
    }
  }

  preloadOcr() {
    return this._analysis.preloadOcr();
  }

  /**
   * Warms setting-independent analysis for an upcoming page.
   * @param {number} pageIndex
   * @param {HTMLImageElement} image
   */
  precalculate(pageIndex, image, panelDetectionOptions = {}) {
    return this._analysis.analyze(pageIndex, image, panelDetectionOptions)
      .finally(() => this._evictCacheWindow());
  }

  /**
   * Builds the complete Panels snapshot while keeping OCR failures observable.
   * @param {{
   *   pageIndex:number,
   *   image:HTMLImageElement,
   *   viewport:Object,
   *   readingProfile:Object,
   *   cameraStrategy:"classic"|"director",
   *   playbackPreferences:Object,
   *   panelDetectionOptions?:Object
   * }} input
   */
  async preparePage(input) {
    const pageIndex = input.pageIndex;
    const token = {
      generation: this._generation,
      version: (this._pageVersions.get(pageIndex) || 0) + 1,
    };
    this._pageVersions.set(pageIndex, token.version);
    this._pendingPages.set(pageIndex, token);
    try {
      const panels = await this._analysis.getPanels(pageIndex, input.image, input.panelDetectionOptions);
      if (!this._isCurrentPreparation(pageIndex, token)) return null;
      let base;
      let analysisError = null;
      try {
        base = await this._analysis.analyze(pageIndex, input.image);
      } catch (error) {
        if (!this._isCurrentPreparation(pageIndex, token)) return null;
        analysisError = error;
        base = this._analysis.createGeometricFallback(pageIndex, input.image, panels);
      }
      if (!this._isCurrentPreparation(pageIndex, token)) return null;
      const pageData = derivePageReadingData(base, input.readingProfile);
      const planningPanels = base.panels;
      this._pageData.set(pageIndex, pageData);
      const prepared = this._composePage(
        pageIndex,
        input.image,
        input.viewport,
        input.cameraStrategy,
        input.readingProfile.readingDirection,
        input.playbackPreferences,
        pageData,
        planningPanels
      );
      prepared.analysisError = analysisError;
      return prepared;
    } finally {
      if (this._pendingPages.get(pageIndex) === token) this._pendingPages.delete(pageIndex);
      this._evictCacheWindow();
    }
  }

  /**
   * Rebuilds camera locations and timing from cached reading data without OCR.
   * @param {number} pageIndex
   * @param {{image:HTMLImageElement,viewport:Object,cameraStrategy:"classic"|"director",readingDirection?:"rtl"|"ltr",playbackPreferences:Object}} input
   */
  reschedulePage(pageIndex, input) {
    const pageData = this._pageData.get(pageIndex);
    const panels = this._analysis.getCachedPanels(pageIndex);
    if (!pageData || !panels) return null;
    const prepared = this._preparedPages.get(pageIndex);
    return this._composePage(
      pageIndex,
      input.image,
      input.viewport,
      input.cameraStrategy,
      input.readingDirection || (prepared ? prepared.readingDirection : "rtl"),
      input.playbackPreferences,
      pageData,
      panels
    );
  }

  /** @param {number} pageIndex */
  isPending(pageIndex) {
    return this._pendingPages.has(pageIndex);
  }

  /** @param {number} pageIndex */
  hasPanels(pageIndex) {
    return this._analysis.hasPanels(pageIndex);
  }

  /** @param {number} pageIndex */
  isPanelDetectionFailed(pageIndex) {
    return this._analysis.isPanelDetectionFailed(pageIndex);
  }

  /** @param {number} pageIndex */
  getCachedPanels(pageIndex) {
    return this._analysis.getCachedPanels(pageIndex);
  }

  /** @param {number} pageIndex */
  getPageData(pageIndex) {
    return this._pageData.get(pageIndex) || null;
  }

  /** @param {number} pageIndex */
  getLocations(pageIndex) {
    const prepared = this._preparedPages.get(pageIndex);
    return prepared ? prepared.locations : [];
  }

  /** @param {number} pageIndex */
  getPreparedPage(pageIndex) {
    return this._preparedPages.get(pageIndex) || null;
  }

  /**
   * Invalidates derived and prepared data while retaining base analysis.
   * @param {number} pageIndex
   */
  invalidatePreparation(pageIndex) {
    this._invalidatePreparation(pageIndex);
  }

  /** Clears OCR-derived and prepared data while retaining detected panels. */
  clearAnalysis(pageIndex) {
    this._invalidatePreparation(pageIndex);
    this._analysis.clearAnalysis(pageIndex);
  }

  /** @param {number} pageIndex */
  clearPage(pageIndex) {
    this._invalidatePreparation(pageIndex);
    this._analysis.clearPage(pageIndex);
  }

  /** Invalidates every option-dependent page cache, including preloaded pages. */
  clearAllPages() {
    this._generation++;
    this._analysis.clearAllPages();
    this._pageData.clear();
    this._preparedPages.clear();
    this._pendingPages.clear();
    this._pageVersions.clear();
  }

  destroy() {
    this._generation++;
    this._analysis.destroy();
    this._pageData.clear();
    this._preparedPages.clear();
    this._pendingPages.clear();
    this._pageVersions.clear();
  }

  /** @param {number} pageIndex */
  _invalidatePreparation(pageIndex) {
    this._pageVersions.set(pageIndex, (this._pageVersions.get(pageIndex) || 0) + 1);
    this._pageData.delete(pageIndex);
    this._preparedPages.delete(pageIndex);
    this._pendingPages.delete(pageIndex);
  }

  /** @param {number} pageIndex @param {{generation:number,version:number}} token */
  _isCurrentPreparation(pageIndex, token) {
    return this._generation === token.generation
      && this._pageVersions.get(pageIndex) === token.version
      && this._pendingPages.get(pageIndex) === token;
  }

  _composePage(pageIndex, image, viewport, cameraStrategy, readingDirection, playbackPreferences, pageData, panels) {
    const context = {
      imageWidth: image.naturalWidth,
      imageHeight: image.naturalHeight,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      minZoom: viewport.minZoom,
      maxZoom: viewport.maxZoom,
      padding: viewport.padding,
      artworkOmittedFraction: viewport.artworkOmittedFraction,
      maxFullViewZoomDelta: viewport.maxFullViewZoomDelta,
      directorCompositionProfile: viewport.directorCompositionProfile,
      directorCompositionZoom: viewport.directorCompositionZoom,
    };
    const cameraPlan = createPanelCameraPlan({
      strategy: cameraStrategy,
      panels,
      subjects: pageData.frameBalloons,
      context,
      readingDirection,
    });
    const schedule = createPanelPlaybackSchedule(cameraPlan, pageData, {
      ...playbackPreferences,
      imageArea: image.naturalWidth * image.naturalHeight,
    });
    const prepared = {
      pageIndex,
      panels,
      pageData,
      cameraPlan,
      readingDirection,
      schedule,
      locations: schedule.locations,
      analysisError: null,
    };
    this._preparedPages.set(pageIndex, prepared);
    return prepared;
  }
}

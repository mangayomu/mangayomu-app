import { auth, manga, progress as progressApi, imageUrl } from "../api.ts";
import { getConnection, hasActiveServerSession } from "../connection";
import { resolveChapterPages } from "../chapter-pages.js";
import { characterCount } from "../panel-page-analysis.js";
import { PanelReaderController } from "../panel-reader-controller.js";
import { PanelCameraExecutor } from "../panel-camera-executor.js";
import { isPanelRevealRequired, PanelRevealController } from "../panel-reveal-controller.js";
import { createPanelDebugView, describeDirectorPlan } from "../panel-debug-presenter.js";
import { PLAYBACK_STATES, ReaderPlaybackController } from "../reader-playback-controller.js";
import { ReaderImagePreloader } from "../reader-image-preloader.js";
import { requestedReaderPageIndex } from "../reader-page-route.js";
import {
  DEFAULT_PANEL_PREFERENCES,
  loadReaderPreferences,
  normalizePanelPreferences,
  saveAnalysisDebug,
  savePanelPreferences,
} from "../reader-preferences.js";
import { ScreenAwakeController } from "../screen-awake-controller.js";
import { globals } from "tinybubble";
import { replaceRoute } from "../App.bub.js";
import ReaderSettings from "../components/ReaderSettings.bub.js";
import ReaderOverlay from "../components/ReaderOverlay.bub.js";
import ReaderModePicker from "../components/ReaderModePicker.bub.js";
import ReaderPageStage from "../components/ReaderPageStage.bub.js";
import ReaderPdfViewer from "../components/ReaderPdfViewer.bub.js";
import ReaderPlaybackProgress from "../components/ReaderPlaybackProgress.bub.js";
import {
  MAX_ZOOM,
  MIN_ZOOM,
  directorCompositionProfile,
  directorCompositionZoom,
  MODES,
  PANEL_ARTWORK_OMITTED_FRACTION,
  PANEL_FINAL_READING_PAUSE_MS,
  PANEL_FRAME_DURATION,
  PANEL_FRAME_PADDING,
  PANEL_OVERVIEW_DURATION,
  PANEL_MAX_FULL_VIEW_ZOOM_DELTA,
  READER_REVEAL_TIMING_DEBUG,
  STORAGE_KEY,
  TAP_THRESHOLD,
  WHEEL_ZOOM_SENSITIVITY,
  ZOOM_STEP,
  ZOOM_STORAGE_KEY,
} from "./reader-config.js";

const Reader = {
  name: "Reader",

  components: {
    "reader-settings": ReaderSettings,
    "reader-overlay": ReaderOverlay,
    "reader-mode-picker": ReaderModePicker,
    "reader-page-stage": ReaderPageStage,
    "reader-pdf-viewer": ReaderPdfViewer,
    "reader-playback-progress": ReaderPlaybackProgress,
  },

  template() {
    return /*html*/`
      <div ref="readerRoot" class="min-h-screen bg-black select-none text-white" :style="'touch-action:' + (isPdfChapter ? 'pan-y' : 'none')">
        <reader-pdf-viewer x-if="isPdfChapter" :src="pdfSrc" :page="currentPage" :zoom="zoom" :mode="mode" @complete="onPdfComplete" @page-count="onPdfPageCount" @page-change="onPdfPageChange"></reader-pdf-viewer>
        <reader-page-stage x-if="!isPdfChapter"
          :mode="mode" :page-urls="pageUrls" :current-page="currentPage"
          :analysis-pending="analysisPending" :panel-frame-pending="panelFramePending" :panel-spotlight-box="panelSpotlightBox"
          :panel-spotlight-style="panelSpotlightStyle" :reveal-boxes="revealBoxes" :reveal-overlay-style="revealOverlayStyle"
          :debug-boxes="debugBoxes" :debug-padding-boxes="debugPaddingBoxes" :debug-panel-boxes="debugPanelBoxes" :debug-overlay-style="debugOverlayStyle"
          :reveal-timing-debug="revealTimingDebug" :reveal-waiting="revealWaiting" :reveal-error="revealError"
          @paged-image-load="onPagedImageLoad" @retry-reveal="retryReveal">
        </reader-page-stage>
        <reader-playback-progress :mode="mode" :progress="playbackProgress" :show="panelPreferences.showPlaybackProgress"></reader-playback-progress>
        <reader-overlay :visible="overlayVisible" :manga-title="mangaTitle" :chapter-label="chapterLabel()"
          :has-prev-chapter="hasPrevChapter" :has-next-chapter="hasNextChapter" :page-percent="pagePercent()"
          :current-label="currentLabel()" :mode="mode" :mode-icon="currentModeIcon()" :mode-label="currentModeLabel()" :zoom-percent="zoomPercent()"
          :playback-state="playbackState" :pdf="isPdfChapter"
          @back="goBack" @previous-chapter="goPrevChapter" @previous-page="goToPreviousPage" @next-page="goToNextPage" @next-chapter="goNextChapter"
          @seek="seekPage" @show-mode-picker="showModePicker" @toggle-playback="togglePlayback" @zoom-out="zoomOut" @zoom-in="zoomIn" @reset-zoom="resetZoom" @open-settings="openSettings">
        </reader-overlay>
        <reader-mode-picker :visible="modePickerVisible" :modes="modes" :mode="mode" @close="closeModePicker" @select="setMode"></reader-mode-picker>
        <reader-settings
          x-if="readerSettingsVisible"
          :panel-preferences="panelPreferences" :analysis-debug="analysisDebug" :director-zoom-default="directorZoomDefault()" :director-zoom-auto="directorZoomAuto()"
          @close="closeSettings" @preference-change="onPreferenceChange" @debug-change="onDebugChange">
        </reader-settings>
      </div>
    `;
  },

  data() {
    return {
      source: "",
      mangaId: "",
      chapterId: "",
      mangaTitle: "",
      chapterNumber: null,
      pageUrls: [],
      isPdfChapter: false,
      pdfSrc: "",
      currentPage: 0,
      totalPages: 0,
      overlayVisible: false,
      modePickerVisible: false,
      mode: "vertical",
      modes: MODES,
      hasPrevChapter: false,
      hasNextChapter: false,
      zoom: 1,
      panelIndex: 0,
      activePanelLocation: null,
      panelSpotlightBox: null,
      panelSpotlightStyle: "",
      readerSettingsVisible: false,
      playbackState: PLAYBACK_STATES.STOPPED,
      panelPreferences: { ...DEFAULT_PANEL_PREFERENCES },
      analysisDebug: false,
      revealTimingDebug: READER_REVEAL_TIMING_DEBUG,
      revealBoxes: [],
      revealOverlayStyle: "display:none",
      debugBoxes: [],
      debugPaddingBoxes: [],
      debugPanelBoxes: [],
      debugOverlayStyle: "display:none",
      revealWaiting: false,
      revealError: "",
      analysisPending: false,
      panelFramePending: false,
      playbackProgress: 0,
    };
  },

  // --- Computed display ---

  currentLabel() {
    return `${this.data.currentPage.value + 1} / ${this.data.totalPages.value}`;
  },

  chapterLabel() {
    const num = this.data.chapterNumber.value;
    return num ? globals.t("Chapter %s", num) : "";
  },

  directorZoomDefault() {
    const surface = this._surface();
    return surface ? directorCompositionZoom(surface.clientWidth, surface.clientHeight) : 1.35;
  },

  directorZoomAuto() {
    const image = this._getPagedImage();
    const surface = this._surface();
    if (!image?.naturalWidth || !surface?.clientWidth) return this.directorZoomDefault();
    const a4ScaleZoom = 210 / (surface.clientWidth * 25.4 / 96);
    const imageDensityLimit = image.naturalWidth / surface.clientWidth;
    return Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, a4ScaleZoom, imageDensityLimit)) * 20) / 20;
  },

  pagePercent() {
    const t = this.data.totalPages.value;
    if (t <= 1) return 0;
    return Math.round((this.data.currentPage.value / (t - 1)) * 100);
  },

  currentModeIcon() {
    const m = MODES.find((x) => x.id === this.data.mode.value);
    return m ? m.icon : "unfold_more";
  },

  currentModeLabel() {
    const m = MODES.find((x) => x.id === this.data.mode.value);
    return m ? m.label : "";
  },

  _surface() {
    if (!this._cachedSurface) {
      this._cachedSurface = this.refs.readerRoot.querySelector(
        "[data-reader-surface], [data-reader-pdf]"
      );
    }
    return this._cachedSurface;
  },

  /** True when the active surface scrolls natively (vertical PDF): the one
   *  exception to the reader's manual panning, kept because the compositor
   *  scrolls long documents off the main thread. Every other interaction
   *  (tap zones, pinch/wheel zoom, seek) still runs through the shared
   *  gesture code. */
  _usesNativeScroll() {
    return this.data.isPdfChapter.value && this.data.mode.value === "vertical";
  },

  _attachSurfaceListeners(surface) {
    if (!surface) return;
    surface.addEventListener("pointerdown", this._boundPointerDown, true);
    surface.addEventListener("pointermove", this._boundPointerMove, true);
    surface.addEventListener("pointerup", this._boundPointerEnd, true);
    surface.addEventListener("pointercancel", this._boundPointerEnd, true);
    surface.addEventListener("scroll", this._boundScroll, { passive: true });
  },

  _detachSurfaceListeners(surface) {
    if (!surface) return;
    surface.removeEventListener("pointerdown", this._boundPointerDown, true);
    surface.removeEventListener("pointermove", this._boundPointerMove, true);
    surface.removeEventListener("pointerup", this._boundPointerEnd, true);
    surface.removeEventListener("pointercancel", this._boundPointerEnd, true);
    surface.removeEventListener("scroll", this._boundScroll);
  },

  /** Re-point the gesture listeners at the surface that is active for the
   *  current chapter (image stage vs PDF viewer) once the type is known. */
  _rebindSurface() {
    if (this._destroyed) return;
    const previous = this._cachedSurface;
    this._cachedSurface = null;
    const next = this._surface();
    if (next && next !== previous) {
      this._detachSurfaceListeners(previous);
      this._attachSurfaceListeners(next);
    }
  },

  // --- Init ---

  async init() {
    this.data.source.value = this.$route.params.source || "";
    this.data.mangaId.value = decodeURIComponent(this.$route.params.mangaId || "");
    this.data.chapterId.value = this.$route.params.chapterId || "";

    if (!this.data.chapterId.value) return;

    console.log("[Reader trace] init", {
      chapterId: this.data.chapterId.value,
      mangaId: this.data.mangaId.value,
    });
    this._destroyed = false;
    this._overlayTimer = null;
    this._preloader = new ReaderImagePreloader({
      onLoad: (pageIndex, image) => {
        if (!this._destroyed) this._precalculatePanels(pageIndex, image);
      },
    });
    this._initialPreloadTimer = null;
    this._zoomSaveTimer = null;
    this._pointers = new Map();
    this._gesture = null;
    this._pinch = null;
    this._panelReader = new PanelReaderController();
    this._panelCamera = new PanelCameraExecutor();
    this._panelReveal = new PanelRevealController({
      onViewModel: (viewModel) => {
        this.data.revealBoxes.value = viewModel.boxes;
        this.data.revealOverlayStyle.value = viewModel.overlayStyle;
      },
    });
    this._panelPlanDebugSignature = "";
    this._directorPlanLogSignature = "";
    this._revealUnavailablePages = new Set();
    this._debugPageIndex = null;
    this._debugSourceBoxes = [];
    this._deferInitialPanelFrame = false;
    this._pendingPanelIndex = 0;
    this._panelFrameZoom = false;
    this._screenAwake = new ScreenAwakeController();
    this._playback = new ReaderPlaybackController({
      onCancel: (reason) => {
        if (reason === "pause") this._panelReveal.pause();
        else if (reason === "preserveReveal") {
          /* keep reveal schedule alive across reading-pan-lead → travel */
        } else {
          this._panelReveal.cancelSchedule();
          this._revealBeatId = null;
        }
        this.data.analysisPending.value = false;
      },
      onProgress: (progress) => { this.data.playbackProgress.value = progress; },
      onStateChange: (state) => {
        this.data.playbackState.value = state;
        this._screenAwake.setActive(
          state === PLAYBACK_STATES.PREPARING || state === PLAYBACK_STATES.PLAYING
        );
        if (state === PLAYBACK_STATES.STOPPED) this._clearReveal();
      },
    });
    this._preparingPageToken = null;
    this._pagePreparationGeneration = 0;
    this._chapterNavigationGeneration = 0;
    this._readerFrames = new Map();
    this._revealBeatId = null;
    this._cachedSurface = null;
    this._resizeFrame = null;
    this._scrollFrame = null;
    this._pendingProgressSave = null;
    this._progressSaveFlush = null;
    this._installDevelopmentBridge();

    this._boundKeydown = (e) => {
      if (this.data.readerSettingsVisible.value) return;
      if (e.key === "Escape" && this.data.mode.value === "panels") {
        e.preventDefault();
        this._pausePlayback();
        return;
      }
      if (this.data.overlayVisible.value || this.data.modePickerVisible.value) return;
      if (e.key === "ArrowRight") this.nextPage();
      else if (e.key === "ArrowLeft") this.prevPage();
    };
    this._boundWheel = (e) => this._onWheel(e);
    this._boundPointerDown = (e) => this._onPointerDown(e);
    this._boundPointerMove = (e) => this._onPointerMove(e);
    this._boundPointerEnd = (e) => this._onPointerEnd(e);
    this._boundScroll = () => this._trackScroll();
    this._boundResize = () => this._onReaderResize();

    window.addEventListener("keydown", this._boundKeydown);
    window.addEventListener("resize", this._boundResize, { passive: true });
    this.refs.readerRoot.addEventListener("wheel", this._boundWheel, {
      passive: false,
      capture: true,
    });
    this._attachSurfaceListeners(this._surface());

    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved && MODES.some((m) => m.id === saved)) {
        this.data.mode.value = saved;
      }
    } catch { /* */ }

    // Restore saved zoom level
    try {
      var zoomPct = parseInt(localStorage.getItem(ZOOM_STORAGE_KEY), 10);
      if (!isNaN(zoomPct) && zoomPct >= MIN_ZOOM * 100 && zoomPct <= MAX_ZOOM * 100) {
        this.data.zoom.value = zoomPct / 100;
      }
    } catch { /* */ }

    try {
      const preferences = loadReaderPreferences(localStorage);
      this.data.panelPreferences.value = preferences.panelPreferences;
      this.data.analysisDebug.value = preferences.analysisDebug;
    } catch {
      this.data.panelPreferences.value = { ...DEFAULT_PANEL_PREFERENCES };
      this.data.analysisDebug.value = false;
    }
    this.data.revealWaiting.value = this._revealRequired();
    if (this.data.mode.value === "panels") this._preloadPanelOcr();

    try {
      console.log("[Reader trace] request chapter pages", this.data.chapterId.value);
      const [detail, pagesData, chapters] = await Promise.all([
        manga.detail(this.data.source.value, this.data.mangaId.value),
        manga.pages(this.data.chapterId.value),
        manga.chapters(this.data.source.value, this.data.mangaId.value).catch((err) => {
          if (import.meta.env.DEV) console.warn("[Reader] chapters fetch failed:", err);
          return [];
        }),
      ]);
      console.log("[Reader trace] received chapter pages", {
        chapterId: this.data.chapterId.value,
        count: pagesData.urls.length,
        format: pagesData.format || "images",
      });
      if (this._destroyed) return;
      this.data.mangaTitle.value = detail.title;
      const pdfModel = resolveChapterPages(pagesData);
      if (pdfModel.format === "pdf") {
        // PDF chapters are modeled as a single chapter-level page: the PDF
        // viewer component renders the document and reports completion.
        this.data.isPdfChapter.value = true;
        this.data.pdfSrc.value = imageUrl(pdfModel.pdfUrl, this.data.source.value) || "";
        this.data.pageUrls.value = [];
        this.data.totalPages.value = 1;
        this.data.currentPage.value = 0;
        // Panel-by-panel reading is not defined on a PDF document surface, so a
        // saved panels mode downgrades to vertical here; every other persisted
        // mode (vertical / ltr / rtl) applies unchanged for full parity with
        // image chapters. The stored choice is left intact so image chapters
        // still default to the user's panel preference.
        this.data.mode.value = this._normalizeModeForChapter(this.data.mode.value);
      } else {
        this.data.isPdfChapter.value = false;
        this.data.pdfSrc.value = "";
        // Direct clients keep the source URLs; server-backed clients use the
        // server image proxy, which supplies the same request headers.
        this.data.pageUrls.value = pdfModel.urls.map((url) => imageUrl(url, this.data.source.value));
        this.data.totalPages.value = pdfModel.totalPages;
      }
      // The gesture surface depends on the chapter type (image stage vs PDF
      // viewer); re-bind the listeners to whichever surface is now active.
      this._scheduleReaderFrame(() => this._rebindSurface());

      // An explicit URL page, including page 0, always wins over saved progress.
      var requestedPageIndex = requestedReaderPageIndex(this.$route.params.page, this.data.totalPages.value);
      if (requestedPageIndex !== null) this.data.currentPage.value = requestedPageIndex;

      // Process chapters for navigation — non-blocking, [] on failure
      if (chapters.length) {
        const cur = chapters.find((c) => c.id === this.data.chapterId.value);
        if (cur) {
          this.data.chapterNumber.value = cur.chapterNumber != null ? cur.chapterNumber : cur.chapter_number;
        }
        const idx = chapters.findIndex((c) => c.id === this.data.chapterId.value);
        this.data.hasPrevChapter.value = idx < chapters.length - 1;
        this.data.hasNextChapter.value = idx > 0;
      }
    } catch (err) {
      console.error("[Reader] init error:", err);
      return;
    }

    // Try saved progress only when the URL did not explicitly choose a page.
    if (requestedPageIndex === null) {
      try {
        var prog = await progressApi.getChapter(
          this.data.mangaId.value, this.data.chapterId.value
        );
        if (this._destroyed) return;
        if (prog && prog.page_index > 0 && prog.page_index < this.data.totalPages.value) {
          this.data.currentPage.value = prog.page_index;
        }
      } catch (e) {}
    }
    if (this._destroyed) return;
    // Sync URL once at the end. PDF chapters still have the placeholder page
    // count here, so the requested page could not be validated yet; defer the
    // sync to onPdfPageCount to keep the link's page segment intact.
    if (!this.data.isPdfChapter.value) this._syncPageUrl(this.data.currentPage.value);
    this._panelReader.setCurrentPage(this.data.currentPage.value);

    const initialPage = this.data.currentPage.value;
    const initialMode = this.data.mode.value;
    const initialPreparationGeneration = this._pagePreparationGeneration;
    this._scheduleReaderFrame(() => {
      if (this.data.currentPage.value !== initialPage) return;
      if (this.data.mode.value !== initialMode) return;
      if (this._pagePreparationGeneration !== initialPreparationGeneration) return;
      if (this.data.isPdfChapter.value) return;
      this._applyZoomLayout();
      if (initialMode === "vertical") this._scrollCurrentPageIntoView();
      else if (initialMode === "panels") {
        this._deferInitialPanelFrame = true;
        this._prepareCurrentPagePanels();
      } else this._centerViewport();
    });

    this.data.overlayVisible.value = true;
    this._startOverlayTimer();
    // Preload next pages after render
    this._initialPreloadTimer = setTimeout(() => {
      this._initialPreloadTimer = null;
      if (!this._destroyed) this._preloadPages();
    }, 500);
  },

  destroy() {
    console.log("[Reader trace] destroy", this.data.chapterId.value);
    this._destroyed = true;
    this._chapterNavigationGeneration++;
    this._cancelReaderFrames();
    this._clearOverlayTimer();
    this._clearPreload(true);
    const surface = this._cachedSurface;
    this._cachedSurface = null;
    if (this._resizeFrame !== null) { cancelAnimationFrame(this._resizeFrame); this._resizeFrame = null; }
    if (this._scrollFrame !== null) { cancelAnimationFrame(this._scrollFrame); this._scrollFrame = null; }
    if (this._initialPreloadTimer) clearTimeout(this._initialPreloadTimer);
    if (this._zoomSaveTimer) clearTimeout(this._zoomSaveTimer);
    this._panelCamera.destroy();
    this._playback.stop();
    this._panelReveal.destroy();
    this._panelReader.destroy();
    this._screenAwake.destroy();
    window.removeEventListener("keydown", this._boundKeydown);
    window.removeEventListener("resize", this._boundResize);
    this.refs.readerRoot.removeEventListener("wheel", this._boundWheel, true);
    this._detachSurfaceListeners(surface);
    this._saveProgress(true);
    this._saveZoom();
    if (window.__mangayomuReader?.owner === this) delete window.__mangayomuReader;
  },

  _installDevelopmentBridge() {
    if (!import.meta.env.DEV) return;
    const owner = this;
    window.__mangayomuReader = {
      owner,
      state: () => ({
        pageIndex: owner.data.currentPage.value,
        panelIndex: owner.data.panelIndex.value,
        playback: owner.data.playbackState.value,
        analysisPending: owner.data.analysisPending.value,
        locations: owner._panelReader.getLocations(owner.data.currentPage.value).length,
      }),
      waitForReady(timeoutMs = 15000) {
        return new Promise((resolve, reject) => {
          const startedAt = Date.now();
          const poll = () => {
            if (owner._destroyed) return reject(new Error("Reader was destroyed"));
            if (owner._hasPanelFrames()) return resolve(this.state());
            if (Date.now() - startedAt >= timeoutMs) return reject(new Error("Reader panel analysis timed out"));
            setTimeout(poll, 50);
          };
          poll();
        });
      },
      play() {
        if (!owner._hasPanelFrames()) throw new Error("Reader panel analysis is not ready; await waitForReady() first");
        owner.togglePlayback();
        return this.state();
      },
      pause() {
        owner._pausePlayback();
        return this.state();
      },
      frame(panelIndex) {
        if (!owner._hasPanelFrames()) throw new Error("Reader panel analysis is not ready");
        owner._framePanel(panelIndex, true);
        return this.state();
      },
    };
  },

  // --- Mode ---

  /** Resolve the effective reader mode for the current chapter. Panel-by-panel
   *  reading is not defined on a PDF document surface, so it maps to vertical
   *  scroll there; image chapters accept every mode unchanged. */
  _normalizeModeForChapter(id) {
    return this.data.isPdfChapter.value && id === "panels" ? "vertical" : id;
  },

  setMode(id) {
    this._panelCamera.cancel();
    this._playback.stop();
    this._panelReader.invalidatePreparation(this.data.currentPage.value);
    this._pagePreparationGeneration++;
    this._preparingPageToken = null;
    // PDF chapters support vertical scroll and paged (ltr/rtl) reading; the
    // panel camera is not defined for a document surface.
    if (this.data.isPdfChapter.value) {
      id = this._normalizeModeForChapter(id);
      this.data.mode.value = id;
      this.data.modePickerVisible.value = false;
      this._resetOverlayTimer();
      try { localStorage.setItem(STORAGE_KEY, id); } catch { /* */ }
      return;
    }
    this.data.mode.value = id;
    this.data.modePickerVisible.value = false;
    this.data.revealWaiting.value = this._revealRequired();
    if (id !== "panels") {
      this._deferInitialPanelFrame = false;
      this.data.panelFramePending.value = false;
      this._clearPanelFrame();
      this._clearReveal();
    }
    try { localStorage.setItem(STORAGE_KEY, id); } catch { /* */ }
    const modeGeneration = this._pagePreparationGeneration;
    const modePage = this.data.currentPage.value;
    this._scheduleReaderFrame(() => {
      if (this.data.mode.value !== id) return;
      if (this.data.currentPage.value !== modePage) return;
      if (this._pagePreparationGeneration !== modeGeneration) return;
      this._applyZoomLayout();
      if (id === "vertical") this._scrollCurrentPageIntoView();
      else if (id === "panels") {
        this._deferInitialPanelFrame = false;
        this.data.panelFramePending.value = true;
        this._precalculateCurrentPageText();
        this._prepareCurrentPagePanels();
        this._preloadPages();
      } else this._centerViewport();
    });
    this._resetOverlayTimer();
  },

  openSettings() {
    this.data.readerSettingsVisible.value = true;
    this.data.modePickerVisible.value = false;
  },

  closeSettings() {
    this.data.readerSettingsVisible.value = false;
  },

  showModePicker() {
    this.data.modePickerVisible.value = !this.data.modePickerVisible.value;
    if (this.data.modePickerVisible.value) this.data.readerSettingsVisible.value = false;
    this._resetOverlayTimer();
  },

  // --- Zoom, pan and tap gestures ---

  /** Pause playback, cancel the active camera transition, clear spotlight,
   *  and release the panel-frame zoom persistence. Called for every genuine
   *  manual camera action (wheel, drag, pinch, zoom buttons, reset). Never
   *  called for a simple pointer-down or tap. */
  _pausePlaybackForManualCameraControl() {
    this._playback.pause();
    this._panelCamera.cancel();
    this._clearSpotlightOnInteraction();
    this._panelFrameZoom = false;
  },

  _onWheel(e) {
    if (!e.ctrlKey) return;

    this._pausePlaybackForManualCameraControl();
    e.preventDefault();
    if (!this._surface().contains(e.target)) return;

    var delta = e.deltaY;
    if (e.deltaMode === 1) delta *= 16;
    else if (e.deltaMode === 2) delta *= this._surface().clientHeight;

    var nextZoom = this.data.zoom.value * Math.exp(-delta * WHEEL_ZOOM_SENSITIVITY);
    this._zoomAt(nextZoom, e.clientX, e.clientY);
    this._queueZoomSave();
  },

  _onPointerDown(e) {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    if (e.target.closest?.("button, input, select, textarea, a, [data-reader-interactive]")) return;

    // The vertical PDF surface scrolls natively (the one exception to the
    // reader's manual panning), so a lone finger must not be claimed; a
    // second finger (pinch zoom) does claim the surface to suppress the
    // browser's own pinch.
    const nativeScroll = this._usesNativeScroll();
    if (!nativeScroll || this._pointers.size >= 1) {
      e.preventDefault();
      this._surface().setPointerCapture(e.pointerId);
    }
    this._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (this._pointers.size === 1) {
      this._gesture = {
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        startTime: Date.now(),
        startScrollLeft: this._surface().scrollLeft,
        startScrollTop: this._surface().scrollTop,
        moved: false,
        hadMultiTouch: false,
      };
      return;
    }

    this._gesture.hadMultiTouch = true;
    this._beginPinch();
  },

  _onPointerMove(e) {
    if (!this._pointers.has(e.pointerId)) return;

    const nativeScroll = this._usesNativeScroll();
    if (!nativeScroll) e.preventDefault();
    this._pointers.get(e.pointerId).x = e.clientX;
    this._pointers.get(e.pointerId).y = e.clientY;

    if (this._pointers.size >= 2) {
      if (!this._pinch) this._beginPinch();
      var points = Array.from(this._pointers.values());
      var first = points[0];
      var second = points[1];
      var dx = second.x - first.x;
      var dy = second.y - first.y;
      var distance = Math.hypot(dx, dy);
      var centerX = (first.x + second.x) / 2;
      var centerY = (first.y + second.y) / 2;
      var rect = this._surface().getBoundingClientRect();
      var focusX = centerX - rect.left;
      var focusY = centerY - rect.top;
      var nextZoom = this._pinch.zoom * (distance / this._pinch.distance);
      var ratio = this._setZoom(nextZoom) / this._pinch.zoom;

      this._surface().scrollLeft = this._pinch.contentX * ratio - focusX;
      this._surface().scrollTop = this._pinch.contentY * ratio - focusY;
      this._gesture.moved = true;
      return;
    }

    if (!this._gesture || this._gesture.hadMultiTouch) return;
    var moveX = e.clientX - this._gesture.startX;
    var moveY = e.clientY - this._gesture.startY;
    if (Math.abs(moveX) > 3 || Math.abs(moveY) > 3) {
      if (!this._gesture.moved) this._pausePlaybackForManualCameraControl();
      this._gesture.moved = true;
    }
    // The vertical PDF surface pans natively; do not re-anchor it manually.
    if (nativeScroll) return;
    this._surface().scrollLeft = this._gesture.startScrollLeft - moveX;
    this._surface().scrollTop = this._gesture.startScrollTop - moveY;
  },

  _onPointerEnd(e) {
    if (!this._pointers.has(e.pointerId)) return;

    this._pointers.delete(e.pointerId);
    if (this._surface().hasPointerCapture(e.pointerId)) {
      this._surface().releasePointerCapture(e.pointerId);
    }
    if (e.type === "pointercancel") {
      this._pointers.clear();
      this._gesture = null;
      this._pinch = null;
      return;
    }

    if (!this._gesture) return;
    if (this._gesture.hadMultiTouch) {
      this._pinch = null;
      if (this._pointers.size === 0) {
        this._saveZoom();
        this._gesture = null;
      }
      return;
    }
    if (e.pointerId !== this._gesture.pointerId) return;

    var dx = e.clientX - this._gesture.startX;
    var dy = e.clientY - this._gesture.startY;
    var dt = Date.now() - this._gesture.startTime;
    var absDx = Math.abs(dx);
    var absDy = Math.abs(dy);

    if (this.data.zoom.value === MIN_ZOOM && absDx > absDy && absDx > TAP_THRESHOLD && dt < 500) {
      if (dx < 0) this.nextPage();
      else this.prevPage();
    } else if (absDx < TAP_THRESHOLD && absDy < TAP_THRESHOLD && dt < 400) {
      this._doTapAction(e.clientX);
    }

    this._gesture = null;
  },

  _beginPinch() {
    this._pausePlaybackForManualCameraControl();
    var points = Array.from(this._pointers.values());
    var first = points[0];
    var second = points[1];
    var centerX = (first.x + second.x) / 2;
    var centerY = (first.y + second.y) / 2;
    var rect = this._surface().getBoundingClientRect();
    this._pinch = {
      distance: Math.hypot(second.x - first.x, second.y - first.y),
      zoom: this.data.zoom.value,
      contentX: this._surface().scrollLeft + centerX - rect.left,
      contentY: this._surface().scrollTop + centerY - rect.top,
    };
  },

  _doTapAction(x) {
    if (this.data.modePickerVisible.value) return;

    const mode = this.data.mode.value;
    const third = window.innerWidth / 3;
    if (mode === "panels" && x < third) {
      if (!this._playback.pause()) this.prevPage();
      return;
    }
    if (mode === "panels" && x > third * 2 && this._resumePlaybackIfPaused()) return;
    if (this.data.overlayVisible.value) {
      this.hideOverlay();
      return;
    }

    if (x < third) {
      if (mode === "rtl") this.nextPage();
      else this.prevPage();
    } else if (x > third * 2) {
      mode === "rtl" ? this.prevPage() : this.nextPage();
    } else {
      this.data.overlayVisible.value = true;
      this._startOverlayTimer();
    }
  },

  // --- Overlay timer ---

  _startOverlayTimer() {
    this._clearOverlayTimer();
    this._overlayTimer = setTimeout(() => {
      this.data.overlayVisible.value = false;
    }, 3000);
  },

  _resetOverlayTimer() {
    if (this.data.overlayVisible.value) {
      this._startOverlayTimer();
    }
  },

  _clearOverlayTimer() {
    if (this._overlayTimer) {
      clearTimeout(this._overlayTimer);
      this._overlayTimer = null;
    }
  },

  hideOverlay() {
    this.data.overlayVisible.value = false;
    this._clearOverlayTimer();
  },

  onPdfPageCount(count) {
    // PDF chapters report their real page count once loaded, so reader page
    // navigation (and the overlay label/seek) works within the document.
    if (!(this.data.isPdfChapter.value && typeof count === "number" && count > 0)) return;
    this.data.totalPages.value = count;
    // An explicit page in the URL was clamped against the placeholder count
    // (1) during init; re-apply it now that the real count is known.
    const requested = requestedReaderPageIndex(this.$route.params.page, count);
    if (requested !== null) {
      this.data.currentPage.value = requested;
      this._syncPageUrl(requested);
      return;
    }
    // No explicit URL page: restore saved progress once the real page count
    // is known (init could not validate it against totalPages = 1).
    void progressApi.getChapter(this.data.mangaId.value, this.data.chapterId.value)
      .then((prog) => {
        if (this._destroyed || !prog) return;
        if (prog.page_index > 0 && prog.page_index < this.data.totalPages.value) {
          const restored = prog.page_index;
          this.data.currentPage.value = restored;
          this._syncPageUrl(restored);
        }
      })
      .catch(() => {});
  },

  /** Keep the reader's current page in sync with the page the user is
   *  actually viewing as they scroll the PDF natively. */
  onPdfPageChange(pageIndex) {
    if (!this.data.isPdfChapter.value) return;
    this.data.currentPage.value = pageIndex;
  },

  onPdfComplete() {
    if (!this.data.chapterId.value) return;
    if (!auth.getToken() && !hasActiveServerSession(getConnection())) return;
    void progressApi.update(
      this.data.mangaId.value, this.data.chapterId.value, 0, true
    ).catch((error) => console.warn("[Reader] PDF completion was not saved:", error));
  },

  // --- Progress bar seek ---

  seekPage(e) {
    this._resetOverlayTimer();
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const idx = Math.round(pct * (this.data.totalPages.value - 1));
    this._goToPage(Math.max(0, Math.min(idx, this.data.totalPages.value - 1)));
  },

  // --- Page navigation ---

  prevPage() {
    this._resetOverlayTimer();
    if (this.data.mode.value === "panels" && this._playback.pause()) return;
    if (this._hasPanelFrames()) {
      this._prevPanel();
      return;
    }
    if (this._panelsPending()) return;
    if (this.data.currentPage.value > 0) {
      this._goToPage(this.data.currentPage.value - 1, 0, !this._playback.isStopped());
    } else {
      this.goPrevChapter();
    }
  },

  nextPage() {
    this._resetOverlayTimer();
    if (this.data.mode.value === "panels") {
      if (this._deferInitialPanelFrame) {
        this._deferInitialPanelFrame = false;
        if (this._hasPanelFrames()) {
          this._framePanel(0);
          return;
        }
        if (this._panelsPending()) return;
      }
      if (this._resumePlaybackIfPaused()) return;
      if (this._hasPanelFrames()) {
        this._nextPanel();
        return;
      }
      if (this._panelsPending()) return;
    }
    this.goToNextPage();
  },

  goToPreviousPage() {
    this._resetOverlayTimer();
    this._playback.stop();
    const previous = this.data.currentPage.value - 1;
    if (previous >= 0) {
      this._goToPage(previous);
    } else {
      this.goPrevChapter();
    }
  },

  goToNextPage() {
    this._resetOverlayTimer();
    this._playback.stop();
    const next = this.data.currentPage.value + 1;
    if (next < this.data.totalPages.value) {
      this._goToPage(next);
    } else {
      this.goNextChapter();
    }
  },

  /* True while the current page's panel boxes are still being awaited
     (image decoding or detectPanels still running) — a tap here must not
     fall through to the naive whole-page navigation, or a fast second tap
     skips a whole page before its panels ever get a chance to show. */
  _panelsPending() {
    if (this.data.mode.value !== "panels") return false;
    const pageIndex = this.data.currentPage.value;
    const panelsPending = this._panelReader.isPending(pageIndex)
      || (!this._panelReader.hasPanels(pageIndex) && !this._panelReader.isPanelDetectionFailed(pageIndex));
    return panelsPending || this.data.panelFramePending.value || (this._revealRequired() && !this._panelReveal.ready);
  },

  _goToPage(idx, panelIndex, preservePlayback = false) {
    this._panelCamera.cancel();
    if (preservePlayback) this._playback.enterLocation();
    else this._playback.stop();
    this._panelReader.invalidatePreparation(this.data.currentPage.value);
    this._panelReader.setCurrentPage(idx);
    this._pagePreparationGeneration++;
    const pagePreparationGeneration = this._pagePreparationGeneration;
    this._preparingPageToken = null;
    this._clearReveal(false);
    this.data.currentPage.value = idx;
    this.data.revealWaiting.value = this._revealRequired();
    this._pointers.clear();
    this._gesture = null;
    this._pinch = null;
    if (this.data.mode.value === "panels") {
      // Manual page navigation presents the page before directing it. Only an
      // active playback page advance may enter its first shot immediately.
      this._deferInitialPanelFrame = !preservePlayback;
      this.data.panelFramePending.value = true;
      this._pendingPanelIndex = panelIndex === undefined ? 0 : panelIndex;
      this._clearPanelFrame();
    }
    // Sync page to URL silently (no hashchange) for refresh persistence
    this._syncPageUrl(idx);
    // Save progress on every page change (skip page 0)
    if (idx > 0) this._saveProgress();
    const pageMode = this.data.mode.value;
    this._scheduleReaderFrame(() => {
      if (this.data.currentPage.value !== idx) return;
      if (this.data.mode.value !== pageMode) return;
      if (this._pagePreparationGeneration !== pagePreparationGeneration) return;
      // PDF chapters own their scroll surface: the viewer scrolls to the
      // requested page through the currentPage prop.
      if (this.data.isPdfChapter.value) return;
      this._applyZoomLayout();
      if (pageMode === "vertical") this._scrollCurrentPageIntoView();
      else if (pageMode === "panels") this._prepareCurrentPagePanels();
      else this._centerViewport();
    });
    // Preload next pages
    this._preloadPages();
  },

  _hasPanelFrames() {
    return this.data.mode.value === "panels"
      && this._panelReader.getLocations(this.data.currentPage.value).length > 0
      && !this.data.panelFramePending.value
      && (!this._revealRequired() || this._panelReveal.ready);
  },

  togglePlayback() {
    this._resetOverlayTimer();
    if (this.data.mode.value !== "panels") return;
    if (this._playback.isPaused()) {
      this.hideOverlay();
      this._resumePlaybackIfPaused();
      return;
    }
    if (!this._playback.isStopped()) {
      this._pausePlayback();
      return;
    }
    this._startPlaybackOnCurrentPanel();
  },

  _startPlaybackOnCurrentPanel() {
    if (this.data.mode.value !== "panels" || !this._playback.start()) return false;
    this.hideOverlay();
    this._preloadPanelOcr();
    const frameCurrentLocation = this._deferInitialPanelFrame;
    this._deferInitialPanelFrame = false;
    if (this.data.panelPreferences.value.revealEnabled) {
      this._restartCurrentPagePreparation();
      return true;
    }
    const panel = this._panelReader.getLocations(this.data.currentPage.value)[this.data.panelIndex.value];
    if (panel) {
      if (frameCurrentLocation) this._framePanel(this.data.panelIndex.value);
      else this._schedulePlayback(panel);
      return true;
    }
    // Preparation frames and schedules this location once its analysis is ready.
    if (this._panelsPending()) return true;
    this._playback.stop();
    return false;
  },

  _nextPanel() {
    const frames = this._panelReader.getLocations(this.data.currentPage.value);
    const next = this.data.panelIndex.value + 1;
    if (next < frames.length) {
      this._framePanel(next);
      return;
    }
    const page = this.data.currentPage.value + 1;
    if (page < this.data.totalPages.value) this._goToPage(page, 0, this._playback.canSchedule());
    else this.goNextChapter();
  },

  _prevPanel() {
    const prev = this.data.panelIndex.value - 1;
    if (prev >= 0) {
      this._framePanel(prev);
      return;
    }
    const page = this.data.currentPage.value - 1;
    if (page >= 0) this._goToPage(page, 0, false);
    else this.goPrevChapter();
  },

  _syncPageUrl(idx) {
    var base = "/reader/" + this.data.source.value + "/" + encodeURIComponent(this.data.mangaId.value) + "/" + this.data.chapterId.value;
    var hash = "#" + base + "/" + idx;
    if (window.location.hash !== hash) {
      history.replaceState(null, "", hash);
    }
  },

  // --- Preload ---

  _clearPreload(releaseImages = false) {
    this._preloader.clear(releaseImages);
  },

  /** @param {() => void} callback */
  _scheduleReaderFrame(callback) {
    const frame = requestAnimationFrame(() => {
      this._readerFrames.delete(frame);
      if (!this._destroyed) callback();
    });
    this._readerFrames.set(frame, null);
    return frame;
  },

  /** @returns {Promise<boolean>} */
  _waitForReaderFrame() {
    return new Promise((resolve) => {
      const frame = requestAnimationFrame(() => {
        this._readerFrames.delete(frame);
        resolve(!this._destroyed);
      });
      this._readerFrames.set(frame, resolve);
    });
  },

  _cancelReaderFrames() {
    this._readerFrames.forEach((resolve, frame) => {
      cancelAnimationFrame(frame);
      if (resolve) resolve(false);
    });
    this._readerFrames.clear();
  },

  _preloadPages() {
    this._preloader.preload(this.data.pageUrls.value, this.data.currentPage.value);
  },

  async _prepareCurrentPagePanels() {
    if (this.data.mode.value !== "panels") return;
    const pageIndex = this.data.currentPage.value;
    const image = this._readyPagedImage();
    if (!image) return;
    const preparationGeneration = this._pagePreparationGeneration;
    const preparationToken = pageIndex + ":" + preparationGeneration;
    if (this._preparingPageToken === preparationToken) return;
    this._preparingPageToken = preparationToken;

    const revealRequired = this._revealRequired();
    this.data.analysisPending.value = true;
    this.data.panelFramePending.value = true;
    if (revealRequired) {
      this.data.revealWaiting.value = true;
      this.data.revealError.value = "";
    }
    try {
      const prepared = await this._panelReader.preparePage(this._panelPreparationInput(pageIndex, image));
      if (!prepared || this._destroyed || this.data.mode.value !== "panels" || this.data.currentPage.value !== pageIndex || preparationGeneration !== this._pagePreparationGeneration) return;

      this._activateAnalysisDebug(pageIndex, prepared.pageData.orderingBoxes);
      if (revealRequired && prepared.analysisError) {
        console.warn("[Reader] text reveal unavailable; continuing with Director geometry:", prepared.analysisError);
        this._revealUnavailablePages.add(pageIndex);
        this._clearReveal();
      } else if (revealRequired) {
        this._activateReveal(pageIndex, prepared.pageData);
        const frameApplied = await this._waitForReaderFrame();
        if (!frameApplied || this.data.currentPage.value !== pageIndex || preparationGeneration !== this._pagePreparationGeneration) return;
        this.data.revealWaiting.value = false;
      } else {
        this._clearReveal();
      }

      const preferences = this.data.panelPreferences.value;
      if (preferences.showDirectorPlanningLog && prepared.cameraPlan.strategy === "director") {
        const signature = JSON.stringify({ pageIndex, cameraPlan: prepared.cameraPlan, schedule: prepared.schedule });
        if (signature !== this._directorPlanLogSignature) {
          this._directorPlanLogSignature = signature;
          console.log(describeDirectorPlan({
            pageIndex,
            readingDirection: preferences.readingDirection,
            panels: prepared.panels,
            cameraPlan: prepared.cameraPlan,
            schedule: prepared.schedule,
            subjects: prepared.pageData.frameBalloons,
          }));
        }
      } else {
        this._directorPlanLogSignature = "";
      }
      if (this.data.analysisDebug.value) {
        const signature = JSON.stringify({ pageIndex, cameraPlan: prepared.cameraPlan, schedule: prepared.schedule });
        if (signature !== this._panelPlanDebugSignature) {
          this._panelPlanDebugSignature = signature;
          console.log("[Reader] panel camera plan", signature);
        }
      }
      const locations = prepared.locations;
      if (!locations || locations.length === 0) {
        console.warn("[Reader] DEV page produced zero panel locations; showing full page and stopping playback");
        this._setZoom(MIN_ZOOM);
        this._centerViewport();
        this.data.panelFramePending.value = false;
        this._clearPanelFrame();
        if (!this._playback.isStopped()) this._playback.stop();
        return;
      }
      if (this._deferInitialPanelFrame) {
        this._setZoom(MIN_ZOOM);
        this._centerViewport();
        return;
      }
      const panelIndex = this._pendingPanelIndex === "last" ? locations.length - 1 : this._pendingPanelIndex;
      this._framePanel(Math.max(0, Math.min(panelIndex, locations.length - 1)));
    } catch (error) {
      console.warn("[Reader] page preparation failed:", error);
      if (this.data.currentPage.value === pageIndex && preparationGeneration === this._pagePreparationGeneration) {
        if (revealRequired) {
          this.data.revealWaiting.value = true;
          this.data.revealError.value = "Text reveal could not be prepared.";
        } else {
          this.data.revealWaiting.value = false;
        }
      }
    } finally {
      if (this._preparingPageToken === preparationToken) {
        this._preparingPageToken = null;
        this.data.analysisPending.value = false;
        this.data.panelFramePending.value = false;
      }
    }
  },

  _panelPreparationInput(pageIndex, image) {
    const surface = this._surface();
    return {
      pageIndex,
      image,
      viewport: {
        width: surface.clientWidth,
        height: surface.clientHeight,
        minZoom: MIN_ZOOM,
        maxZoom: MAX_ZOOM,
        padding: PANEL_FRAME_PADDING,
        artworkOmittedFraction: PANEL_ARTWORK_OMITTED_FRACTION,
        maxFullViewZoomDelta: PANEL_MAX_FULL_VIEW_ZOOM_DELTA,
        directorCompositionProfile: directorCompositionProfile(surface.clientWidth, surface.clientHeight),
        directorCompositionZoom: this.data.panelPreferences.value.directorZoom
          || directorCompositionZoom(surface.clientWidth, surface.clientHeight),
      },
      readingProfile: {
        readingDirection: this.data.panelPreferences.value.readingDirection,
        ignoreSingleWord: this.data.panelPreferences.value.ignoreSingleWord,
        ignoreColouredText: this.data.panelPreferences.value.ignoreColouredText,
        dialogueOnly: this.data.panelPreferences.value.dialogueOnly,
        revealMode: this.data.panelPreferences.value.revealMode,
      },
      cameraStrategy: this.data.panelPreferences.value.cameraStrategy,
      panelDetectionOptions: {
        splitFusedPanels: this.data.panelPreferences.value.panelSecondPass,
        readingDirection: this.data.panelPreferences.value.readingDirection,
      },
      playbackPreferences: this._panelPlaybackPreferences(),
    };
  },

  _panelPlaybackPreferences() {
    return {
      timingPolicy: this.data.panelPreferences.value.timingPolicy,
      minimumHoldMs: this.data.panelPreferences.value.minimumHoldSeconds * 1000,
      readingPaceMultiplier: this.data.panelPreferences.value.readingPaceMultiplier,
      overviewHoldMs: PANEL_OVERVIEW_DURATION,
      movementDurationMs: this.data.panelPreferences.value.movementDurationMs,
      finalPauseMs: PANEL_FINAL_READING_PAUSE_MS,
    };
  },

  _rescheduleCurrentPagePanels() {
    const image = this._readyPagedImage();
    if (!image) return false;
    const input = this._panelPreparationInput(this.data.currentPage.value, image);
    return !!this._panelReader.reschedulePage(this.data.currentPage.value, {
      image,
      viewport: input.viewport,
      cameraStrategy: input.cameraStrategy,
      readingDirection: input.readingProfile.readingDirection,
      playbackPreferences: input.playbackPreferences,
    });
  },

  _precalculatePanels(pageIndex, image) {
    if (this.data.mode.value !== "panels") return;
    void this._panelReader.precalculate(pageIndex, image, {
      splitFusedPanels: this.data.panelPreferences.value.panelSecondPass,
      readingDirection: this.data.panelPreferences.value.readingDirection,
    }).catch((error) => {
      if (import.meta.env.DEV || this.data.analysisDebug.value) {
        console.warn("[Reader] precalculation failed:", error);
      }
    });
  },

  _precalculateCurrentPageText() {
    if (this.data.mode.value !== "panels") return;
    const image = this._readyPagedImage();
    if (!image) return;
    this._precalculatePanels(this.data.currentPage.value, image);
  },

  _preloadPanelOcr() {
    void this._panelReader.preloadOcr().catch((error) => {
      console.warn("[Reader] panel OCR could not be initialized:", error);
    });
  },

  _revealRequired() {
    return isPanelRevealRequired({
      mode: this.data.mode.value,
      playbackStopped: this._playback.isStopped(),
      enabled: this.data.panelPreferences.value.revealEnabled,
      unavailable: this._revealUnavailablePages.has(this.data.currentPage.value),
    });
  },

  _activateReveal(pageIndex, pageData) {
    const allowedUnitIds = new Set(
      this._panelReader.getLocations(pageIndex).flatMap((location) => location.revealUnitIds || [])
    );
    // OCR candidates with no Director reading beat must never cover artwork.
    const sources = pageData.sources.filter((source) => allowedUnitIds.has(source.unitId));
    this._panelReveal.activate(pageIndex, sources);
    this._refreshRevealLayout();
  },

  _activateAnalysisDebug(pageIndex, boxes) {
    this._debugPageIndex = pageIndex;
    this._debugSourceBoxes = boxes;
    if (!this.data.analysisDebug.value) {
      this._clearAnalysisDebug();
      return;
    }
    boxes.forEach((box, index) => {
      if (box.paddingLuminance !== undefined) {
        console.log(
          "[Reader] flood-fill padding", index + 1,
          "horizontalPadding", box.horizontalPadding,
          "verticalPadding", box.verticalPadding,
          "paddingLuminance", box.paddingLuminance
        );
      }
      console.log(
        "[Reader] flood-fill bounds", index + 1, "rawFloodFillBounds",
        "left", box.bounds.left, "top", box.bounds.top,
        "right", box.bounds.right, "bottom", box.bounds.bottom
      );
    });
    this._refreshAnalysisDebug();
  },

  _refreshAnalysisDebug() {
    const image = this._getPagedImage();
    const stage = image ? image.parentElement : null;
    if (!this.data.analysisDebug.value || !image || !stage || this._debugPageIndex !== this.data.currentPage.value) {
      this._clearAnalysisDebug(false);
      return;
    }
    const panels = this._panelReader.getCachedPanels(this.data.currentPage.value) || [];
    const viewModel = createPanelDebugView(this._debugSourceBoxes, image, stage, panels);
    this.data.debugBoxes.value = viewModel.boxes;
    this.data.debugPaddingBoxes.value = viewModel.paddingBoxes;
    this.data.debugPanelBoxes.value = viewModel.panelBoxes;
    this.data.debugOverlayStyle.value = viewModel.overlayStyle;
  },

  _clearAnalysisDebug(clearSource = true) {
    if (clearSource) {
      this._debugPageIndex = null;
      this._debugSourceBoxes = [];
    }
    this.data.debugBoxes.value = [];
    this.data.debugPaddingBoxes.value = [];
    this.data.debugPanelBoxes.value = [];
    this.data.debugOverlayStyle.value = "display:none";
  },

  _refreshRevealLayout() {
    const image = this._getPagedImage();
    const stage = image ? image.parentElement : null;
    if (!image || !stage || this._panelReveal.pageIndex !== this.data.currentPage.value) return;
    this._panelReveal.refreshLayout(image, stage, this.data.revealTimingDebug.value);
  },

  _clearReveal(clearWaiting = true) {
    this._panelReveal.clear();
    this._revealBeatId = null;
    this.data.revealError.value = "";
    if (clearWaiting) this.data.revealWaiting.value = false;
  },

  _restartCurrentPagePreparation() {
    const pageIndex = this.data.currentPage.value;
    this._panelReader.invalidatePreparation(pageIndex);
    this.data.panelFramePending.value = this.data.mode.value === "panels";
    this._pagePreparationGeneration++;
    const preparationGeneration = this._pagePreparationGeneration;
    this._preparingPageToken = null;
    this._clearReveal(false);
    this.data.revealWaiting.value = this._revealRequired();
    if (this.data.mode.value === "panels") {
      this._precalculateCurrentPageText();
      this._preloadPages();
    }
    this._scheduleReaderFrame(() => {
      if (this.data.mode.value !== "panels") return;
      if (this.data.currentPage.value !== pageIndex) return;
      if (this._pagePreparationGeneration !== preparationGeneration) return;
      this._prepareCurrentPagePanels();
    });
  },

  retryReveal() {
    this._revealUnavailablePages.delete(this.data.currentPage.value);
    this._panelReader.clearAnalysis(this.data.currentPage.value);
    this._restartCurrentPagePreparation();
  },

  _getPagedImage() {
    return this._surface().querySelector('[data-reader-stage="paged"] [data-reader-page]');
  },

  /** @returns {HTMLImageElement|null} a decoded paged image whose natural dimensions are available. */
  _readyPagedImage() {
    const image = this._getPagedImage();
    return image && image.complete && image.naturalWidth ? image : null;
  },

  onPreferenceChange(name, value) {
    const next = normalizePanelPreferences({
      ...this.data.panelPreferences.value,
      [name]: value,
    });
    this.data.panelPreferences.value = next;
    try { savePanelPreferences(localStorage, next); } catch {}
    if (name === "showPlaybackProgress") return;

    this._playback.stop();
    if (["panelSecondPass", "readingDirection"].includes(name)) {
      this._panelReader.clearAllPages();
      this._restartCurrentPagePreparation();
      return;
    }
    if (["cameraStrategy", "directorZoom", "timingPolicy", "readingPaceMultiplier", "minimumHoldSeconds", "movementDurationMs"].includes(name)) {
      const rescheduled = this._rescheduleCurrentPagePanels();
      if (!rescheduled && this._panelReader.isPending(this.data.currentPage.value)) {
        this._restartCurrentPagePreparation();
      }
      return;
    }
    if (["revealEnabled", "revealMode", "ignoreSingleWord", "ignoreColouredText", "dialogueOnly"].includes(name)) {
      this._revealUnavailablePages.delete(this.data.currentPage.value);
      this._panelReader.clearAnalysis(this.data.currentPage.value);
    }
    this._restartCurrentPagePreparation();
  },

  onDebugChange(enabled) {
    this.data.analysisDebug.value = !!enabled;
    try { saveAnalysisDebug(localStorage, enabled); } catch {}
    if (!enabled) {
      this._clearAnalysisDebug(false);
      return;
    }
    const pageData = this._panelReader.getPageData(this.data.currentPage.value);
    this._activateAnalysisDebug(
      this.data.currentPage.value,
      pageData ? pageData.orderingBoxes : []
    );
  },

  _pausePlayback() {
    return this._playback.pause();
  },

  _resumePlaybackIfPaused() {
    if (this.data.mode.value !== "panels" || !this._playback.isPaused()) return false;
    const hadScheduledLocation = this._playback.hasScheduledLocation();
    if (!this._playback.resume()) return false;
    const panel = this._panelReader.getLocations(this.data.currentPage.value)[this.data.panelIndex.value];
    if (hadScheduledLocation) {
      if (this._revealRequired()) {
        this._panelReveal.resume(
          this._playback.generation,
          (generation) => this._playback.isCurrent(generation)
        );
      }
      return true;
    }
    // Preparation schedules this panel once its image and text data are ready.
    if (panel) this._schedulePlayback(panel);
    return true;
  },

  _schedulePlayback(location) {
    const canSchedule = this._playback.canSchedule();
    if (this.data.mode.value !== "panels" || !canSchedule) return;
    if (this._revealRequired() && !this._panelReveal.ready) {
      this.data.revealWaiting.value = true;
      void this._prepareCurrentPagePanels();
      return;
    }

    const generation = this._playback.generation;
    const sameRevealBeat = this._revealBeatId && location.revealBeatId
        && location.revealBeatId === this._revealBeatId;
    if (this._revealRequired() && !sameRevealBeat) {
      this._panelReveal.reveal(location, location.revealDurationMs, {
        generation,
        isCurrent: (currentGeneration) => this._playback.isCurrent(currentGeneration),
        readingPaceMultiplier: this.data.panelPreferences.value.readingPaceMultiplier,
        finalPauseMs: PANEL_FINAL_READING_PAUSE_MS,
        getElements: () => this._surface().querySelectorAll("[data-reveal-id]"),
      });
    }
    if (location.revealBeatId) this._revealBeatId = location.revealBeatId;
    if (this.data.analysisDebug.value) {
      console.log(
        "[Reader] playback timing",
        "location", location.id,
        "sourcePanel", location.sourcePanelIndex + 1,
        "part", location.partIndex + 1 + "/" + location.partCount,
        "mode", this.data.panelPreferences.value.timingPolicy,
        "lines", location.timingLines.length,
        "characters", location.timingLines.reduce((total, line) => total + characterCount(line.text), 0),
        "scheduledDurationMs", Math.round(location.holdDurationMs),
        "text", location.timingLines.map((line) => line.text).join(" | ")
      );
    }
    this._playback.schedule(
      location.holdDurationMs,
      this.data.panelPreferences.value.showPlaybackProgress,
      () => this._nextPanel()
    );
  },

  _clearPanelFrame() {
    this._clearAnalysisDebug();
    this.data.panelIndex.value = 0;
    this.data.activePanelLocation.value = null;
    this.data.panelSpotlightBox.value = null;
    this.data.panelSpotlightStyle.value = "";
  },

  /** Hide the panel spotlight when the user manually pans or zooms.
      The spotlight reappears on the next panel navigation via _framePanel(). */
  _clearSpotlightOnInteraction() {
    if (this.data.mode.value !== "panels" || !this.data.activePanelLocation.value) return;
    this.data.activePanelLocation.value = null;
    this.data.panelSpotlightBox.value = null;
    this.data.panelSpotlightStyle.value = "";
  },

  _continueAfterPanelFrame(location, panelIndex) {
    if (!this._playback.canSchedule()) return;
    if (location.kind !== "overview") {
      this._schedulePlayback(location);
      return;
    }
    this._playback.schedule(location.holdDurationMs, false, () => {
      if (
        this._destroyed
        || this.data.mode.value !== "panels"
        || this.data.panelIndex.value !== panelIndex
      ) return;
      this._framePanel(panelIndex + 1, false, true);
    });
  },

  /**
   * Center a detected panel using the existing paged-stage zoom and scroll model.
   * @param {number} panelIndex
   * @param {boolean} [instant]
   * @param {boolean} [automatic]
   */
  _framePanel(panelIndex, instant = false, automatic = false) {
    const image = this._getPagedImage();
    const locations = this._panelReader.getLocations(this.data.currentPage.value);
    if (!image || !locations.length || !locations[panelIndex]) return;

    const location = locations[panelIndex];
    const panels = this._panelReader.getCachedPanels(this.data.currentPage.value);
    const detectedPanel = panels && panels[location.sourcePanelIndex]
      ? panels[location.sourcePanelIndex]
      : location.frame;
    const sourcePanel = detectedPanel;
    if (this.data.analysisDebug.value) {
      console.log(
        "[Reader] panel spotlight", "location", location.id,
        "sourcePanel", location.sourcePanelIndex + 1,
        "x", Math.round(sourcePanel.x), "y", Math.round(sourcePanel.y),
        "w", Math.round(sourcePanel.w), "h", Math.round(sourcePanel.h)
      );
    }
    const autoFrame = automatic || !this._playback.isStopped();
    const scheduledTransitionDuration = Number(location.transitionDurationMs);
    const frameDuration = autoFrame
      ? Number.isFinite(scheduledTransitionDuration) ? Math.max(0, scheduledTransitionDuration) : this.data.panelPreferences.value.movementDurationMs
      : PANEL_FRAME_DURATION;

    /* Same revealBeatId across adjacent locations (reading-pan-lead → travel)
       replaces the location clock without cancelling the reveal schedule. */
    const currentLocation = this.data.activePanelLocation.value;
    const sameRevealBeat = currentLocation && location.revealBeatId
        && location.revealBeatId === currentLocation.revealBeatId
        && location.revealBeatId === this._revealBeatId;
    if (sameRevealBeat) {
      this._playback.advanceLocationKeepingReveal();
    } else {
      this._playback.enterLocation();
    }
    this._panelReveal.enterPanel(this.data.currentPage.value, location.sourcePanelIndex, sourcePanel);
    this._panelFrameZoom = true;
    this._pendingPanelIndex = panelIndex;
    this.data.panelIndex.value = panelIndex;
    if (autoFrame && this.data.analysisDebug.value) {
      const frame = location.frame;
      console.log("[Reader] auto frame", "currentZoom", frame.zoom, "location", location.id, "sourcePanel", location.sourcePanelIndex + 1, "part", location.partIndex + 1 + "/" + location.partCount, "left", Math.round(frame.x), "right", Math.round(frame.x + frame.w), "top", Math.round(frame.y), "bottom", Math.round(frame.y + frame.h));
    }
    this._panelCamera.execute({
      surface: this._surface(),
      image,
      location,
      sourcePanel,
      currentZoom: this.data.zoom.value,
      duration: frameDuration,
      instant,
      setZoom: (zoom) => this._setZoom(zoom, false),
      publish: (state) => this._publishPanelCameraState(state),
      complete: () => this._continueAfterPanelFrame(location, panelIndex),
    });
  },

  _publishPanelCameraState(state) {
    this.data.activePanelLocation.value = state.location;
    this.data.panelSpotlightBox.value = state.spotlightBox;
    this.data.panelSpotlightStyle.value = state.spotlightStyle;
  },

  _refreshPanelSpotlight() {
    const image = this._getPagedImage();
    const box = this.data.panelSpotlightBox.value;
    if (!image || !box || !image.naturalWidth) return;
    this.data.panelSpotlightStyle.value = this._panelCamera.projectSpotlight(this._surface(), image, box);
  },

  _trackScroll() {
    if (this.data.mode.value !== "vertical") return;
    if (this._scrollFrame) return;
    this._scrollFrame = requestAnimationFrame(() => {
      this._scrollFrame = null;
      if (this._destroyed || this.data.mode.value !== "vertical") return;
      const surfaceRect = this._surface().getBoundingClientRect();
      const pages = this._surface().querySelectorAll("[data-reader-page]");
      let maxVisible = -1;
      pages.forEach((page, i) => {
        if (page.getBoundingClientRect().top < surfaceRect.bottom - 150) maxVisible = i;
      });
      if (maxVisible >= 0) this.data.currentPage.value = maxVisible;
    });
  },

  _scrollCurrentPageIntoView() {
    const imgs = this._surface().querySelectorAll("[data-reader-page]");
    const img = imgs[this.data.currentPage.value];
    if (img) img.scrollIntoView({ behavior: "instant", block: "start" });
  },

  _saveProgress(flushNow = false) {
    // Progress is saved for a client account OR an active server session
    // (a server-only user must still persist reading position server-side).
    if (!this.data.chapterId.value) return;
    if (!auth.getToken() && !hasActiveServerSession(getConnection())) return;
    const pageIdx = this.data.currentPage.value;
    if (pageIdx === 0) return;
    // Debounce with last-write-wins: store the latest payload and flush
    // asynchronously so rapid page navigation saves only the final page.
    // When flushNow is true (destroy), save immediately with no debounce.
    this._pendingProgressSave = {
      mangaId: this.data.mangaId.value,
      chapterId: this.data.chapterId.value,
      pageIdx,
      completed: this.data.totalPages.value > 0 && pageIdx >= this.data.totalPages.value - 1,
    };
    if (flushNow) {
      this._flushProgressSave();
      return;
    }
    if (!this._progressSaveFlush) {
      this._progressSaveFlush = Promise.resolve().then(() => {
        this._progressSaveFlush = null;
        this._flushProgressSave();
      });
    }
  },

  _flushProgressSave() {
    const p = this._pendingProgressSave;
    if (!p) return;
    this._pendingProgressSave = null;
    void progressApi.update(
      p.mangaId, p.chapterId, p.pageIdx, p.completed
    ).catch((error) => console.warn("[Reader] progress was not saved:", error));
  },

  _applyZoomLayout(refreshPanelSpotlight = true) {
    const surface = this._surface();
    const zoom = this.data.zoom.value;
    const verticalStage = surface.querySelector('[data-reader-stage="vertical"]');

    if (verticalStage) {
      const pageWidth = Math.min(surface.clientWidth, 768) * zoom;
      verticalStage.style.minWidth = Math.max(surface.clientWidth, pageWidth) + "px";
      const pages = verticalStage.querySelectorAll("[data-reader-page]");
      pages.forEach((page) => {
        page.style.width = pageWidth + "px";
        page.style.maxWidth = "none";
        page.style.height = "auto";
      });
      return;
    }

    const pagedStage = surface.querySelector('[data-reader-stage="paged"]');
    if (!pagedStage) return;
    pagedStage.style.width = surface.clientWidth * zoom + "px";
    pagedStage.style.height = surface.clientHeight * zoom + "px";
    if (refreshPanelSpotlight) this._refreshPanelSpotlight();
    if (this.data.revealBoxes.value.length) this._refreshRevealLayout();
    if (this.data.debugBoxes.value.length) this._refreshAnalysisDebug();
  },

  _setZoom(value, refreshPanelSpotlight = true) {
    if (!Number.isFinite(value)) return this.data.zoom.value;
    var zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    zoom = Math.round(zoom * 1000) / 1000;
    this.data.zoom.value = zoom;
    this._applyZoomLayout(refreshPanelSpotlight);
    return zoom;
  },

  _zoomAt(value, clientX, clientY) {
    const surface = this._surface();
    const oldZoom = this.data.zoom.value;
    const rect = surface.getBoundingClientRect();
    const focusX = clientX - rect.left;
    const focusY = clientY - rect.top;
    const contentX = surface.scrollLeft + focusX;
    const contentY = surface.scrollTop + focusY;
    const nextZoom = this._setZoom(value);
    // The PDF viewer re-renders its canvases at the new scale and restores its
    // own scroll position, so the shared surface must not re-anchor it too.
    if (this.data.isPdfChapter.value) return;
    const ratio = nextZoom / oldZoom;

    surface.scrollLeft = contentX * ratio - focusX;
    surface.scrollTop = contentY * ratio - focusY;
  },

  _centerViewport() {
    const surface = this._surface();
    surface.scrollLeft = Math.max(0, (surface.scrollWidth - surface.clientWidth) / 2);
    surface.scrollTop = Math.max(0, (surface.scrollHeight - surface.clientHeight) / 2);
  },

  _onReaderResize() {
    if (this._resizeFrame) return;
    this._resizeFrame = requestAnimationFrame(() => {
      this._resizeFrame = null;
      if (this._destroyed) return;
      this._applyZoomLayout();
      if (this._debugSourceBoxes.length) this._refreshAnalysisDebug();
      if (this.data.mode.value === "panels" && this._hasPanelFrames()) {
        this._rescheduleCurrentPagePanels();
        const locations = this._panelReader.getLocations(this.data.currentPage.value);
        const index = Math.min(this.data.panelIndex.value, locations.length - 1);
        const location = locations[index];
        const image = this._getPagedImage();
        const panels = this._panelReader.getCachedPanels(this.data.currentPage.value);
        if (location && image && panels) {
          const sourcePanel = panels[location.sourcePanelIndex] || location.frame;
          const generation = this._playback.generation;
          const wasPreparing = this._playback.state === PLAYBACK_STATES.PREPARING;
          this.data.panelIndex.value = index;
          this._panelCamera.execute({
            surface: this._surface(),
            image,
            location,
            sourcePanel,
            currentZoom: this.data.zoom.value,
            duration: 0,
            instant: true,
            setZoom: (zoom) => this._setZoom(zoom, false),
            publish: (state) => this._publishPanelCameraState(state),
            complete: wasPreparing
              ? () => {
                  if (this._destroyed) return;
                  if (!this._playback.isCurrent(generation)) return;
                  if (this.data.panelIndex.value !== index) return;
                  this._continueAfterPanelFrame(location, index);
                }
              : undefined,
          });
        }
        return;
      }
      if (this.data.zoom.value === MIN_ZOOM && this.data.mode.value !== "vertical") {
        this._centerViewport();
      }
    });
  },

  onPagedImageLoad() {
    this._applyZoomLayout();
    if (this.data.mode.value === "panels") {
      this._precalculateCurrentPageText();
      this._prepareCurrentPagePanels();
    } else this._centerViewport();
  },

  _queueZoomSave() {
    if (this._zoomSaveTimer) clearTimeout(this._zoomSaveTimer);
    this._zoomSaveTimer = setTimeout(() => {
      this._zoomSaveTimer = null;
      this._saveZoom();
    }, 150);
  },

  _saveZoom() {
    if (this._panelFrameZoom) return;
    var zoom = this.data.zoom.value;
    if (!Number.isFinite(zoom)) return;
    try {
      localStorage.setItem(ZOOM_STORAGE_KEY, String(Math.round(zoom * 100)));
    } catch (e) {}
  },

  zoomPercent() {
    return Math.round(this.data.zoom.value * 100) + "%";
  },

  zoomIn() {
    this._pausePlaybackForManualCameraControl();
    if (this.data.isPdfChapter.value) {
      this.data.zoom.value = Math.min(this.data.zoom.value + ZOOM_STEP, MAX_ZOOM);
      this._saveZoom();
      return;
    }
    const surface = this._surface();
    const rect = surface.getBoundingClientRect();
    this._zoomAt(this.data.zoom.value + ZOOM_STEP, rect.left + rect.width / 2, rect.top + rect.height / 2);
    console.log("[Reader] zoom in", "currentZoom", this.data.zoom.value);
    this._saveZoom();
  },

  zoomOut() {
    this._pausePlaybackForManualCameraControl();
    if (this.data.isPdfChapter.value) {
      this.data.zoom.value = Math.max(this.data.zoom.value - ZOOM_STEP, MIN_ZOOM);
      this._saveZoom();
      return;
    }
    const surface = this._surface();
    const rect = surface.getBoundingClientRect();
    this._zoomAt(this.data.zoom.value - ZOOM_STEP, rect.left + rect.width / 2, rect.top + rect.height / 2);
    console.log("[Reader] zoom out", "currentZoom", this.data.zoom.value);
    this._saveZoom();
  },

  resetZoom() {
    this._pausePlaybackForManualCameraControl();
    if (this.data.isPdfChapter.value) {
      this.data.zoom.value = MIN_ZOOM;
      this._saveZoom();
      return;
    }
    this._setZoom(MIN_ZOOM);
    const resetPage = this.data.currentPage.value;
    const resetMode = this.data.mode.value;
    this._scheduleReaderFrame(() => {
      if (this.data.currentPage.value !== resetPage) return;
      if (this.data.mode.value !== resetMode) return;
      if (resetMode === "vertical") this._scrollCurrentPageIntoView();
      else this._centerViewport();
    });
    this._saveZoom();
  },

  goBack() {
    this._saveProgress();
    this._chapterNavigationGeneration++;
    replaceRoute("/manga/" + this.data.source.value + "/" + encodeURIComponent(this.data.mangaId.value));
  },

  async goNextChapter() {
    this._resetOverlayTimer();
    this._saveProgress();
    await this._jumpChapter(1);
  },

  async goPrevChapter() {
    this._resetOverlayTimer();
    this._saveProgress();
    await this._jumpChapter(-1);
  },

  async _jumpChapter(dir) {
    const generation = ++this._chapterNavigationGeneration;
    try {
      const chapters = await manga.chapters(
        this.data.source.value, this.data.mangaId.value
      );
      if (this._destroyed || generation !== this._chapterNavigationGeneration) return;
      const idx = chapters.findIndex((c) => c.id === this.data.chapterId.value);
      const next = chapters[idx - dir];
      if (next) {
        this.data.overlayVisible.value = false;
        replaceRoute(
          "/reader/" + this.data.source.value + "/" + encodeURIComponent(this.data.mangaId.value) + "/" + next.id + "/0"
        );
      } else {
        // No more chapters in this direction — back to manga detail
        replaceRoute("/manga/" + this.data.source.value + "/" + encodeURIComponent(this.data.mangaId.value));
      }
    } catch (err) {
      console.error("[Reader] jump chapter failed:", err);
    }
  },
};

export default Reader;

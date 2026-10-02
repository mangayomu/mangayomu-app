import pdfjsWorkerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.js?url";
import { globals, tick, watchProp } from "tinybubble";

/**
 * ReaderPdfViewer — renders a PDF chapter inside the reader.
 *
 * The source only marks the chapter as a PDF and serves its authenticated
 * bytes; this component renders them client-side using pdf.js. It owns a
 * vertical scrollable surface of canvas pages, reports loading/error state,
 * and offers authenticated open/download fallbacks when pdf.js cannot render
 * the document. Reading progress is modeled at the chapter boundary: when the
 * last page becomes visible the component emits "complete" once.
 */

let pdfjsPromise = null;

async function loadPdfJs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import("pdfjs-dist/legacy/build/pdf.js").then((namespace) => {
      // Vite exposes the webpack UMD bundle as the namespace default; named
      // exports also work, so normalize to one object for both cases.
      const pdfjs = namespace && namespace.getDocument ? namespace : namespace.default;
      pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorkerUrl;
      return pdfjs;
    }).catch((error) => {
      pdfjsPromise = null;
      throw error;
    });
  }
  return pdfjsPromise;
}

export default {
  name: "ReaderPdfViewer",

  props: ["src", "page", "zoom", "mode"],
  emits: ["complete", "pageCount", "pageChange"],

  template() {
    return /*html*/`
      <div data-reader-pdf class="fixed inset-0 z-0 overflow-x-hidden bg-black"
        :style="'touch-action:pan-y;overscroll-behavior:contain;overflow-y:' + (mode === 'ltr' || mode === 'rtl' ? 'hidden' : 'auto')">
        <div x-if="loading" class="flex min-h-full items-center justify-center gap-3 p-8 text-gray-400">
          <span class="material-icons animate-spin">progress_activity</span>
          <span>{{ t('Loading PDF') }}…</span>
        </div>
        <div x-if="error" class="flex min-h-full flex-col items-center justify-center gap-3 p-8 text-center">
          <span class="material-icons text-4xl text-gray-500">picture_as_pdf</span>
          <object x-if="nativeFallback" :data="src" type="application/pdf" class="mb-3 h-[45vh] min-h-[12rem] w-full max-w-3xl rounded-lg bg-white">
            <span class="text-sm text-gray-500">{{ t('The embedded PDF viewer is not available.') }}</span>
          </object>
          <p class="text-sm text-gray-300">{{ error }}</p>
          <p class="text-xs text-gray-500">{{ nativeFallback ? t('If the embedded viewer does not load, open or download the PDF instead.') : t('Open the PDF in your browser or download it instead.') }}</p>
          <div class="mt-2 flex flex-wrap items-center justify-center gap-2">
            <a :href="src" target="_blank" rel="noreferrer noopener"
               class="cursor-pointer rounded-full bg-white px-4 py-2 text-sm font-bold text-black hover:bg-gray-200">{{ t('Open in browser') }}</a>
            <a :href="src" download
               class="cursor-pointer rounded-full border border-white/50 px-4 py-2 text-sm font-semibold text-white hover:bg-white/10">{{ t('Download PDF') }}</a>
            <button type="button" @click="retry"
                    class="cursor-pointer rounded-full border border-white/20 px-4 py-2 text-sm text-gray-300 hover:text-white">{{ t('Retry') }}</button>
          </div>
        </div>
        <div ref="pages" x-show="ready" class="flex w-full flex-col items-center gap-4 px-2 py-4"
          :class="(mode === 'ltr' || mode === 'rtl') ? 'min-h-full justify-center' : ''">
          <p x-if="warning" class="sticky top-3 z-10 rounded-full bg-amber-900/80 px-4 py-1.5 text-xs text-amber-100">{{ warning }}</p>
          <div ref="canvasHost" class="flex w-full flex-col items-center gap-4"></div>
        </div>
      </div>`;
  },

  data() {
    return {
      loading: true,
      error: "",
      warning: "",
      nativeFallback: false,
      ready: false,
      pageCount: 0,
    };
  },

  init() {
    this._destroyed = false;
    this._doc = null;
    this._loadSerial = 0;
    this._observer = null;
    this._scrollSurface = null;
    this._scrollHandler = null;
    this._visiblePage = 0;
    this._scrollTrackSurface = null;
    this._scrollTrackHandler = () => this._updateVisiblePage();
    watchProp(this, "src", (next, previous) => {
      if (next !== previous) this.load();
    });
    // Keep the reader's current page in sync: paged modes render a single
    // canvas, vertical mode scrolls the matching canvas into view.
    watchProp(this, "page", (next) => {
      if (typeof next === "number" && next >= 0) this._pendingScrollPage = next;
      if (!this.data.ready.value) return;
      if (this._isPaged()) this._renderSinglePage(next);
      else this.scrollToPage();
    });
    // Switching the reader mode swaps the surface strategy: paged shows one
    // page at a time, vertical renders the whole column.
    watchProp(this, "mode", (next, previous) => {
      if (previous == null || !this.data.ready.value) return;
      if (typeof next !== "string" || next === previous) return;
      if (this._isPaged()) this._renderSinglePage(this.props.page || 0);
      else this._renderAllPages(++this._loadSerial);
    });
    // Zoom changes re-render at the new scale. Bumping the load serial cancels
    // any in-flight render of the previous zoom level; vertical mode restores
    // the page that was visible before the scale change.
    watchProp(this, "zoom", (next, previous) => {
      if (!this.data.ready.value || typeof next !== "number" || next === previous) return;
      if (this._isPaged()) {
        this._renderSinglePage(this.props.page || 0);
        return;
      }
      const surface = this.$element;
      const host = this.refs.canvasHost;
      if (surface && host) {
        const mid = surface.scrollTop + surface.clientHeight / 2;
        const canvases = host.querySelectorAll("canvas[data-pdf-page]");
        let best = 1;
        let bestDist = Infinity;
        canvases.forEach((canvas) => {
          const dist = Math.abs(canvas.offsetTop - mid);
          if (dist < bestDist) {
            bestDist = dist;
            best = Number(canvas.getAttribute("data-pdf-page")) || 1;
          }
        });
        this._pendingScrollPage = best - 1;
      }
      this._renderAllPages(++this._loadSerial);
    });
    this.load();
    // Track the page at the top of the native scroll so the reader can keep
    // its current-page (label / seek / next) in sync. The reader must not
    // also track the PDF scroll or the two sides fight and auto-scroll.
    this._scrollTrackSurface = this.$element;
    if (this._scrollTrackSurface) {
      this._scrollTrackSurface.addEventListener("scroll", this._scrollTrackHandler, { passive: true });
    }
  },

  /** True when the paged (ltr/rtl) surface is active. */
  _isPaged() {
    const mode = this.props.mode;
    return mode === "ltr" || mode === "rtl";
  },

  /**
   * Render only the requested page as a single canvas (paged reading). Marks
   * the chapter complete when the last page is shown.
   */
  async _renderSinglePage(pageIndex, loadSerial = ++this._loadSerial) {
    const doc = this._doc;
    if (!doc || this._destroyed || loadSerial !== this._loadSerial) return;
    const host = this.refs.canvasHost;
    while (host.firstChild) host.removeChild(host.firstChild);
    const surface = this.$element;
    const availW = Math.max(surface.clientWidth || window.innerWidth, 320);
    const availH = Math.max(surface.clientHeight || window.innerHeight, 320);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const zoom = Number(this.props.zoom || 1);
    const num = Math.max(1, Math.min(Number(pageIndex) + 1, doc.numPages));
    let page;
    try {
      page = await doc.getPage(num);
    } catch (error) {
      console.warn("[ReaderPdfViewer] page", num, "could not be opened:", error);
      return;
    }
    if (this._destroyed || loadSerial !== this._loadSerial) return;
    const base = page.getViewport({ scale: 1 });
    // Zoom 1 fits the whole page inside the surface (contain), mirroring the
    // image reader's object-contain paged stage; higher zoom magnifies from
    // that fit and may crop the page by design.
    const fitScale = Math.min(availW / base.width, availH / base.height);
    const cssWidth = Math.max(base.width * fitScale * zoom, 320);
    const scale = (cssWidth / base.width) * dpr;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.style.width = cssWidth + "px";
    canvas.style.height = Math.floor((cssWidth / base.width) * base.height) + "px";
    canvas.setAttribute("data-pdf-page", String(num));
    try {
      const context = canvas.getContext("2d", { alpha: false });
      await page.render({ canvasContext: context, viewport }).promise;
    } catch (error) {
      console.warn("[ReaderPdfViewer] page", num, "could not be rendered:", error);
      return;
    }
    if (this._destroyed || loadSerial !== this._loadSerial) return;
    host.appendChild(canvas);
    try { page.cleanup(); } catch (e) { /* ignore */ }
    if (num >= doc.numPages) {
      if (this._observer) this._observer.disconnect();
      this.emit("complete");
    }
  },

  /** Scroll the reader's current PDF page into view (prop `page`). */
  scrollToPage() {
    const idx = this._pendingScrollPage;
    if (idx == null) return;
    // Native vertical scrolling already placed this page at the top of the
    // surface, so re-scrolling would fight the user and, together with the
    // reader's scroll tracking, create an auto-scroll feedback loop.
    if (idx === this._visiblePage) {
      this._pendingScrollPage = null;
      return;
    }
    const host = this.refs.canvasHost;
    const canvas = host && host.querySelector('[data-pdf-page="' + (idx + 1) + '"]');
    if (canvas) {
      canvas.scrollIntoView({ block: "start" });
      this._pendingScrollPage = null;
    }
  },

  /** Report the page at the top of the vertical scroll to the reader. */
  _updateVisiblePage() {
    if (this._isPaged()) return;
    const host = this.refs.canvasHost;
    if (!host || !this.data.ready.value) return;
    const surface = this._scrollTrackSurface;
    if (!surface) return;
    const surfaceTop = surface.getBoundingClientRect().top;
    const canvases = host.querySelectorAll("canvas[data-pdf-page]");
    let current = 0;
    canvases.forEach((canvas) => {
      if (canvas.getBoundingClientRect().top <= surfaceTop + 1) {
        current = Number(canvas.getAttribute("data-pdf-page")) || 1;
      }
    });
    const pageIndex = current - 1;
    if (pageIndex !== this._visiblePage) {
      this._visiblePage = pageIndex;
      this.emit("pageChange", pageIndex);
    }
  },

  beforeDestroy() {
    this._destroyed = true;
    if (this._observer) this._observer.disconnect();
    if (this._scrollSurface && this._scrollHandler) {
      this._scrollSurface.removeEventListener("scroll", this._scrollHandler);
    }
    if (this._scrollTrackSurface && this._scrollTrackHandler) {
      this._scrollTrackSurface.removeEventListener("scroll", this._scrollTrackHandler);
    }
    if (this._doc) {
      try { this._doc.destroy(); } catch (e) { /* doc already closed */ }
      this._doc = null;
    }
  },

  /** @returns {Promise<void>} */
  async load() {
    if (this._destroyed) return;
    const loadSerial = ++this._loadSerial;
    this.data.error.value = "";
    this.data.warning.value = "";
    this.data.nativeFallback.value = false;
    this.data.loading.value = true;
    this.data.ready.value = false;
    const oldCanvasHost = this.refs.canvasHost;
    if (oldCanvasHost) {
      while (oldCanvasHost.firstChild) oldCanvasHost.removeChild(oldCanvasHost.firstChild);
    }
    if (this._observer) this._observer.disconnect();
    if (this._scrollSurface && this._scrollHandler) {
      this._scrollSurface.removeEventListener("scroll", this._scrollHandler);
      this._scrollSurface = null;
      this._scrollHandler = null;
    }
    if (this._doc) {
      try { this._doc.destroy(); } catch (e) { /* ignore */ }
      this._doc = null;
    }
    try {
      const pdfjs = await loadPdfJs();
      if (this._destroyed || loadSerial !== this._loadSerial) return;
      const doc = await pdfjs.getDocument({ url: this.props.src }).promise;
      if (this._destroyed || loadSerial !== this._loadSerial) {
        doc.destroy();
        return;
      }
      this._doc = doc;
      this.data.pageCount.value = doc.numPages;
      this.emit("pageCount", doc.numPages);
      this.data.loading.value = false;
      this.data.ready.value = true;
      // Flush pending effects so the pages container is no longer hidden
      // before we measure its width.
      tick();
      if (this._isPaged()) {
        await this._renderSinglePage(Number(this.props.page) || 0, loadSerial);
      } else {
        await this._renderAllPages(loadSerial);
        // Resume at the reader's requested page once every canvas is in place.
        this.scrollToPage();
      }
    } catch (error) {
      if (this._destroyed || loadSerial !== this._loadSerial) return;
      this.data.loading.value = false;
      this.data.nativeFallback.value = true;
      this.data.error.value = globals.t("This PDF could not be opened in the reader.");
      console.warn("[ReaderPdfViewer] load failed:", error);
    }
  },

  retry() {
    this.load();
  },

  /** @returns {Promise<void>} */
  async _renderAllPages(loadSerial) {
    const doc = this._doc;
    if (!doc || this._destroyed || loadSerial !== this._loadSerial) return;
    const host = this.refs.canvasHost;
    while (host.firstChild) host.removeChild(host.firstChild);
    const width = Math.max(host.clientWidth || window.innerWidth, 320);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    // The reader zoom multiplies the fit width; zoom levels below 0.5 would
    // make a page unreadably small, so the scale is clamped upward. Vertical
    // mode fits pages to the surface width (min 768px), exactly like the
    // image reader's vertical stage; taller pages scroll vertically.
    const zoom = Number(this.props.zoom || 1);
    const baseWidth = Math.min(width, 768);
    const cssWidth = Math.max(baseWidth * zoom, 320);

    let lastCanvas = null;
    let renderedPages = 0;
    for (let i = 1; i <= doc.numPages; i++) {
      if (this._destroyed || loadSerial !== this._loadSerial) return;
      let page;
      try {
        page = await doc.getPage(i);
      } catch (error) {
        console.warn("[ReaderPdfViewer] page", i, "could not be opened:", error);
        continue;
      }
      const base = page.getViewport({ scale: 1 });
      const scale = (cssWidth / base.width) * dpr;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = cssWidth + "px";
      canvas.style.height = Math.floor((cssWidth / base.width) * base.height) + "px";
      canvas.setAttribute("data-pdf-page", String(i));
      try {
        const context = canvas.getContext("2d", { alpha: false });
        await page.render({ canvasContext: context, viewport }).promise;
      } catch (error) {
        console.warn("[ReaderPdfViewer] page", i, "could not be rendered:", error);
        continue;
      }
      if (this._destroyed || loadSerial !== this._loadSerial) return;
      host.appendChild(canvas);
      renderedPages += 1;
      lastCanvas = canvas;
      try { page.cleanup(); } catch (e) { /* ignore */ }
    }

    if (this._destroyed || loadSerial !== this._loadSerial) return;
    if (renderedPages === 0) {
      this.data.ready.value = false;
      this.data.nativeFallback.value = true;
      this.data.error.value = globals.t("This PDF has no pages that can be rendered.");
      return;
    }
    if (renderedPages < doc.numPages) {
      this.data.warning.value = globals.t("Some PDF pages could not be rendered.");
    }
    if (lastCanvas) this._armCompletionObserver(lastCanvas);
    // A zoom re-render rebuilt every canvas from the top: return to the page
    // the reader was showing before the scale change.
    this.scrollToPage();
  },

  _armCompletionObserver(lastCanvas) {
    if (this._observer) this._observer.disconnect();
    try {
      this._observer = new IntersectionObserver(
        (entries) => {
          if (!this._destroyed && entries.some((entry) => entry.isIntersecting)) {
            if (this._observer) this._observer.disconnect();
            this.emit("complete");
          }
        },
        { threshold: 0, rootMargin: "0px 0px -10% 0px" }
      );
      this._observer.observe(lastCanvas);
    } catch (error) {
      // IntersectionObserver can be missing on very old WebViews; use the
      // reader surface position instead of marking completion on a timer.
      const surface = this.$element;
      const checkScrollEnd = () => {
        if (this._destroyed) return;
        if (surface.scrollTop + surface.clientHeight >= surface.scrollHeight - 24) {
          if (this._scrollSurface && this._scrollHandler) {
            this._scrollSurface.removeEventListener("scroll", this._scrollHandler);
          }
          this._scrollSurface = null;
          this._scrollHandler = null;
          this.emit("complete");
        }
      };
      this._scrollSurface = surface;
      this._scrollHandler = checkScrollEnd;
      surface.addEventListener("scroll", checkScrollEnd, { passive: true });
      checkScrollEnd();
    }
  },

};

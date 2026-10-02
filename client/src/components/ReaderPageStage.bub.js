import ReaderRevealLayer from "./ReaderRevealLayer.bub.js";
import ReaderDebugLayer from "./ReaderDebugLayer.bub.js";

export default {
  name: "ReaderPageStage",
  components: {
    "reader-reveal-layer": ReaderRevealLayer,
    "reader-debug-layer": ReaderDebugLayer,
  },
  props: [
    "mode", "pageUrls", "currentPage", "analysisPending", "panelFramePending", "panelSpotlightBox",
    "panelSpotlightStyle", "revealBoxes", "revealOverlayStyle", "revealTimingDebug",
    "debugBoxes", "debugPaddingBoxes", "debugPanelBoxes", "debugOverlayStyle", "revealWaiting", "revealError",
  ],
  emits: ["pagedImageLoad", "retryReveal"],

  template() {
    return /*html*/`
      <div data-reader-surface class="fixed inset-0 z-0 overflow-auto bg-black" style="touch-action:none;overscroll-behavior:contain">
        <div x-if="mode === 'vertical'" data-reader-stage="vertical" class="pb-8 min-w-full">
          <div x-for="(pageUrl, idx) in pageUrls" :key="idx" class="flex justify-center">
            <img data-reader-page :src="pageUrl" class="block w-full max-w-3xl" loading="lazy" draggable="false" style="user-select:none;-webkit-user-drag:none" />
          </div>
        </div>
        <div x-if="mode !== 'vertical'" data-reader-stage="paged" class="relative flex items-center justify-center">
          <template x-if="pageUrls.length > 0"><img data-reader-page :src="pageUrls[currentPage]" class="block w-full h-full object-contain shrink-0" crossorigin="anonymous" draggable="false" @load="onPagedImageLoad" style="user-select:none;-webkit-user-drag:none" /></template>
          <reader-reveal-layer :mode="mode" :boxes="revealBoxes" :overlay-style="revealOverlayStyle" :show-timing-debug="revealTimingDebug" :waiting="revealWaiting" :error="revealError" @retry="retryReveal"></reader-reveal-layer>
          <div x-if="mode === 'panels' && panelSpotlightBox" class="absolute z-20 pointer-events-none border border-white/70" :style="panelSpotlightStyle"></div>
          <reader-debug-layer :boxes="debugBoxes" :padding-boxes="debugPaddingBoxes" :panel-boxes="debugPanelBoxes" :overlay-style="debugOverlayStyle"></reader-debug-layer>
          <div x-if="mode === 'panels' && (analysisPending || panelFramePending) && !revealWaiting" class="absolute z-20 top-3 right-3 rounded-full bg-black/70 p-2"><span class="material-icons animate-spin">progress_activity</span></div>
        </div>
      </div>`;
  },

  onPagedImageLoad() { this.emit("pagedImageLoad"); },
  retryReveal() { this.emit("retryReveal"); },
};

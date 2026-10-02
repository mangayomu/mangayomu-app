export default {
  name: "ReaderOverlay",
  props: [
    "visible", "mangaTitle", "chapterLabel", "hasPrevChapter", "hasNextChapter",
    "pagePercent", "currentLabel", "mode", "modeIcon", "modeLabel", "zoomPercent",
    "playbackState", "pdf",
  ],
  emits: [
    "back", "previousChapter", "previousPage", "nextPage", "nextChapter", "seek",
    "showModePicker", "togglePlayback", "zoomOut", "zoomIn", "resetZoom", "openSettings",
  ],

  template() {
    return /*html*/`
      <div x-show="visible" class="fixed inset-0 z-30 pointer-events-none">
        <div class="fixed top-0 left-0 right-0 z-40 pointer-events-auto px-4 pt-12 pb-4 bg-gradient-to-b from-black/80 to-transparent">
          <div class="flex items-start gap-3">
            <button type="button" @click="back" class="text-white hover:text-gray-300 shrink-0 mt-0.5 cursor-pointer" :aria-label="t('Back')">
              <span class="material-icons">arrow_back</span>
            </button>
            <div class="min-w-0">
              <div class="text-base font-medium truncate">{{ mangaTitle }}</div>
              <div class="text-sm text-gray-400">{{ chapterLabel }}</div>
            </div>
          </div>
        </div>
        <div class="fixed bottom-0 left-0 right-0 z-40 pointer-events-auto pb-8 pt-8 bg-gradient-to-t from-black/80 to-transparent">
          <div class="flex items-center gap-3 px-4 mb-2">
            <button type="button" @click="previousChapter" class="text-gray-400 hover:text-white shrink-0 cursor-pointer" :class="hasPrevChapter ? '' : 'opacity-20 pointer-events-none'" :aria-label="t('Previous chapter')"><span class="material-icons">skip_previous</span></button>
            <button type="button" @click="previousPage" class="text-gray-400 hover:text-white shrink-0 cursor-pointer" :aria-label="t('Previous page')"><span class="material-icons">chevron_left</span></button>
            <div class="flex-1 h-2 bg-gray-600 rounded-full overflow-hidden cursor-pointer" @click="seek"><div class="h-full bg-blue-500 rounded-full transition-all duration-200" :style="'width: ' + pagePercent + '%'"></div></div>
            <button type="button" @click="nextPage" class="text-gray-400 hover:text-white shrink-0 cursor-pointer" :aria-label="t('Next page')"><span class="material-icons">chevron_right</span></button>
            <button type="button" @click="nextChapter" class="text-gray-400 hover:text-white shrink-0 cursor-pointer" :class="hasNextChapter ? '' : 'opacity-20 pointer-events-none'" :aria-label="t('Next chapter')"><span class="material-icons">skip_next</span></button>
          </div>
          <div class="text-center text-sm text-gray-400 mb-4">{{ currentLabel }}</div>
          <div class="flex items-center justify-center gap-2 px-2 sm:gap-3 sm:px-4">
            <button type="button" @click="showModePicker" class="flex shrink-0 items-center gap-1 text-sm text-gray-300 hover:text-white cursor-pointer">
              <span class="material-icons text-lg">{{ modeIcon }}</span>
              <span class="text-xs sm:hidden">{{ mode === 'panels' ? t('Panels') : t(modeLabel) }}</span>
              <span class="hidden text-xs sm:inline">{{ t(modeLabel) }}</span>
            </button>
            <span class="hidden text-gray-600 sm:inline">|</span>
            <button x-if="mode === 'panels'" type="button" @click="togglePlayback" class="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-white text-black shadow-lg hover:bg-gray-200 cursor-pointer" :aria-label="t(playbackLabel())" :aria-pressed="playbackActive()">
              <span class="material-icons">{{ playbackIcon() }}</span>
            </button>
            <span x-if="mode === 'panels'" class="hidden text-gray-600 sm:inline">|</span>
            <button type="button" @click="zoomOut" class="shrink-0 text-gray-300 hover:text-white p-1 cursor-pointer" :aria-label="t('Zoom out')"><span class="material-icons text-lg">remove</span></button>
            <span class="w-9 shrink-0 text-center text-xs text-gray-400 tabular-nums">{{ zoomPercent }}</span>
            <button type="button" @click="zoomIn" class="shrink-0 text-gray-300 hover:text-white p-1 cursor-pointer" :aria-label="t('Zoom in')"><span class="material-icons text-lg">add</span></button>
            <button type="button" @click="resetZoom" class="shrink-0 whitespace-nowrap text-xs text-gray-400 hover:text-white cursor-pointer">{{ t('Reset') }}</button>
            <span x-if="!pdf" class="hidden text-gray-600 sm:inline">|</span>
            <button type="button" @click="openSettings" class="shrink-0 text-gray-300 hover:text-white p-1 cursor-pointer" :aria-label="t('Reader settings')"><span class="material-icons">settings</span></button>
          </div>
        </div>
      </div>`;
  },

  playbackActive() {
    return this.props.playbackState === "preparing" || this.props.playbackState === "playing";
  },

  playbackIcon() {
    return this.playbackActive() ? "pause" : "play_arrow";
  },

  playbackLabel() {
    return this.playbackActive() ? "Pause playback" : "Play";
  },

  back() { this.emit("back"); },
  previousChapter() { this.emit("previousChapter"); },
  previousPage() { this.emit("previousPage"); },
  nextPage() { this.emit("nextPage"); },
  nextChapter() { this.emit("nextChapter"); },
  seek(event) { this.emit("seek", event); },
  showModePicker() { this.emit("showModePicker"); },
  togglePlayback() { this.emit("togglePlayback"); },
  zoomOut() { this.emit("zoomOut"); },
  zoomIn() { this.emit("zoomIn"); },
  resetZoom() { this.emit("resetZoom"); },
  openSettings() { this.emit("openSettings"); },
};

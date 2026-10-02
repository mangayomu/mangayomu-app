export default {
  name: "ReaderRevealLayer",
  props: ["mode", "boxes", "overlayStyle", "showTimingDebug", "waiting", "error"],
  emits: ["retry"],

  template() {
    return /*html*/`
      <div>
        <div data-reader-text-overlay class="absolute z-10 pointer-events-none" :style="overlayStyle">
          <div x-for="box in boxes" :key="box.id" class="absolute pointer-events-none" :data-reveal-id="box.id" :style="box.style"></div>
          <div x-for="box in boxes" :key="'debug:' + box.id" x-if="showTimingDebug && box.debugLabel" class="absolute z-10 pointer-events-none rounded bg-white/90 px-1 py-0.5 text-center text-[10px] font-bold leading-tight text-black shadow" :style="box.debugStyle" aria-hidden="true">{{ box.debugLabel }}</div>
        </div>
        <div x-if="mode === 'panels' && waiting" class="fixed inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-black text-center">
          <span x-if="!error" class="material-icons animate-spin text-3xl text-white">progress_activity</span>
          <template x-if="error">
            <p class="max-w-xs text-sm text-gray-300">{{ t(error) }}</p>
            <button type="button" @click="retry" class="cursor-pointer rounded-lg bg-white px-4 py-2 text-sm font-semibold text-black hover:bg-gray-200">{{ t('Retry') }}</button>
          </template>
        </div>
      </div>`;
  },

  retry() { this.emit("retry"); },
};

export default {
  name: "ReaderPlaybackProgress",
  props: ["mode", "progress", "show"],

  template() {
    return /*html*/`
      <div x-if="show && mode === 'panels' && progress > 0"
        class="fixed top-0 left-0 z-20 h-1 w-screen bg-yellow-300/20 pointer-events-none"
        aria-hidden="true">
        <div class="h-full bg-yellow-400 shadow-[0_0_8px_rgba(250,204,21,.9)]"
          :style="'width:' + progress + '%'"></div>
      </div>
    `;
  },
};

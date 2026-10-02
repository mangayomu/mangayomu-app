export default {
  name: "ReaderDebugLayer",
  props: ["boxes", "paddingBoxes", "panelBoxes", "overlayStyle"],

  template() {
    return /*html*/`
      <div class="absolute z-20 pointer-events-none" :style="overlayStyle">
        <div x-for="panel in panelBoxes" :key="panel.id" class="absolute border-4" :style="panel.style">
          <span class="absolute left-1 top-1 rounded bg-black/80 px-2 py-1 text-lg font-black leading-none text-white shadow">{{ panel.label }}</span>
        </div>
        <div x-for="box in paddingBoxes" :key="box.id" class="absolute bg-red-500/35" :style="box.style">
          <span x-if="box.label" :title="box.text" class="absolute left-1 top-1 cursor-help rounded bg-red-700 px-2 py-1 text-lg font-black leading-none text-white shadow" style="pointer-events:auto">{{ box.label }}</span>
        </div>
        <div x-for="box in boxes" :key="box.id" class="absolute border-2 border-cyan-400" :style="box.style"><span class="absolute left-1 top-1 rounded bg-cyan-500 px-1.5 py-0.5 text-xs font-black leading-none text-black shadow">{{ box.label }}</span></div>
      </div>`;
  },
};

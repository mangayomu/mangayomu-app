export default {
  name: "ReaderModePicker",
  props: ["visible", "modes", "mode"],
  emits: ["close", "select"],
  template() { return /*html*/`
    <div x-show="visible" class="fixed inset-0 z-50 flex items-end justify-center" @click="close">
      <div @click.stop class="bg-gray-900 rounded-t-xl w-full max-w-md p-6 pb-8 shadow-lg">
        <div class="w-10 h-1 bg-gray-600 rounded-full mx-auto mb-4"></div>
        <h3 class="text-lg font-semibold mb-4 text-center flex items-center justify-center gap-2"><span class="material-icons">chrome_reader_mode</span>{{ t('Reading mode') }}</h3>
        <div class="space-y-2"><div x-for="m in modes" :key="m.id" class="flex items-center gap-3 p-3 rounded-lg cursor-pointer transition-colors" :class="m.id === mode ? 'bg-blue-600' : 'bg-gray-800 hover:bg-gray-700'" @click="select(m.id)"><span class="material-icons text-xl">{{m.icon}}</span><span class="text-sm font-medium">{{ t(m.label) }}</span><span x-show="m.id === mode" class="ml-auto"><span class="material-icons text-sm">check</span></span></div></div>
      </div>
    </div>`; },
  close() { this.emit("close"); },
  select(id) { this.emit("select", id); },
};

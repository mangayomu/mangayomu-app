const ReaderSettings = {
  name: "ReaderSettings",
  props: ["panelPreferences", "analysisDebug", "directorZoomDefault", "directorZoomAuto"],
  emits: ["close", "preferenceChange", "debugChange"],

  template() {
    return /*html*/`
      <div class="fixed inset-0 z-50" style="pointer-events:none">
        <div class="absolute inset-0 bg-black/60" style="pointer-events:auto" @click="close"></div>
        <div class="relative flex items-center justify-center min-h-screen" style="pointer-events:auto">
          <div class="flex max-h-[80vh] w-4/5 max-w-md flex-col rounded-xl bg-gray-900 p-6 shadow-lg">
            <div class="mb-4 flex shrink-0 items-center justify-between">
              <h3 class="text-lg font-semibold text-white">{{ t('Reader settings') }}</h3>
              <button type="button" @click="close" class="cursor-pointer text-gray-400 hover:text-white" :aria-label="t('Close settings')"><span class="material-icons">close</span></button>
            </div>

            <div class="min-h-0 flex-1 overflow-y-auto">
              <section class="mt-5 border-t border-gray-700 pt-4">
                <h4 class="text-sm font-semibold text-white">{{ t('Camera') }}</h4>
                <div class="mt-4 space-y-4 text-sm text-white">
                  <label class="flex items-center justify-between gap-3"><span>{{ t('Strategy') }}</span><select x-model="cameraStrategy" @change="saveCameraStrategy" class="rounded bg-gray-800 px-2 py-1 text-white"><option value="classic">{{ t('Classic') }}</option><option value="director">{{ t('Director') }}</option></select></label>
                  <label class="flex items-center justify-between gap-3"><span>{{ t('Reading direction') }}</span><select x-model="readingDirection" @change="saveReadingDirection" class="rounded bg-gray-800 px-2 py-1 text-white"><option value="rtl">{{ t('Right to left') }}</option><option value="ltr">{{ t('Left to right') }}</option></select></label>
                  <label class="flex items-center justify-between gap-3"><span>{{ t('Director zoom') }}</span><span class="flex items-center gap-2"><input class="w-16 rounded bg-gray-800 px-2 py-1 text-white" type="number" min="1" max="5" step="0.05" x-model="directorZoom" @change="saveDirectorZoom" /><span>×</span><button type="button" @click="autoDirectorZoom" class="rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600">{{ t('Auto') }}</button><button type="button" @click="resetDirectorZoom" class="rounded bg-gray-700 px-2 py-1 text-xs hover:bg-gray-600">{{ t('Default') }}</button></span></label>
                  <label class="flex justify-between gap-3"><span>{{ t('Second-pass panel split') }} <span class="text-gray-400">({{ t('experimental') }})</span></span><input type="checkbox" :checked="panelSecondPass" @change="setPanelSecondPass($event)" class="accent-blue-500" /></label>
                  <label class="block"><span>{{ t('Movement: %ss', movementDurationMs / 1000) }}</span><input class="mt-2 w-full" type="range" min="300" max="2000" step="100" x-model="movementDurationMs" @change="saveMovementDuration" /></label>
                </div>
              </section>

              <section class="mt-5 border-t border-gray-700 pt-4">
                <h4 class="text-sm font-semibold text-white">{{ t('Reading subjects') }}</h4>
                <div class="mt-4 space-y-4 text-sm text-white">
                  <label class="flex justify-between gap-3"><span>{{ t('Dialogue only') }}</span><input type="checkbox" :checked="dialogueOnly" @change="setDialogueOnly($event)" class="accent-blue-500" /></label>
                  <label class="flex justify-between gap-3"><span>{{ t('Ignore single words') }} <span class="text-gray-400">({{ t('sound effects') }})</span></span><input type="checkbox" :checked="ignoreSingleWord" @change="setIgnoreSingleWord($event)" class="accent-blue-500" /></label>
                  <label class="flex justify-between gap-3"><span>{{ t('Ignore coloured text') }}</span><input type="checkbox" :checked="ignoreColouredText" @change="setIgnoreColouredText($event)" class="accent-blue-500" /></label>
                </div>
              </section>

              <section class="mt-5 border-t border-gray-700 pt-4">
                <h4 class="text-sm font-semibold text-white">{{ t('Playback pace') }}</h4>
                <div class="mt-4 space-y-4 text-sm text-white">
                  <label class="flex items-center justify-between gap-3"><span>{{ t('Timing') }}</span><select x-model="timingPolicy" @change="saveTimingPolicy" class="rounded bg-gray-800 px-2 py-1 text-white"><option value="text">{{ t('Text detection') }}</option><option value="panelArea">{{ t('Panel area') }}</option></select></label>
                  <label class="block"><span>{{ t('Reading pace: %s×', readingPaceMultiplier) }}</span><input class="mt-2 w-full" type="range" min="0.5" max="3" step="0.1" x-model="readingPaceMultiplier" @change="saveReadingPace" /></label>
                  <label class="block"><span>{{ t('Minimum seconds: %s', minimumHoldSeconds) }}</span><input class="mt-2 w-full" type="range" min="1" max="15" step="1" x-model="minimumHoldSeconds" @change="saveMinimumHold" /></label>
                  <label class="flex justify-between gap-3"><span>{{ t('Show playback progress') }}</span><input type="checkbox" :checked="showPlaybackProgress" @change="setShowPlaybackProgress($event)" class="accent-blue-500" /></label>
                </div>
              </section>

              <section class="mt-5 border-t border-gray-700 pt-4">
                <h4 class="text-sm font-semibold text-white">{{ t('Reveal') }}</h4>
                <div class="mt-4 space-y-4 text-sm text-white">
                  <label class="flex justify-between gap-3"><span>{{ t('Progressively reveal text') }}</span><input type="checkbox" :checked="revealEnabled" @change="setRevealEnabled($event)" class="accent-blue-500" /></label>
                  <label x-if="revealEnabled" class="flex items-center justify-between gap-3"><span>{{ t('Unit') }}</span><select x-model="revealMode" @change="saveRevealMode" class="rounded bg-gray-800 px-2 py-1 text-white"><option value="balloon">{{ t('Full balloon') }}</option><option value="line">{{ t('Line') }}</option><option value="word">{{ t('Word') }}</option><option value="letter">{{ t('Letter') }}</option></select></label>
                </div>
              </section>

              <section class="mt-5 border-t border-gray-700 pt-4">
                <h4 class="text-sm font-semibold text-white">{{ t('Debug') }}</h4>
                <label class="flex justify-between gap-3 py-3 text-sm text-white"><span>{{ t('Analysis geometry') }}</span><input type="checkbox" :checked="analysisDebugValue" @change="setAnalysisDebug($event)" class="accent-blue-500" /></label>
                <label x-if="cameraStrategy === 'director'" class="flex justify-between gap-3 py-3 text-sm text-white"><span>{{ t('Director planning log') }}</span><input type="checkbox" :checked="showDirectorPlanningLog" @change="setShowDirectorPlanningLog($event)" class="accent-blue-500" /></label>
              </section>
            </div>
          </div>
        </div>
      </div>
    `;
  },

  data() {
    return {
      cameraStrategy: "director", readingDirection: "rtl", timingPolicy: "text",
      readingPaceMultiplier: 1, minimumHoldSeconds: 2, ignoreSingleWord: true,
      ignoreColouredText: false, dialogueOnly: false, revealEnabled: false,
      revealMode: "balloon", showPlaybackProgress: false, showDirectorPlanningLog: false,
      movementDurationMs: 800, panelSecondPass: false, directorZoom: "", analysisDebugValue: false,
    };
  },

  init() {
    const preferences = this.props.panelPreferences;
    Object.keys(preferences).forEach((name) => {
      if (this.data[name]) this.data[name].value = preferences[name];
    });
    if (this.data.directorZoom.value === null || this.data.directorZoom.value === "") {
      this.data.directorZoom.value = this.props.directorZoomDefault;
    }
    this.data.analysisDebugValue.value = this.props.analysisDebug;
  },

  close() { this.emit("close"); },
  saveCameraStrategy() { this.emit("preferenceChange", "cameraStrategy", this.data.cameraStrategy.value); },
  saveReadingDirection() { this.emit("preferenceChange", "readingDirection", this.data.readingDirection.value); },
  saveTimingPolicy() { this.emit("preferenceChange", "timingPolicy", this.data.timingPolicy.value); },
  saveReadingPace() { this.emit("preferenceChange", "readingPaceMultiplier", this.data.readingPaceMultiplier.value); },
  saveMinimumHold() { this.emit("preferenceChange", "minimumHoldSeconds", this.data.minimumHoldSeconds.value); },
  saveMovementDuration() { this.emit("preferenceChange", "movementDurationMs", this.data.movementDurationMs.value); },
  saveDirectorZoom() { this.emit("preferenceChange", "directorZoom", this.data.directorZoom.value); },
  autoDirectorZoom() {
    this.data.directorZoom.value = this.props.directorZoomAuto;
    this.emit("preferenceChange", "directorZoom", this.props.directorZoomAuto);
  },
  resetDirectorZoom() { this.data.directorZoom.value = this.props.directorZoomDefault; this.emit("preferenceChange", "directorZoom", null); },
  setPanelSecondPass(event) { this.data.panelSecondPass.value = event.target.checked; this.emit("preferenceChange", "panelSecondPass", event.target.checked); },
  saveRevealMode() { this.emit("preferenceChange", "revealMode", this.data.revealMode.value); },
  setDialogueOnly(event) { this.data.dialogueOnly.value = event.target.checked; this.emit("preferenceChange", "dialogueOnly", event.target.checked); },
  setIgnoreSingleWord(event) { this.data.ignoreSingleWord.value = event.target.checked; this.emit("preferenceChange", "ignoreSingleWord", event.target.checked); },
  setIgnoreColouredText(event) { this.data.ignoreColouredText.value = event.target.checked; this.emit("preferenceChange", "ignoreColouredText", event.target.checked); },
  setRevealEnabled(event) { this.data.revealEnabled.value = event.target.checked; this.emit("preferenceChange", "revealEnabled", event.target.checked); },
  setShowPlaybackProgress(event) { this.data.showPlaybackProgress.value = event.target.checked; this.emit("preferenceChange", "showPlaybackProgress", event.target.checked); },
  setShowDirectorPlanningLog(event) { this.data.showDirectorPlanningLog.value = event.target.checked; this.emit("preferenceChange", "showDirectorPlanningLog", event.target.checked); },
  setAnalysisDebug(event) { this.data.analysisDebugValue.value = event.target.checked; this.emit("debugChange", event.target.checked); },
};

export default ReaderSettings;

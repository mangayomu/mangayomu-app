import SectionFooter from "../components/SectionFooter.bub.js";
import BackupImportPanel from "../components/BackupImportPanel.bub.js";
import SyncPanel from "../components/SyncPanel.bub.js";
import { globals } from "tinybubble";
import { isDark, setThemePreference } from "../components/ThemeToggle.bub.js";
import { extensions, remoteAuth } from "../api.ts";
import { getConnection } from "../connection";
import { loadExtensionContributions, createExtensionComponent } from "../extensions/extension-hub.js";

var SCROLL_MODE_KEY = "manga-scroll-mode";

function getSavedScrollMode() {
  try {
    var saved = localStorage.getItem(SCROLL_MODE_KEY);
    if (saved === "page" || saved === "scroll") return saved;
  } catch (e) {}
  return "scroll";
}

var Settings = {
  name: "Settings",

  components: {
    "section-footer": SectionFooter,
    "backup-import-panel": BackupImportPanel,
    "sync-panel": SyncPanel,
  },

  template() {
    return /*html*/`
      <div class="min-h-[100dvh] flex flex-col overflow-x-hidden">
        <div class="section-page-content min-w-0 p-4 sm:p-6 max-w-6xl mx-auto flex-1 w-full">
          <!-- Header -->
          <div class="mb-6 flex items-center gap-2">
            <span class="material-icons text-2xl sm:text-3xl text-gray-600 dark:text-gray-300 shrink-0">settings</span>
            <h1 class="text-2xl font-bold">{{ t('Settings') }}</h1>
          </div>

          <!-- Tabs -->
          <div class="mb-6 w-full overflow-x-auto overflow-y-hidden border-b border-gray-200 dark:border-gray-700">
            <div class="flex w-max min-w-full gap-1" role="tablist">
            <button x-for="tab in tabs" :key="tab.id" role="tab"
              @click="selectTab(tab)"
              :aria-selected="activeTab === tab.id"
              :disabled="tab.disabled"
              :title="tab.disabled ? t('Coming soon') : ''"
              :class="tab.disabled
                ? 'text-gray-400 dark:text-gray-600 cursor-not-allowed'
                : (activeTab === tab.id
                  ? 'border-blue-600 text-blue-700 dark:text-blue-400 font-medium'
                  : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200')"
              class="flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 -mb-px px-4 py-2 text-sm transition-colors cursor-pointer sm:flex-1 sm:justify-center">
              <span class="material-icons text-lg">{{ tab.icon }}</span>
              {{ t(tab.label) }}
            </button>
            </div>
          </div>

          <!-- General tab -->
          <div x-show="activeTab === 'general'" class="max-w-xl space-y-8">
            <!-- Pagination -->
            <section>
              <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <span class="material-icons text-lg">auto_stories</span>
                {{ t('Pagination') }}
              </h2>
              <div class="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
                <button @click="setScrollMode('page')" :aria-pressed="scrollMode === 'page'"
                  class="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer"
                  :class="scrollMode === 'page' ? 'bg-blue-50 dark:bg-blue-950/40' : 'bg-white dark:bg-gray-800'">
                  <span class="material-icons text-xl text-gray-500 dark:text-gray-400">auto_stories</span>
                  <span class="flex-1 text-sm font-medium text-gray-800 dark:text-gray-100">{{ t('Pagination') }}</span>
                  <span class="material-icons text-xl" :class="scrollMode === 'page' ? 'text-blue-600' : 'text-gray-300 dark:text-gray-600'">radio_button_checked</span>
                </button>
                <button @click="setScrollMode('scroll')" :aria-pressed="scrollMode === 'scroll'"
                  class="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer"
                  :class="scrollMode === 'scroll' ? 'bg-blue-50 dark:bg-blue-950/40' : 'bg-white dark:bg-gray-800'">
                  <span class="material-icons text-xl text-gray-500 dark:text-gray-400">unfold_more</span>
                  <span class="flex-1 text-sm font-medium text-gray-800 dark:text-gray-100">{{ t('Infinite scroll') }}</span>
                  <span class="material-icons text-xl" :class="scrollMode === 'scroll' ? 'text-blue-600' : 'text-gray-300 dark:text-gray-600'">radio_button_checked</span>
                </button>
              </div>
              <p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{{ t('Choose how the catalog loads when you browse manga.') }}</p>
            </section>

            <!-- Theme -->
            <section>
              <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                <span class="material-icons text-lg">palette</span>
                {{ t('Theme') }}
              </h2>
              <div class="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
                <button @click="setTheme('light')" :aria-pressed="theme === 'light'"
                  class="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer"
                  :class="theme === 'light' ? 'bg-blue-50 dark:bg-blue-950/40' : 'bg-white dark:bg-gray-800'">
                  <span class="material-icons text-xl text-amber-500">light_mode</span>
                  <span class="flex-1 text-sm font-medium text-gray-800 dark:text-gray-100">{{ t('Light theme') }}</span>
                  <span class="material-icons text-xl" :class="theme === 'light' ? 'text-blue-600' : 'text-gray-300 dark:text-gray-600'">radio_button_checked</span>
                </button>
                <button @click="setTheme('dark')" :aria-pressed="theme === 'dark'"
                  class="flex w-full items-center gap-3 px-4 py-3.5 text-left transition-colors hover:bg-gray-50 dark:hover:bg-gray-800/60 cursor-pointer"
                  :class="theme === 'dark' ? 'bg-blue-50 dark:bg-blue-950/40' : 'bg-white dark:bg-gray-800'">
                  <span class="material-icons text-xl text-indigo-400">dark_mode</span>
                  <span class="flex-1 text-sm font-medium text-gray-800 dark:text-gray-100">{{ t('Dark theme') }}</span>
                  <span class="material-icons text-xl" :class="theme === 'dark' ? 'text-blue-600' : 'text-gray-300 dark:text-gray-600'">radio_button_checked</span>
                </button>
              </div>
            </section>
          </div>

          <!-- Extensions tab -->
          <div x-show="activeTab === 'extensions'" class="max-w-xl space-y-8">
            <section x-if="!serverAvailable" class="rounded-xl border border-gray-200 dark:border-gray-700 p-5 text-sm text-gray-600 dark:text-gray-300">
              {{ t('Connect to a MangaYomu server to install and manage extensions.') }}
            </section>

            <template x-if="serverAvailable">
              <!-- Installed extensions -->
              <section>
                <div class="mb-3 flex items-center justify-between gap-2">
                  <h2 class="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    <span class="material-icons text-lg">extension</span>
                    {{ t('Installed extensions') }}
                  </h2>
                  <button x-show="isAdmin" @click="openAddPackageModal"
                    class="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 cursor-pointer">
                    <span class="material-icons text-base leading-none">add</span>
                    {{ t('Add') }}
                  </button>
                </div>
                <div x-if="!installedSources.length" class="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 p-5 text-sm text-gray-500 dark:text-gray-400">
                  {{ t('No extensions installed yet. Add one from your device, a package URL, or a repository below.') }}
                </div>
                <div class="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700 divide-y divide-gray-200 dark:divide-gray-700">
                  <div x-for="src in installedSources" :key="src.id" class="flex items-center gap-3 bg-white px-4 py-3 dark:bg-gray-800">
                    <div class="min-w-0 flex-1">
                      <p class="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{{src.name}}</p>
                      <p class="text-xs text-gray-400">{{src.id}} · {{ t('version %s', src.version || '?') }}</p>
                    </div>
                    <button x-show="isAdmin && src.packageId" @click="removeExtension(src)" :disabled="busy"
                      class="shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 cursor-pointer">
                      {{ t('Remove') }}
                    </button>
                    <button @click="toggleSource(src.id, !src.enabled)" :disabled="busy"
                      class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 cursor-pointer"
                      :class="src.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'"
                      :aria-pressed="src.enabled" :title="t('Enable / disable extension')">
                      <span class="inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform"
                        :class="src.enabled ? 'translate-x-5' : 'translate-x-0.5'"></span>
                    </button>
                  </div>
                </div>
              </section>

              <!-- Installed repositories -->
              <section>
                <div class="mb-3 flex items-center justify-between gap-2">
                  <h2 class="flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                    <span class="material-icons text-lg">cloud_download</span>
                    {{ t('Installed repositories') }}
                  </h2>
                  <button x-show="isAdmin" @click="openAddRepoModal"
                    class="inline-flex shrink-0 items-center gap-0.5 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 cursor-pointer">
                    <span class="material-icons text-base leading-none">add</span>
                    {{ t('Add') }}
                  </button>
                </div>
                <div x-if="!repositories.length" class="rounded-xl border border-dashed border-gray-300 dark:border-gray-600 p-5 text-sm text-gray-500 dark:text-gray-400">
                  <span x-show="isAdmin">{{ t('No repositories added yet. Add one to browse and install extensions from it.') }}</span>
                  <span x-show="!isAdmin">{{ t('No repositories added yet. Ask an admin to add one.') }}</span>
                </div>
                <template x-if="repositories.length">
                  <div class="space-y-4">
                    <div x-for="repo in repositories" :key="repo.id" class="overflow-hidden rounded-xl border border-gray-200 dark:border-gray-700">
                      <div class="flex items-center justify-between gap-2 bg-gray-50 px-4 py-2.5 dark:bg-gray-800/60">
                        <div class="min-w-0 flex-1">
                          <p class="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{{repo.name || repo.url}}</p>
                          <p class="truncate text-xs text-gray-400">{{repo.url}}</p>
                        </div>
                        <button x-show="isAdmin" @click="removeRepository(repo.id)" :disabled="busy"
                          class="shrink-0 rounded-lg px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50 dark:hover:bg-red-950/40 disabled:opacity-50 cursor-pointer">
                          {{ t('Remove') }}
                        </button>
                      </div>
                      <div x-show="repo.error" class="border-t border-gray-200 px-4 py-2 text-sm text-red-600 dark:border-gray-700 dark:text-red-400">
                        {{repo.error}}
                      </div>
                      <div x-show="!repo.error && !repo.packages.length" class="border-t border-gray-200 px-4 py-3 text-sm text-gray-500 dark:border-gray-700 dark:text-gray-400">
                        {{ t('This repository has no installable packages.') }}
                      </div>
                      <div class="divide-y divide-gray-200 dark:divide-gray-700">
                        <div x-for="pkg in repo.packages" :key="pkg.url" class="flex items-center gap-3 bg-white px-4 py-3 dark:bg-gray-800">
                          <div class="min-w-0 flex-1">
                            <p class="truncate text-sm font-medium text-gray-800 dark:text-gray-100">{{pkg.name}}</p>
                            <p class="text-xs text-gray-400">{{pkg.id}} · {{ t('version %s', pkg.version) }}<span x-show="pkg.updateAvailable"> · {{ t('update available') }}</span></p>
                            <div x-show="pkg.tags && pkg.tags.length" class="mt-1 flex flex-wrap gap-1">
                              <span x-for="tag in pkg.tags" :key="tag"
                                class="inline-flex items-center rounded-full bg-blue-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-blue-700 dark:bg-blue-950/60 dark:text-blue-300">
                                {{tag}}
                              </span>
                            </div>
                          </div>
                          <button x-show="pkg.installed" @click="toggleSource(pkg.id, !pkg.enabled)"
                            class="relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors cursor-pointer"
                            :class="pkg.enabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'"
                            :aria-pressed="pkg.enabled" :title="t('Enable / disable extension')">
                            <span class="inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform"
                              :class="pkg.enabled ? 'translate-x-5' : 'translate-x-0.5'"></span>
                          </button>
                          <button @click="installRepoPackage(repo, pkg.url)"
                            :disabled="busy"
                            class="rounded-lg px-3 py-1.5 text-sm font-medium transition-colors cursor-pointer disabled:opacity-50"
                            :class="pkg.updateAvailable ? 'bg-amber-500 text-white hover:bg-amber-600' : (pkg.installed ? 'bg-gray-200 text-gray-500 dark:bg-gray-700 dark:text-gray-300' : 'bg-blue-600 text-white hover:bg-blue-700')">
                            <span x-show="!pkg.installed">{{ t('Install') }}</span>
                            <span x-show="pkg.installed && pkg.updateAvailable">{{ t('Update') }}</span>
                            <span x-show="pkg.installed && !pkg.updateAvailable">{{ t('Installed') }}</span>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </template>
              </section>
            </template>

            <p x-show="errors" class="text-sm text-red-600 dark:text-red-400">{{ errors }}</p>
          </div>

          <!-- Advanced tab -->
          <div x-show="activeTab === 'advanced'" class="max-w-xl space-y-8">
            <section x-if="!serverAvailable" class="rounded-xl border border-gray-200 dark:border-gray-700 p-5 text-sm text-gray-600 dark:text-gray-300">
              {{ t('Connect to a MangaYomu server to manage advanced settings.') }}
            </section>

            <section x-if="serverAvailable && !isAdmin" class="rounded-xl border border-gray-200 dark:border-gray-700 p-5 text-sm text-gray-600 dark:text-gray-300">
              <span class="material-icons align-middle text-lg text-gray-400">lock</span>
              {{ t('Advanced server settings are only available to the server administrator.') }}
            </section>

            <template x-if="serverAvailable && isAdmin">
              <section>
                <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <span class="material-icons text-lg">folder</span>
                  {{ t('Extensions home') }}
                </h2>
                <div class="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                  <p class="mb-3 text-xs leading-5 text-gray-500 dark:text-gray-400">
                    {{ t('Where installed extension packages are stored on the server. Changing the location moves existing packages and requires the new path to be owned by the server.') }}
                  </p>
                  <input id="adv-home" x-model="newHome" placeholder="~/.mangayomu"
                    class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
                </div>
              </section>

              <section>
                <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <span class="material-icons text-lg">verified_user</span>
                  {{ t('Trusted registries') }}
                </h2>
                <div class="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                  <p class="mb-3 text-xs leading-5 text-gray-500 dark:text-gray-400">
                    {{ t('Catalogs of trusted repositories and packages that authenticated users can discover and install. A repository can only be added in the Extensions tab when it is listed here. The first registry wins when two of them offer the same package.') }}
                  </p>
                  <p class="mb-3 text-xs leading-5 text-gray-500 dark:text-gray-400">
                    {{ t('The official MangaYomu repository is always trusted and is not listed here.') }}
                  </p>

                  <ul x-show="trustedUrls.length" class="mb-3 space-y-2">
                    <li x-for="url in trustedUrls" :key="url" class="flex items-center gap-2 rounded-lg bg-gray-50 px-3 py-2 dark:bg-gray-900">
                      <span class="material-icons text-base text-gray-400">link</span>
                      <span class="min-w-0 flex-1 break-all text-xs text-gray-700 dark:text-gray-200">{{ url }}</span>
                      <button @click="removeTrustedUrl(url)" :title="t('Remove')"
                        class="material-icons rounded p-1 text-base text-gray-400 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-950">delete</button>
                    </li>
                  </ul>
                  <p x-show="!trustedUrls.length" class="mb-3 text-xs text-gray-400 dark:text-gray-500">
                    {{ t('No trusted registry configured: only the official MangaYomu repository can be added until one is listed here.') }}
                  </p>

                  <div class="flex gap-2">
                    <input id="adv-trusted" x-model="trustedDraft" @keyup.enter="addTrustedUrl" placeholder="https://…/registry.json"
                      class="min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
                    <button @click="addTrustedUrl" :disabled="!trustedDraft.trim()"
                      class="inline-flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-white cursor-pointer">
                      <span class="material-icons text-base">add</span>
                      {{ t('Add') }}
                    </button>
                  </div>
                  <p x-show="trustedError" class="mt-2 text-xs text-red-600 dark:text-red-400">{{ trustedError }}</p>
                </div>
              </section>

              <section>
                <h2 class="mb-3 flex items-center gap-2 text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">
                  <span class="material-icons text-lg">android</span>
                  {{ t('Android builds') }}
                </h2>
                <div class="rounded-xl border border-gray-200 dark:border-gray-700 p-4">
                  <p class="mb-3 text-xs leading-5 text-gray-500 dark:text-gray-400">
                    {{ t('An instance running from a repository checkout can build the Android app on demand. Turn this off to keep the host free of build runs.') }}
                  </p>
                  <button @click="toggleAndroidBuild" :aria-pressed="androidBuildEnabled"
                    class="flex w-full items-center gap-3 rounded-lg border border-gray-200 px-3 py-2.5 text-left transition-colors hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-900 cursor-pointer">
                    <span class="material-icons text-xl" :class="androidBuildEnabled ? 'text-blue-600' : 'text-gray-400'">{{ androidBuildEnabled ? 'toggle_on' : 'toggle_off' }}</span>
                    <span class="flex-1 text-sm font-medium text-gray-800 dark:text-gray-100">{{ t('Allow building on demand') }}</span>
                    <span x-show="!androidCanBuild" class="text-xs text-amber-600 dark:text-amber-400">{{ t('Not available here') }}</span>
                  </button>

                  <label class="mt-4 block text-sm font-medium text-gray-700 dark:text-gray-200" for="adv-builds-url">{{ t('Published builds URL') }}</label>
                  <input id="adv-builds-url" x-model="buildsUrl" :placeholder="buildsUrlDefault"
                    class="mt-1 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
                  <p class="mt-2 text-xs leading-5 text-gray-500 dark:text-gray-400">
                    {{ t('Serves the same build-info.json plus the APK, so an instance that never built the app can still offer the published build. Leave it empty to stop offering it.') }}
                  </p>
                  <p x-show="buildsUrlError" class="mt-2 text-xs text-red-600 dark:text-red-400">{{ buildsUrlError }}</p>
                </div>
              </section>

              <section>
                <button @click="saveAdminSettings" :disabled="busy || !adminSettings"
                  class="inline-flex items-center gap-2 rounded-lg bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 disabled:opacity-50 dark:bg-gray-200 dark:text-gray-900 dark:hover:bg-white cursor-pointer">
                  <span class="material-icons text-base">save</span>
                  {{ t('Save server settings') }}
                </button>
                <p x-show="errors" class="mt-3 text-sm text-red-600 dark:text-red-400">{{ errors }}</p>
                <p x-show="notice" class="mt-3 text-sm text-green-700 dark:text-green-300">{{ notice }}</p>
              </section>
            </template>
          </div>

          <!-- Data & Sync tab: sidebar on desktop, exclusive accordion on mobile -->
          <div x-show="activeTab === 'data'" class="max-w-3xl">
            <div class="sm:flex sm:gap-6">
              <!-- Desktop sidebar -->
              <nav class="hidden w-44 shrink-0 sm:block" :aria-label="t('Data & Sync')">
                <button @click="selectDataSection('backup')" :aria-current="dataSection === 'backup'"
                  :class="dataSection === 'backup'
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                    : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800'"
                  class="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors cursor-pointer">
                  <span class="material-icons text-lg">backup</span>
                  {{ t('Backup') }}
                </button>
                <button @click="selectDataSection('sync')" :aria-current="dataSection === 'sync'"
                  :class="dataSection === 'sync'
                    ? 'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300'
                    : 'text-gray-600 hover:bg-gray-50 dark:text-gray-300 dark:hover:bg-gray-800'"
                  class="mt-1 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors cursor-pointer">
                  <span class="material-icons text-lg">sync</span>
                  {{ t('Synchronization') }}
                </button>
              </nav>

              <div class="min-w-0 flex-1 space-y-4">
                <!-- Backup -->
                <div>
                  <button @click="selectDataSection('backup')" :aria-expanded="dataSection === 'backup'"
                    class="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-left text-sm font-medium text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 sm:hidden">
                    <span class="flex items-center gap-2">
                      <span class="material-icons text-lg">backup</span>
                      {{ t('Backup') }}
                    </span>
                    <span class="material-icons text-lg text-gray-400">{{ dataSection === 'backup' ? 'expand_less' : 'expand_more' }}</span>
                  </button>
                  <div x-show="dataSection === 'backup'" class="mt-3 sm:mt-0">
                    <backup-import-panel></backup-import-panel>
                  </div>
                </div>

                <!-- Synchronization -->
                <div>
                  <button @click="selectDataSection('sync')" :aria-expanded="dataSection === 'sync'"
                    class="flex w-full items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-left text-sm font-medium text-gray-800 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 sm:hidden">
                    <span class="flex items-center gap-2">
                      <span class="material-icons text-lg">sync</span>
                      {{ t('Synchronization') }}
                    </span>
                    <span class="material-icons text-lg text-gray-400">{{ dataSection === 'sync' ? 'expand_less' : 'expand_more' }}</span>
                  </button>
                  <div x-show="dataSection === 'sync'" class="mt-3 sm:mt-0">
                    <sync-panel></sync-panel>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- Extension-contributed tabs -->
          <div x-show="activeTab.startsWith('ext:')" class="max-w-xl space-y-8">
            <div class="mb-3 flex items-center gap-2">
              <span class="material-icons text-lg text-gray-400">extension</span>
              <h2 class="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400">{{ activeExtensionTitle }}</h2>
            </div>
            <div ref="extensionPanelHost" class="w-full"></div>
          </div>
        </div>

        <!-- Add repository modal -->
        <div x-show="repoModalOpen" class="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" :aria-modal="true">
          <div class="absolute inset-0 bg-black/60" @click="closeAddRepoModal"></div>
          <div class="relative z-10 w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-800">
            <div class="mb-4 flex items-center justify-between">
              <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">{{ t('Add repository') }}</h3>
              <button @click="closeAddRepoModal" :aria-label="t('Close')"
                class="rounded-lg p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">
                <span class="material-icons">close</span>
              </button>
            </div>
            <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200" for="repo-url">{{ t('Repository URL') }}</label>
            <input id="repo-url" x-model="repoModalUrl" placeholder="https://…/repository.json"
              class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
            <p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{{ t('Lets you browse and install the extensions it lists. Nothing is installed automatically. Only repositories listed in the trusted registries (Settings → Advanced) can be added.') }}</p>
            <p x-show="modalError" class="mt-3 text-sm text-red-600 dark:text-red-400">{{ modalError }}</p>
            <div class="mt-5 flex flex-wrap justify-end gap-2">
              <button @click="closeAddRepoModal"
                class="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 cursor-pointer">
                {{ t('Cancel') }}
              </button>
              <button @click="submitAddRepository" :disabled="busy || !repoModalUrl"
                class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer">
                {{ t('Add repository') }}
              </button>
              <button x-show="repoTrustOffer" @click="trustAndAddRepository" :disabled="busy"
                class="inline-flex items-center gap-1.5 rounded-lg border border-blue-600 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:border-blue-400 dark:text-blue-300 dark:hover:bg-blue-950 cursor-pointer">
                <span class="material-icons text-base">verified_user</span>
                {{ t('Trust this repository and add it') }}
              </button>
            </div>
          </div>
        </div>

        <!-- Add extension package modal -->
        <div x-show="packageModalOpen" class="fixed inset-0 z-[60] flex items-center justify-center p-4" role="dialog" :aria-modal="true">
          <div class="absolute inset-0 bg-black/60" @click="closeAddPackageModal"></div>
          <div class="relative z-10 w-full max-w-md rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-800">
            <div class="mb-4 flex items-center justify-between">
              <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">{{ t('Add extension') }}</h3>
              <button @click="closeAddPackageModal" :aria-label="t('Close')"
                class="rounded-lg p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">
                <span class="material-icons">close</span>
              </button>
            </div>

            <div class="mb-4 grid grid-cols-2 gap-1 rounded-xl bg-gray-100 p-1 dark:bg-gray-900" role="tablist">
              <button @click="setPackageMode('upload')" :aria-pressed="packageMode === 'upload'"
                class="rounded-lg px-3 py-2 text-sm font-medium transition-colors cursor-pointer"
                :class="packageMode === 'upload' ? 'bg-white text-gray-900 shadow dark:bg-gray-700 dark:text-gray-100' : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'">
                {{ t('Upload package') }}
              </button>
              <button @click="setPackageMode('url')" :aria-pressed="packageMode === 'url'"
                class="rounded-lg px-3 py-2 text-sm font-medium transition-colors cursor-pointer"
                :class="packageMode === 'url' ? 'bg-white text-gray-900 shadow dark:bg-gray-700 dark:text-gray-100' : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'">
                {{ t('Package URL') }}
              </button>
            </div>

            <div x-show="packageMode === 'upload'">
              <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200" for="pkg-file">{{ t('Package ZIP file') }}</label>
              <input id="pkg-file" type="file" accept=".zip" @change="onUploadPick($event)"
                class="w-full text-sm text-gray-700 dark:text-gray-200" />
              <p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{{ t('Upload a package ZIP from your device.') }}</p>
            </div>

            <div x-show="packageMode === 'url'">
              <label class="mb-1 block text-sm font-medium text-gray-700 dark:text-gray-200" for="pkg-url">{{ t('Package URL') }}</label>
              <input id="pkg-url" x-model="packageUrlInput" placeholder="https://…/package-1.0.0.zip"
                class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100" />
              <p class="mt-2 text-xs text-gray-400 dark:text-gray-500">{{ t('Install a package directly from a URL.') }}</p>
            </div>

            <p x-show="modalError" class="mt-3 text-sm text-red-600 dark:text-red-400">{{ modalError }}</p>

            <div class="mt-5 flex justify-end gap-2">
              <button @click="closeAddPackageModal"
                class="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-700 cursor-pointer">
                {{ t('Cancel') }}
              </button>
              <button @click="submitAddPackage"
                :disabled="busy || (packageMode === 'upload' ? !selectedPackageFile : !packageUrlInput)"
                class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 cursor-pointer">
                {{ t('Install') }}
              </button>
            </div>
          </div>
        </div>

        <section-footer current="settings"></section-footer>
      </div>
    `;
  },

  data() {
    return {
      activeTab: "general",
      // Data & Sync tab: one open section at a time (sidebar on desktop,
      // exclusive accordion on mobile).
      dataSection: "backup",
      tabs: [
        { id: "general", label: "General", icon: "tune", disabled: false },
        { id: "extensions", label: "Extensions", icon: "extension", disabled: false },
        { id: "advanced", label: "Advanced", icon: "settings_suggest", disabled: false },
        { id: "reader", label: "Reader", icon: "chrome_reader_mode", disabled: true },
        { id: "data", label: "Data & Sync", icon: "storage", disabled: false },
      ],
      scrollMode: getSavedScrollMode(),
      theme: isDark() ? "dark" : "light",
      serverAvailable: false,
      isAdmin: false,
      installedSources: [],
      repositories: [],
      busy: false,
      errors: "",
      // Add repository modal
      repoModalOpen: false,
      repoModalUrl: "",
      modalError: "",
      // True when the last refusal was "this repository is not trusted": the
      // modal then offers to trust it and retry.
      repoTrustOffer: false,
      // Add extension package modal
      packageModalOpen: false,
      packageMode: "upload",
      packageUrlInput: "",
      selectedPackageFile: null,
      // Advanced server settings
      adminSettings: null,
      newHome: "",
      trustedUrls: [],
      trustedDraft: "",
      trustedError: "",
      androidBuildEnabled: true,
      androidCanBuild: false,
      buildsUrl: "",
      buildsUrlDefault: "",
      buildsUrlError: "",
      notice: "",
      // Extension-contributed Settings tabs (mounted lazily on selection)
      extensionTabs: [],
      activeExtensionTitle: "",
    };
  },

  beforeDestroy() {
    this._unmountExtensionPanels();
  },

  init() {
    // Deep link support: /settings/<tab> opens that tab directly.
    var params = (this.$route && this.$route.params) || {};
    var requested = params.tab ? String(params.tab) : "";
    if (!requested) return;
    var tabs = this.data.tabs.value || [];
    for (var i = 0; i < tabs.length; i++) {
      if (tabs[i].id === requested && !tabs[i].disabled) {
        this.selectTab(tabs[i]);
        return;
      }
    }
  },

  _extensionComponents: [],
  _extensionMountId: 0,

  _unmountExtensionPanels() {
    this._extensionMountId += 1;
    var comps = this._extensionComponents || [];
    for (var i = 0; i < comps.length; i++) {
      var element = comps[i].$element;
      try { comps[i].$destroy(); } catch (e) {}
      if (element && element.parentNode) element.parentNode.removeChild(element);
    }
    this._extensionComponents = [];
  },

  selectTab(tab) {
    if (tab.disabled) return;
    this.data.activeTab.value = tab.id;
    if (tab.id === "extensions") this.loadExtensions();
    if (tab.id === "advanced") this.loadAdvancedSettings();
    if (String(tab.id).startsWith("ext:")) this.mountExtensionTab(String(tab.id));
    else this._unmountExtensionPanels();
  },

  selectDataSection(id) {
    this.data.dataSection.value = id;
  },

  // ----- Extension-contributed Settings tabs -----

  async loadExtensionTabs() {
    if (!this.data.serverAvailable.value) return;
    try {
      var contributions = await loadExtensionContributions();
      var records = contributions.settings || [];
      this.data.extensionTabs.value = records;
      if (records.length === 0) {
        this.data.activeExtensionTitle.value = "";
      }
      var dynamic = records.map(function (record) {
        return { id: "ext:" + record.packageId, label: record.name, icon: "extension", disabled: false };
      });
      var staticTabs = this.data.tabs.value.filter(function (tab) { return !String(tab.id).startsWith("ext:"); });
      this.data.tabs.value = staticTabs.concat(dynamic);
    } catch (err) {
      // Contribution loading must never break the Settings page.
    }
  },

  async mountExtensionTab(tabId) {
    this._unmountExtensionPanels();
    var mountId = this._extensionMountId;
    var records = this.data.extensionTabs.value || [];
    var packageId = tabId.replace(/^ext:/, "");
    var record = null;
    for (var i = 0; i < records.length; i++) {
      if (records[i].packageId === packageId) { record = records[i]; break; }
    }
    if (!record) return;
    this.data.activeExtensionTitle.value = record.name;
    var host = this.refs.extensionPanelHost;
    if (!host) return;
    var comp = await createExtensionComponent(record.info, "settings", this);
    if (!comp) return;
    if (mountId !== this._extensionMountId || this.data.activeTab.value !== tabId) {
      try { comp.$destroy(); } catch (e) {}
      return;
    }
    this._extensionComponents.push(comp);
    comp.appendTo(host);
  },

  setScrollMode(mode) {
    this.data.scrollMode.value = mode;
    try {
      localStorage.setItem(SCROLL_MODE_KEY, mode);
    } catch (e) {}
  },

  setTheme(theme) {
    this.data.theme.value = theme;
    setThemePreference(theme);
  },

  async loadExtensions() {
    var connection = getConnection();
    this.data.serverAvailable.value = Boolean(connection.serverUrl);
    this.data.errors.value = "";
    if (!connection.serverUrl) return;
    try {
      var [installed, repos, me] = await Promise.all([
        extensions.listSettings(),
        extensions.listRepositories(),
        remoteAuth.me(),
      ]);
      this.data.installedSources.value = installed;
      this.data.repositories.value = repos.repositories || [];
      this.data.isAdmin.value = !!(me.user && me.user.is_admin);
      await this.loadExtensionTabs();
    } catch (err) {
      this.data.errors.value = err.message;
    }
  },

  async loadRepositories() {
    try {
      var repos = await extensions.listRepositories();
      this.data.repositories.value = repos.repositories || [];
    } catch (err) {
      this.data.errors.value = err.message;
    }
  },

  // ----- Advanced server settings -----

  async loadAdvancedSettings() {
    var connection = getConnection();
    this.data.serverAvailable.value = Boolean(connection.serverUrl);
    this.data.errors.value = "";
    this.data.notice.value = "";
    if (!connection.serverUrl) return;
    try {
      var me = await remoteAuth.me();
      this.data.isAdmin.value = !!(me.user && me.user.is_admin);
      if (!this.data.isAdmin.value) {
        this.data.adminSettings.value = null;
        return;
      }
      var settings = await extensions.getAdminSettings();
      this.data.adminSettings.value = settings;
      this.data.newHome.value = settings.extensionsHome;
      this.applyTrustedSettings(settings);
      this.applyBuildSettings(settings);
    } catch (err) {
      this.data.errors.value = err.message;
    }
  },

  /**
   * Load the trusted registry list into the editor. Servers older than the
   * multi-registry change only report the single legacy URL, so it is folded
   * back into a one-entry list instead of showing an empty field.
   */
  applyTrustedSettings(settings) {
    var urls = Array.isArray(settings.trustedRegistryUrls) ? settings.trustedRegistryUrls.slice() : [];
    if (urls.length === 0 && settings.trustedRegistryUrl) urls = [settings.trustedRegistryUrl];
    this.data.trustedUrls.value = urls;
    this.data.trustedDraft.value = "";
    this.data.trustedError.value = "";
  },

  /** Writes go through the signal: a bare assignment in a template writes to
   *  the evaluation scope, not to the component state. */
  toggleAndroidBuild() {
    this.data.androidBuildEnabled.value = !this.data.androidBuildEnabled.value;
  },

  applyBuildSettings(settings) {    this.data.androidBuildEnabled.value = settings.androidBuildEnabled !== false;
    this.data.androidCanBuild.value = !!settings.androidCanBuild;
    this.data.buildsUrl.value = settings.androidBuildsUrl || "";
    this.data.buildsUrlDefault.value = settings.androidBuildsUrlDefault || "";
    this.data.buildsUrlError.value = "";
  },

  addTrustedUrl() {
    var url = String(this.data.trustedDraft.value || "").trim();
    this.data.trustedError.value = "";
    if (!url) return;
    if (!/^https:\/\//.test(url)) {
      this.data.trustedError.value = globals.t("Trusted registry URLs must use HTTPS");
      return;
    }
    if (this.data.trustedUrls.value.includes(url)) {
      this.data.trustedError.value = globals.t("That registry is already in the list");
      return;
    }
    this.data.trustedUrls.value = this.data.trustedUrls.value.concat([url]);
    this.data.trustedDraft.value = "";
  },

  removeTrustedUrl(url) {
    this.data.trustedError.value = "";
    this.data.trustedUrls.value = this.data.trustedUrls.value.filter(function (entry) { return entry !== url; });
  },

  async saveAdminSettings() {
    if (!this.data.isAdmin.value) return;
    var current = this.data.adminSettings.value;
    if (!current) return;
    this.data.busy.value = true;
    this.data.errors.value = "";
    this.data.notice.value = "";
    try {
      var body = {};
      if (this.data.newHome.value.trim() !== current.extensionsHome) {
        body.extensionsHome = this.data.newHome.value.trim();
      }
      var urls = this.data.trustedUrls.value;
      var savedUrls = current.trustedRegistryUrls || [];
      if (JSON.stringify(urls) !== JSON.stringify(savedUrls)) {
        // Adding a URL only edits the list: it is persisted by this save.
        body.trustedRegistryUrls = urls;
      }
      if (this.data.androidBuildEnabled.value !== current.androidBuildEnabled) {
        body.androidBuildEnabled = this.data.androidBuildEnabled.value;
      }
      var buildsUrl = String(this.data.buildsUrl.value || "").trim().replace(/\/+$/, "");
      this.data.buildsUrlError.value = "";
      if (buildsUrl && !/^https?:\/\//.test(buildsUrl)) {
        this.data.buildsUrlError.value = globals.t("The builds URL must start with http:// or https://");
        this.data.busy.value = false;
        return;
      }
      if (buildsUrl !== (current.androidBuildsUrl || "")) {
        body.androidBuildsUrl = buildsUrl;
      }
      if (Object.keys(body).length === 0) {
        this.data.notice.value = globals.t("Server settings unchanged");
        return;
      }
      await extensions.setAdminSettings(body);
      var settings = await extensions.getAdminSettings();
      this.data.adminSettings.value = settings;
      this.data.newHome.value = settings.extensionsHome;
      this.applyTrustedSettings(settings);
      this.applyBuildSettings(settings);
      this.data.notice.value = globals.t("Server settings saved");
    } catch (err) {
      this.data.errors.value = err.message;
    } finally {
      this.data.busy.value = false;
    }
  },

  // ----- Add repository modal -----

  openAddRepoModal() {
    this.data.repoModalUrl.value = "";
    this.data.modalError.value = "";
    this.data.repoTrustOffer.value = false;
    this.data.repoModalOpen.value = true;
  },

  closeAddRepoModal() {
    this.data.repoModalOpen.value = false;
    this.data.modalError.value = "";
    this.data.repoTrustOffer.value = false;
  },

  async submitAddRepository() {
    if (!this.data.isAdmin.value) return;
    this.data.busy.value = true;
    this.data.modalError.value = "";
    this.data.repoTrustOffer.value = false;
    try {
      await this._addRepository(this.data.repoModalUrl.value.trim());
    } catch (err) {
      this.data.modalError.value = err.message;
      // The server refused because nobody trusts this repository yet. Offer to
      // trust it from here instead of sending the admin to another tab.
      this.data.repoTrustOffer.value = err.code === "repository-not-trusted";
    } finally {
      this.data.busy.value = false;
    }
  },

  /**
   * Trust the repository opened in the modal and add it in one step.
   *
   * The trusted list stays the single source of truth: the URL is appended to
   * the list the server reports right now (never to a stale local copy), then
   * the add is retried. The decision stays explicit and is recorded.
   */
  async trustAndAddRepository() {
    if (!this.data.isAdmin.value) return;
    var url = this.data.repoModalUrl.value.trim();
    if (!url) return;
    this.data.busy.value = true;
    this.data.modalError.value = "";
    try {
      var settings = await extensions.getAdminSettings();
      var urls = Array.isArray(settings.trustedRegistryUrls) ? settings.trustedRegistryUrls.slice() : [];
      if (!urls.includes(url)) urls.push(url);
      await extensions.setAdminSettings({ trustedRegistryUrls: urls });
      await this._addRepository(url);
    } catch (err) {
      this.data.modalError.value = err.message;
    } finally {
      this.data.busy.value = false;
    }
  },

  /** Shared tail, so "Add repository" and "Trust and add" cannot drift apart. */
  async _addRepository(url) {
    await extensions.adminAddRepository(url);
    this.closeAddRepoModal();
    await this.loadRepositories();
  },

  async removeRepository(id) {
    if (!this.data.isAdmin.value) return;
    this.data.busy.value = true;
    this.data.errors.value = "";
    try {
      await extensions.adminRemoveRepository(id);
      await this.loadRepositories();
    } catch (err) {
      this.data.errors.value = err.message;
    } finally {
      this.data.busy.value = false;
    }
  },

  // ----- Add extension package modal -----

  openAddPackageModal() {
    this.data.packageMode.value = "upload";
    this.data.packageUrlInput.value = "";
    this._selectedPackageFile = null;
    this.data.selectedPackageFile.value = null;
    this.data.modalError.value = "";
    this.data.packageModalOpen.value = true;
  },

  closeAddPackageModal() {
    this.data.packageModalOpen.value = false;
    this.data.modalError.value = "";
  },

  setPackageMode(mode) {
    this.data.packageMode.value = mode;
    this.data.modalError.value = "";
  },

  onUploadPick(event) {
    var file = event && event.target && event.target.files && event.target.files[0];
    this._selectedPackageFile = file || null;
    // TinyBubble turns object signals into Proxies. Keep the native File outside
    // reactive state so FormData sends bytes instead of the string "[object File]".
    this.data.selectedPackageFile.value = file ? file.name : null;
    this.data.modalError.value = "";
  },

  async submitAddPackage() {
    if (this.data.packageMode.value === "upload") {
      if (!this._selectedPackageFile) return;
      await this.uploadPackage(this._selectedPackageFile);
    } else {
      var url = this.data.packageUrlInput.value.trim();
      if (!url) return;
      await this.installUrl(url);
    }
  },

  async uploadPackage(file) {
    this.data.busy.value = true;
    this.data.modalError.value = "";
    try {
      await extensions.adminUpload(file);
      this.closeAddPackageModal();
      await this.reloadAfterInstall();
    } catch (err) {
      this.data.modalError.value = err.message;
    } finally {
      this.data.busy.value = false;
    }
  },

  async installUrl(url) {
    this.data.busy.value = true;
    this.data.modalError.value = "";
    try {
      await extensions.adminInstallUrl(url);
      this.closeAddPackageModal();
      await this.reloadAfterInstall();
    } catch (err) {
      this.data.modalError.value = err.message;
    } finally {
      this.data.busy.value = false;
    }
  },

  async installRepoPackage(repo, packageUrl) {
    this.data.busy.value = true;
    this.data.errors.value = "";
    try {
      await extensions.installRepositoryPackage(repo.id, packageUrl);
      await this.reloadAfterInstall();
    } catch (err) {
      this.data.errors.value = err.message;
    } finally {
      this.data.busy.value = false;
    }
  },

  async removeExtension(src) {
    if (!this.data.isAdmin.value || !src || !src.packageId || this.data.busy.value) return;
    var message = globals.t("Remove extension %s for every user?", src.name);
    if (typeof window !== "undefined" && !window.confirm(message)) return;
    this.data.busy.value = true;
    this.data.errors.value = "";
    try {
      await extensions.adminRemovePackage(src.packageId);
      this._unmountExtensionPanels();
      if (String(this.data.activeTab.value).startsWith("ext:")) {
        this.data.activeTab.value = "extensions";
      }
      await this.reloadAfterInstall();
    } catch (err) {
      this.data.errors.value = err.message;
    } finally {
      this.data.busy.value = false;
    }
  },

  async toggleSource(sourceId, enabled) {
    try {
      await extensions.setEnabled(sourceId, enabled);
      this.data.installedSources.value = this.data.installedSources.value.map(function (src) {
        return src.id === sourceId ? Object.assign({}, src, { enabled: enabled }) : src;
      });
      await this.loadRepositories();
      await this.loadExtensionTabs();
    } catch (err) {
      this.data.errors.value = err.message;
    }
  },

  async reloadAfterInstall() {
    var [installed, repos] = await Promise.all([
      extensions.listSettings(),
      extensions.listRepositories(),
    ]);
    this.data.installedSources.value = installed;
    this.data.repositories.value = repos.repositories || [];
    await this.loadExtensionTabs();
  },
};

export default Settings;
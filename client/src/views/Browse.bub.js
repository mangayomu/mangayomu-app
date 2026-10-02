import { globals, tick } from "tinybubble";
import { extensions, manga, auth, favorites as favApi, imageUrl } from "../api.ts";
import { getConnection, setCatalogTransport } from "../connection";
import { getSourceLanguage, setSourceLanguage } from "../source-languages";
import { router } from "../App.bub.js";
import { loadAccountEmail, notifySessionChanged, offSessionChanged, onSessionChanged } from "../session.js";
import SectionFooter from "../components/SectionFooter.bub.js";
import AccountSwitcher from "../components/AccountSwitcher.bub.js";
import { selectBrowseSource } from "../browse-source-selection.js";
import { loadExtensionContributions, browseContributionsForSource, createExtensionComponent } from "../extensions/extension-hub.js";

var SOURCE_STORAGE_KEY = "manga-source";
var SOURCES_CACHE_KEY = "manga-sources-cache-v2";
var DEFAULT_SOURCES = [];

// Browse cache via sessionStorage (survives Android tab suspension)
var BROWSE_CACHE_KEY = "manga-browse-cache";
var _lastScrollUpdatePos = 0;

function _saveBrowseCache(data) {
  try {
    sessionStorage.setItem(BROWSE_CACHE_KEY, JSON.stringify(data));
  } catch (e) {}
}

function _loadBrowseCache() {
  try {
    var raw = sessionStorage.getItem(BROWSE_CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function _clearBrowseCache() {
  try {
    sessionStorage.removeItem(BROWSE_CACHE_KEY);
  } catch (e) {}
}

function _loadSourcesCache() {
  try {
    var sources = JSON.parse(localStorage.getItem(SOURCES_CACHE_KEY) || "null");
    return Array.isArray(sources) && sources.length > 0 ? sources : DEFAULT_SOURCES.slice();
  } catch (e) {
    return DEFAULT_SOURCES.slice();
  }
}

function _saveSourcesCache(sources) {
  try {
    localStorage.setItem(SOURCES_CACHE_KEY, JSON.stringify(sources));
  } catch (e) {}
}

window.addEventListener("hashchange", function () {
  var hash = window.location.hash;
  // Keep cache when navigating to/from manga, reader, or browse itself
  if (hash.indexOf("#/manga/") === 0 || hash.indexOf("#/reader/") === 0 || hash.indexOf("#/browse/") === 0) {
    return;
  }
  // Navigating to favorites, import, settings, etc. — invalidate
  _clearBrowseCache();
});

function loadDefaultSource() {
  try {
    var saved = localStorage.getItem(SOURCE_STORAGE_KEY);
    if (saved) return saved;
  } catch (err) {}
  return "";
}

function saveDefaultSource(src) {
  try {
    localStorage.setItem(SOURCE_STORAGE_KEY, src);
  } catch (err) {}
}

const Browse = {
  name: "Browse",

  components: {
    "section-footer": SectionFooter,
    "account-switcher": AccountSwitcher,
  },

  template() {
    return /*html*/`
      <div class="min-h-[100dvh] flex flex-col">
        <div class="section-page-content p-4 sm:p-6 max-w-6xl mx-auto flex-1 w-full">
        <!-- Header: title + user on one line, search below -->
        <div class="mb-4 sm:mb-6 flex flex-col gap-2">
          <!-- Top row: icon + source selector + user -->
          <div class="flex items-center gap-2">
            <span class="material-icons text-2xl sm:text-3xl text-blue-600 shrink-0">menu_book</span>
            <div class="flex items-center gap-1">
              <select ref="sourceSelect"
                x-model="source"
                @change="switchSource($event)"
                class="text-xl sm:text-2xl font-bold bg-transparent border-none focus:outline-none cursor-pointer truncate">
                <option x-for="src in sources" :key="src.id" :value="src.id">
                  {{src.name}}
                </option>
              </select>
              <select ref="sourceLanguageSelect" x-show="sourceLanguages.length > 1" x-model="sourceLanguage" @change="changeSourceLanguage($event)"
                :title="t('Source language')" :aria-label="t('Source language')"
                class="h-9 w-[4.75rem] rounded-lg border border-gray-200 bg-white px-2 text-sm font-medium text-gray-700 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100 dark:focus:border-blue-500 dark:focus:ring-blue-950">
                <option x-for="language in sourceLanguages" :key="language.code" :value="language.code">{{language.flag}} {{language.code.toUpperCase()}}</option>
              </select>
            </div>

            <!-- Extension-contributed Browse action (e.g. Local Source cog) -->
            <div data-browse-extension></div>

            <div class="ml-auto flex items-center gap-0 shrink-0">
              <account-switcher></account-switcher>
            </div>
          </div>

          <!-- Search inside input -->
          <div class="relative w-full">
            <input ref="searchInput"
              type="text"
              :placeholder="t('Search manga...')"
              class="w-full sm:w-72 border rounded-lg pl-3 pr-10 py-2 text-sm"
              @keydown="onSearchKeydown"
            />
            <button @click="doSearch"
              class="absolute right-1 top-1/2 -translate-y-1/2 p-1.5 rounded-md hover:bg-gray-100 text-gray-500">
              <span class="material-icons text-xl">search</span>
            </button>
          </div>
        </div>

        <!-- Server-required empty state (no sources enabled on a server) -->
        <div x-show="!sources.length && !loading" class="mx-auto mt-12 max-w-md flex flex-col items-center gap-3 text-center">
          <span class="material-icons text-5xl text-gray-300 dark:text-gray-600">extension</span>
          <template x-if="needsLogin">
            <div class="flex flex-col items-center gap-3">
              <h2 class="text-lg font-semibold text-gray-800 dark:text-gray-100">{{ t('Sign in required') }}</h2>
              <p class="text-sm leading-5 text-gray-500 dark:text-gray-400">{{ t('Sign in to your server account to load its enabled sources.') }}</p>
              <button @click="openRemoteConnection" class="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white shadow-sm hover:bg-blue-700">
                {{ t('Sign in to server') }} <span class="material-icons text-base">login</span>
              </button>
            </div>
          </template>
          <template x-if="!needsLogin && emptyReason === 'no-extension'">
            <div class="flex flex-col items-center gap-3">
              <h2 class="text-lg font-semibold text-gray-800 dark:text-gray-100">{{ t('No extension is installed') }}</h2>
              <p class="text-sm leading-5 text-gray-500 dark:text-gray-400">{{ t('This server is connected but has no source installed yet. Install one from the official repository in Settings → Extensions.') }}</p>
              <button @click="openSettingsExtensions" class="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white shadow-sm hover:bg-blue-700">
                {{ t('Open Settings') }} <span class="material-icons text-base">settings</span>
              </button>
            </div>
          </template>
          <template x-if="!needsLogin && emptyReason === 'sources-disabled'">
            <div class="flex flex-col items-center gap-3">
              <h2 class="text-lg font-semibold text-gray-800 dark:text-gray-100">{{ t('No source is enabled') }}</h2>
              <p class="text-sm leading-5 text-gray-500 dark:text-gray-400">{{ t('This account has no enabled source. Enable one from Settings → Extensions.') }}</p>
              <button @click="openSettingsExtensions" class="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white shadow-sm hover:bg-blue-700">
                {{ t('Open Settings') }} <span class="material-icons text-base">settings</span>
              </button>
            </div>
          </template>
          <template x-if="!needsLogin && emptyReason === 'no-server'">
            <div class="flex flex-col items-center gap-3">
              <h2 class="text-lg font-semibold text-gray-800 dark:text-gray-100">{{ t('No server connected') }}</h2>
              <p class="text-sm leading-5 text-gray-500 dark:text-gray-400">{{ t('Connect to a MangaYomu server to browse its sources.') }}</p>
              <button @click="openRemoteConnection" class="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white shadow-sm hover:bg-blue-700">
                {{ t('Connect a server') }} <span class="material-icons text-base">dns</span>
              </button>
            </div>
          </template>
          <template x-if="!needsLogin && !emptyReason">
            <div class="flex flex-col items-center gap-3">
              <h2 class="text-lg font-semibold text-gray-800 dark:text-gray-100">{{ t('No sources available') }}</h2>
              <p class="text-sm leading-5 text-gray-500 dark:text-gray-400">{{ t('Enable a source from Settings to start browsing.') }}</p>
              <button @click="openSettingsExtensions" class="mt-2 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 font-medium text-white shadow-sm hover:bg-blue-700">
                {{ t('Open Settings') }} <span class="material-icons text-base">settings</span>
              </button>
            </div>
          </template>
        </div>

        <!-- Manga grid -->
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
          <div x-for="item in items" :key="item.id" class="cursor-pointer" @click="openManga(item)">
            <div class="rounded-lg shadow overflow-hidden hover:shadow-lg transition-shadow"
              :class="favMap[item.id] ? 'ring-2 ring-red-400' : 'bg-white dark:bg-gray-800'">
              <div class="bg-white aspect-[3/4] flex items-center justify-center overflow-hidden relative">
                <template x-if="favMap[item.id]">
                  <span class="absolute top-1 right-1 material-icons text-red-400 text-sm">favorite</span>
                </template>
                <template x-if="item.coverUrl">
                  <img :src="proxyImg(item.coverUrl)" class="w-full h-full object-cover" loading="lazy" />
                </template>
                <template x-if="!item.coverUrl">
                  <span class="material-icons text-6xl text-gray-400">auto_stories</span>
                </template>
              </div>
              <div class="p-2 bg-white dark:bg-gray-800">
                <p class="text-xs sm:text-sm font-medium line-clamp-2">{{item.title}}</p>
              </div>
            </div>
          </div>
        </div>

        <!-- Immediate startup feedback: sources remain available while Node starts. -->
        <div x-show="loading && !items.length" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
          <div x-for="skeleton in skeletonItems" :key="skeleton" class="rounded-lg overflow-hidden bg-gray-100 dark:bg-gray-800 animate-pulse">
            <div class="aspect-[3/4] bg-gray-200 dark:bg-gray-700"></div>
            <div class="p-2 space-y-2"><div class="h-3 bg-gray-200 dark:bg-gray-700 rounded"></div><div class="h-3 w-2/3 bg-gray-200 dark:bg-gray-700 rounded"></div></div>
          </div>
        </div>

        <div x-show="loadError && !items.length" class="mx-auto mt-8 max-w-md space-y-3 text-sm">
          <section x-show="directRequestBlocked" class="rounded-2xl border border-blue-200 bg-gradient-to-br from-blue-50 to-indigo-50 p-5 shadow-sm dark:border-blue-900/70 dark:from-slate-900 dark:to-indigo-950">
            <div class="flex gap-3">
              <span class="material-icons mt-0.5 text-2xl text-blue-600">cloud_off</span>
              <div class="min-w-0 flex-1">
                <h2 class="font-semibold text-gray-900 dark:text-gray-100">{{ t('Direct requests are unavailable') }}</h2>
                <p class="mt-1 leading-5 text-gray-600 dark:text-gray-300">{{ t('This source did not allow the browser to load its catalog directly. Continue through a MangaYomu server without changing account.') }}</p>
                <button x-show="remoteServerUrl" @click="useRemoteRequests" class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 font-medium text-white shadow-sm hover:bg-blue-700">
                  {{ t('Use remote requests') }} <span class="material-icons text-base">arrow_forward</span>
                </button>
                <button x-show="!remoteServerUrl" @click="openRemoteConnection" class="mt-4 inline-flex items-center gap-1.5 rounded-lg bg-blue-600 px-3 py-2 font-medium text-white shadow-sm hover:bg-blue-700">
                  {{ t('Connect a server') }} <span class="material-icons text-base">dns</span>
                </button>
              </div>
            </div>
          </section>
          <div class="flex flex-col items-center gap-3 text-gray-500 dark:text-gray-400">
            <span>{{ t(loadError) }}</span>
            <div class="flex gap-2">
              <button x-show="needsLogin" @click="openRemoteConnection" class="rounded bg-blue-600 px-3 py-2 text-sm text-white hover:bg-blue-700">{{ t('Sign in to server') }}</button>
              <button @click="retryLoad" class="rounded border border-gray-300 px-3 py-2 text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200 dark:hover:bg-gray-800">{{ t('Retry') }}</button>
            </div>
          </div>
        </div>

        <!-- Pagination (page mode only) -->
        <div x-show="scrollMode === 'page'" class="flex justify-center mt-6 gap-2 items-center">
          <button @click="goToFirstPage" x-show="page > 1"
            class="w-9 h-9 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600 text-sm dark:text-gray-300">
            <span class="material-icons text-base">first_page</span>
          </button>
          <button @click="prevPage" x-show="page > 1"
            class="w-9 h-9 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600 text-sm dark:text-gray-300">
            <span class="material-icons text-base">arrow_back</span>
          </button>
          <span class="text-sm text-gray-600 dark:text-gray-400 mx-1">{{ t('Page %s', page) }}</span>
          <button @click="nextPage"
            class="w-9 h-9 flex items-center justify-center bg-gray-200 dark:bg-gray-700 rounded hover:bg-gray-300 dark:hover:bg-gray-600 text-sm dark:text-gray-300">
            <span class="material-icons text-base">arrow_forward</span>
          </button>
        </div>



      </div>
        <section-footer current="browse"></section-footer>
      </div>
    `;
  },

  data() {
    return {
      sources: _loadSourcesCache(),
      source: "",
      items: [],
      page: 1,
      searchQuery: "",
      userEmail: "",
      favMap: {},  // manga_id -> boolean (favorited)
      scrollMode: "scroll",
      loading: false,
      loadError: "",
      needsLogin: false,
      // Why the catalog is empty when it is: "" | "no-server" |
      // "no-extension" (server has nothing installed) | "sources-disabled".
      emptyReason: "",
      directRequestBlocked: false,
      remoteServerUrl: "",
      sourceLanguage: "",
      sourceLanguages: [],
      skeletonItems: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      allLoaded: false,
      darkTheme: false,
    };
  },

  async init() {
    this._isDestroyed = false;
    // RouterView can replace an initial route instance during the same
    // navigation. Yield before consuming shared cache or starting requests.
    await Promise.resolve();
    if (this._isDestroyed) return;

    try {
      var savedMode = localStorage.getItem("manga-scroll-mode");
      if (savedMode === "page" || savedMode === "scroll") {
        this.data.scrollMode.value = savedMode;
      }
    } catch (e) {}

    // The server is the only source runtime in this milestone. A connected
    // server provides the enabled source list; direct mode has none.
    this._onSessionChanged = () => {
      this._onAccountChanged();
    };
    onSessionChanged(this._onSessionChanged);

    this._loadUser();
    await this._refreshSources();
    if (this._isDestroyed) return;

    if (!this._selectSource()) return;

    // Try to restore saved Browse state (from MangaDetail/Reader back-nav).
    var browseCache = _loadBrowseCache();
    if (browseCache && browseCache.source === this.data.source.value &&
        browseCache.searchQuery === this.data.searchQuery.value &&
        browseCache.sourceLanguage === this.data.sourceLanguage.value) {
      this.data.items.value = browseCache.items;
      this.data.page.value = browseCache.page || 1;
      this.data.favMap.value = browseCache.favMap || {};
      this.data.scrollMode.value = browseCache.scrollMode || this.data.scrollMode.value;
      this.data.allLoaded.value = browseCache.allLoaded || false;
      _clearBrowseCache();
      tick();
      requestAnimationFrame(function () {
        window.scrollTo(0, browseCache.scrollY || 0);
      });
      this._setupScrollObserver();
      return;
    }

    // Coming from non-manga/reader sections — clear stale query params.
    this._clearBrowseQuery();
    var pageParam = this.$route.params.page;
    if (pageParam) {
      var parsed = parseInt(pageParam, 10);
      if (!isNaN(parsed) && parsed > 0) this.data.page.value = parsed;
    }

    await this.loadPage();
    if (this._isDestroyed) return;
    this._syncPageUrl(this.data.page.value);
    this._setupScrollObserver();
  },

  /**
   * Pick the source for the current route and mount its extension.
   * @returns {boolean} false when the session exposes no source at all
   */
  _selectSource() {
    var sourcesList = this.data.sources.value;
    if (sourcesList.length === 0) return false;

    var routeSource = this.$route.params.source || "";
    var saved = routeSource ? "" : loadDefaultSource();
    this.data.source.value = selectBrowseSource(sourcesList, routeSource, saved);
    saveDefaultSource(this.data.source.value);
    this._syncSourceLanguage();
    this.mountBrowseExtension();
    return true;
  },

  /**
   * A sign-in, sign-out or account switch happened while this view is mounted:
   * re-read the source list through the new session and restart the catalog.
   */
  async _onAccountChanged() {
    if (this._isDestroyed) return;
    this.data.needsLogin.value = false;
    this.data.loadError.value = "";
    this.data.emptyReason.value = "";
    this.data.allLoaded.value = false;
    this.data.items.value = [];
    this._loadUser();
    await this._refreshSources();
    if (this._isDestroyed) return;
    if (!this._selectSource()) return;
    await this.loadPage();
    if (this._isDestroyed) return;
    this._syncPageUrl(this.data.page.value);
    this._setupScrollObserver();
  },

  async _loadUser() {
    var email = await loadAccountEmail();
    if (!this._isDestroyed) this.data.userEmail.value = email;
  },

  async _refreshSources() {
    this.data.needsLogin.value = false;
    this.data.emptyReason.value = "";
    try {
      var sources = await extensions.list();
      if (this._isDestroyed || !Array.isArray(sources)) return;
      this.data.sources.value = sources;
      // The connected server's list is authoritative in this milestone: stale
      // cached source IDs must never survive into the source selector or a
      // catalog request, even when the list is empty.
      _saveSourcesCache(sources);
      if (sources.length === 0) await this._explainEmptySources();
    } catch (e) {
      if (this._isDestroyed) return;
      // The server refused (e.g. not signed in) or is unreachable. Never fall
      // back to a cached source the server did not provide in this build.
      this.data.sources.value = [];
      _saveSourcesCache([]);
      this.data.needsLogin.value = Boolean(e && e.status === 401);
      if (!this.data.needsLogin.value) await this._explainEmptySources();
    }
  },

  /**
   * A connected server with no source can mean two very different things for
   * the reader: nothing is installed yet, or nothing is enabled for this
   * account. Only the server knows which, so ask it before showing an empty
   * state that points at the wrong place.
   */
  async _explainEmptySources() {
    var connection = getConnection();
    if (connection.transport !== "server" || !connection.serverUrl) {
      this.data.emptyReason.value = "no-server";
      return;
    }
    try {
      var installed = await extensions.listSettings();
      if (this._isDestroyed) return;
      this.data.emptyReason.value = Array.isArray(installed) && installed.length > 0
        ? "sources-disabled"
        : "no-extension";
    } catch (e) {
      if (this._isDestroyed) return;
      this.data.emptyReason.value = "sources-disabled";
    }
  },

  openSettingsExtensions() {
    router.navigate("/settings/extensions");
  },

  proxyImg(url) {
    return imageUrl(url, this.data.source.value);
  },

  _syncPageUrl(page) {
    var hash = "#/browse/" + this.data.source.value + "/" + page;
    if (window.location.hash !== hash) {
      history.replaceState(null, "", hash);
    }
  },

  _syncSourceLanguage() {
    var source = this.data.sources.value.find(function (item) { return item.id === this.data.source.value; }, this);
    if (!source) return;
    this.data.sourceLanguages.value = source.languages;
    this.data.sourceLanguage.value = getSourceLanguage(source.id, source.languages, source.defaultLanguage);
    tick();
    this.refs.sourceLanguageSelect.value = this.data.sourceLanguage.value;
  },

  switchSource(event) {
    var src = event && event.target ? event.target.value : this.data.source.value;
    this.data.source.value = src;
    this._syncSourceLanguage();
    this.data.searchQuery.value = "";
    this.data.page.value = 1;
    saveDefaultSource(src);
    router.navigate("/browse/" + src + "/1");
    this.mountBrowseExtension();
  },

  async mountBrowseExtension() {
    this._unmountBrowseExtension();
    if (this._isDestroyed) return;
    var sourceId = this.data.source.value;
    var slot = this.$element && this.$element.querySelector("[data-browse-extension]");
    if (!slot) return;
    try {
      await loadExtensionContributions();
      if (this._isDestroyed) return;
      var records = browseContributionsForSource(sourceId);
      if (records.length === 0) return;
      var comp = await createExtensionComponent(records[0].info, "browse", this);
      if (!comp || this._isDestroyed) return;
      this._browseExtComp = comp;
      requestAnimationFrame(function () { comp.appendTo(slot); });
    } catch (err) {
      // A failing extension contribution must never break the catalog.
    }
  },

  _unmountBrowseExtension() {
    if (this._browseExtComp) {
      try { this._browseExtComp.$destroy(); } catch (e) {}
      this._browseExtComp = null;
    }
  },

  changeSourceLanguage(event) {
    var language = event && event.target ? event.target.value : this.data.sourceLanguage.value;
    this.data.sourceLanguage.value = language;
    setSourceLanguage(this.data.source.value, language);
    _clearBrowseCache();
    this.data.page.value = 1;
    this.data.items.value = [];
    this.data.allLoaded.value = false;
    this.loadPage();
    this._syncPageUrl(1);
  },

  async loadPage(append) {
    var src = this.data.source.value;
    var q = this.data.searchQuery.value;
    var p = this.data.page.value;
    // A language/source/search change can happen while an earlier request is
    // in flight. Only the newest response is allowed to change the grid.
    var requestId = (this._browseRequestId || 0) + 1;
    this._browseRequestId = requestId;
    var language = this.data.sourceLanguage.value;

    this.data.loading.value = true;
    this.data.loadError.value = "";
    this.data.directRequestBlocked.value = false;

    try {
      var newItems;
      if (q) {
        newItems = await manga.search(src, q, p, language);
      } else {
        newItems = await manga.list(src, p, language);
      }

      if (this._isDestroyed || requestId !== this._browseRequestId) return;

      // Catalog pages are pages of chapters, not pages of distinct manga.
      // A title can cross an offset boundary, so dedupe each append by the
      // source/id pair rather than rendering the same card repeatedly.
      var existing = append ? this.data.items.value : [];
      var known = {};
      for (var existingIndex = 0; existingIndex < existing.length; existingIndex++) {
        known[existing[existingIndex].source + ":" + existing[existingIndex].id] = true;
      }
      var uniqueItems = [];
      for (var itemIndex = 0; itemIndex < newItems.length; itemIndex++) {
        var item = newItems[itemIndex];
        var key = item.source + ":" + item.id;
        if (!known[key]) {
          known[key] = true;
          uniqueItems.push(item);
        }
      }

      if (append) {
        this.data.items.value = existing.concat(uniqueItems);
        this._checkFavorites(uniqueItems);
      } else {
        this.data.items.value = uniqueItems;
        this._checkFavorites();
      }

      // A short page can still contain a full duplicate chapter page and
      // repeat manga. Stop only when the source itself returns no rows.
      if (newItems.length === 0) this.data.allLoaded.value = true;
    } catch (err) {
      if (!this._isDestroyed && requestId === this._browseRequestId) {
        // Stop the infinite-scroll autofill on error so it cannot re-request
        // the same page forever. It resumes on retry or a source/search change.
        this.data.allLoaded.value = true;
        var connection = getConnection();
        var failedDirectRequest = connection.transport === "direct" && /failed to fetch|networkerror|cors/i.test(String(err?.message || err));
        this.data.directRequestBlocked.value = failedDirectRequest;
        this.data.remoteServerUrl.value = connection.serverUrl || "";
        if (err && err.status === 401) {
          this.data.needsLogin.value = true;
          this.data.loadError.value = "Sign in to your server to browse sources.";
        } else {
          this.data.loadError.value = "The catalog is not available yet.";
        }
        if (!append && this.data.items.value.length === 0) this.data.items.value = [];
      }
    } finally {
      // Do not clear the loading lock belonging to a newer request; otherwise
      // the scroll handler can start a duplicate page request.
      if (!this._isDestroyed && requestId === this._browseRequestId) {
        this.data.loading.value = false;
        this._fillScrollViewport();
      }
    }
  },

  retryLoad() {
    this.data.allLoaded.value = false;
    this.data.loadError.value = "";
    this.data.needsLogin.value = false;
    this.loadPage();
  },

  useRemoteRequests() {
    try {
      setCatalogTransport("server");
      window.location.reload();
    } catch {
      this.openRemoteConnection();
    }
  },

  openRemoteConnection() {
    window.dispatchEvent(new CustomEvent("mangayomu:open-remote-connection"));
  },

  async _checkFavorites(onlyItems) {
    var items = onlyItems || this.data.items.value;
    if (!items || items.length === 0) return;
    var ids = [];
    for (var i = 0; i < items.length; i++) {
      ids.push(items[i].id);
    }
    try {
      var result = await favApi.checkBatch(ids);
      if (onlyItems) {
        // Merge new results into existing favMap
        var merged = {};
        for (var id in this.data.favMap.value) {
          merged[id] = this.data.favMap.value[id];
        }
        for (var id in result.favorited) {
          merged[id] = result.favorited[id];
        }
        this.data.favMap.value = merged;
      } else {
        this.data.favMap.value = result.favorited || {};
      }
    } catch (err) {
      // Silently fail — non autenticato o errore
      if (!onlyItems) this.data.favMap.value = {};
    }
  },

  _clearBrowseQuery() {
    var url = new URL(window.location.href);
    var changed = false;
    if (url.searchParams.has("scroll")) { url.searchParams.delete("scroll"); changed = true; }
    if (url.searchParams.has("ref")) { url.searchParams.delete("ref"); changed = true; }
    if (url.searchParams.has("page")) { url.searchParams.delete("page"); changed = true; }
    if (changed) {
      history.replaceState(null, "", url.pathname + url.search + url.hash);
    }
  },

  _parseHashQuery(key) {
    var hash = window.location.hash;
    var qpos = hash.indexOf("?");
    if (qpos < 0) return null;
    var qs = hash.slice(qpos + 1);
    var pairs = qs.split("&");
    for (var i = 0; i < pairs.length; i++) {
      var parts = pairs[i].split("=");
      if (parts[0] === key && parts.length > 1) {
        return decodeURIComponent(parts[1]);
      }
    }
    return null;
  },

  _restoreScroll() {
    var scrollVal = this.$route.query.scroll;
    if (!scrollVal) {
      // Fallback: leggi dalla hash (backward compat)
      scrollVal = this._parseHashQuery("scroll");
    }
    if (scrollVal) {
      var y = parseInt(scrollVal, 10);
      if (!isNaN(y) && y > 0) {
        requestAnimationFrame(function () {
          window.scrollTo(0, y);
        });
      }
    }
  },

  _saveScroll() {
    var y = Math.round(window.scrollY || window.pageYOffset || 0);
    if (y < 1) return;
    var sc = new URLSearchParams(window.location.search);
    sc.set("scroll", String(y));
    history.replaceState(null, "", "/?" + sc.toString() + window.location.hash);
  },

  doSearch() {
    this.data.searchQuery.value = this.refs.searchInput.value.trim();
    this.data.page.value = 1;
    this.data.allLoaded.value = false;
    _lastScrollUpdatePos = 0;
    this.loadPage();
    this._syncPageUrl(1);
    window.scrollTo(0, 0);
  },

  onSearchKeydown(e) {
    if (e.key === "Enter") this.doSearch();
  },

  prevPage() {
    if (this.data.page.value > 1) {
      this.data.page.value--;
      this.data.allLoaded.value = false;
      _lastScrollUpdatePos = 0;
      this.loadPage();
      this._syncPageUrl(this.data.page.value);
      window.scrollTo(0, 0);
    }
  },

  goToFirstPage() {
    this.data.page.value = 1;
    this.data.allLoaded.value = false;
    _lastScrollUpdatePos = 0;
    this.loadPage();
    this._syncPageUrl(1);
    window.scrollTo(0, 0);
  },

  nextPage() {
    this.data.page.value++;
    this.data.allLoaded.value = false;
    _lastScrollUpdatePos = 0;
    this.loadPage();
    this._syncPageUrl(this.data.page.value);
    window.scrollTo(0, 0);
  },

  openManga(item) {
    this._saveBrowseState();
    this._saveScroll();
    var sc = new URLSearchParams(window.location.search);
    sc.set("ref", window.location.hash.slice(1));
    history.replaceState(null, "", "/?" + sc.toString() + window.location.hash);
    router.navigate("/manga/" + item.source + "/" + encodeURIComponent(item.id));
  },

  beforeDestroy() {
    this._isDestroyed = true;
    offSessionChanged(this._onSessionChanged);
    this._onSessionChanged = null;
    this._unmountBrowseExtension();
    this._cleanupScrollObserver();
  },

  _setupScrollObserver() {
    this._cleanupScrollObserver();
    if (this.data.scrollMode.value !== 'scroll') return;

    // Use a scroll listener for lazy loading
    var self = this;
    this._scrollHandler = function () {
      if (self.data.loading.value || self.data.allLoaded.value) return;

      var scrollY = window.scrollY || window.pageYOffset;
      var docH = document.documentElement.scrollHeight;
      var maxScrollY = docH - window.innerHeight;

      // Safety net: at the very bottom, load immediately
      if (scrollY >= maxScrollY - 2) {
        self.loadMore();
        return;
      }

      // Trigger at 50% of the remaining distance from last update to end
      var remainingAfterUpdate = docH - _lastScrollUpdatePos - window.innerHeight;
      if (remainingAfterUpdate <= 0) return;

      var triggerPoint = _lastScrollUpdatePos + remainingAfterUpdate * 0.5;
      if (scrollY >= triggerPoint) {
        self.loadMore();
      }
    };
    window.addEventListener("scroll", this._scrollHandler, { passive: true });
    this._fillScrollViewport();
  },

  // On wide screens the first catalog batch may not create a scrollbar. Fill
  // until there is one, otherwise infinite scroll has no event that can load
  // its second page.
  _fillScrollViewport() {
    var self = this;
    if (this.data.scrollMode.value !== "scroll" || this.data.loading.value || this.data.allLoaded.value) return;
    requestAnimationFrame(function () {
      if (self._isDestroyed || self.data.scrollMode.value !== "scroll" || self.data.loading.value || self.data.allLoaded.value) return;
      if (document.documentElement.scrollHeight <= window.innerHeight + 2) self.loadMore();
    });
  },

  _cleanupScrollObserver() {
    if (this._scrollHandler) {
      window.removeEventListener("scroll", this._scrollHandler);
      this._scrollHandler = null;
    }
  },

  async loadMore() {
    if (this.data.loading.value || this.data.allLoaded.value) return;
    _lastScrollUpdatePos = window.scrollY || window.pageYOffset || 0;
    this.data.page.value++;
    await this.loadPage(true);
  },

  _saveBrowseState() {
    _saveBrowseCache({
      source: this.data.source.value,
      sourceLanguage: this.data.sourceLanguage.value,
      searchQuery: this.data.searchQuery.value,
      items: this.data.items.value,
      page: this.data.page.value,
      favMap: this.data.favMap.value,
      scrollMode: this.data.scrollMode.value,
      allLoaded: this.data.allLoaded.value,
      scrollY: Math.round(window.scrollY || window.pageYOffset || 0),
    });
  },

  async doLogout() {
    try {
      await auth.logout();
    } catch (e) {}
    auth.clearToken();
    notifySessionChanged("client-logout");
    this.data.userEmail.value = "";
    router.navigate("/login");
  },
};

export default Browse;

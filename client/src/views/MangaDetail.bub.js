import { globals, tick } from "tinybubble";
import { manga, progress as progressApi, favorites as favApi, imageUrl } from "../api.ts";
import { replaceRoute, router } from "../App.bub.js";
import SectionFooter from "../components/SectionFooter.bub.js";

const MangaDetail = {
  name: "MangaDetail",

  components: {
    "section-footer": SectionFooter,
  },

  template() {
    return /*html*/`
      <div class="p-6 pb-24 max-w-4xl mx-auto">
        <button @click="goBack" class="text-blue-600 hover:text-blue-800 mb-4 inline-flex items-center gap-1">
          <span class="material-icons text-base">arrow_back</span>
          {{ t('Back to list') }}
        </button>

        <div class="flex flex-col md:flex-row gap-6 mb-8">
          <div class="w-48 shrink-0 relative">
            <template x-if="detail.coverUrl">
              <img :src="proxyImg(detail.coverUrl)" class="w-full rounded-lg shadow" />
            </template>
            <template x-if="!detail.coverUrl">
              <div class="w-full aspect-[3/4] bg-gray-200 rounded-lg flex items-center justify-center">
                <span class="material-icons text-7xl text-gray-400">auto_stories</span>
              </div>
            </template>
            <!-- Heart (favorite) -->
            <button @click="toggleFavorite"
              class="absolute top-2 right-2 w-10 h-10 flex items-center justify-center rounded-full bg-white/80 hover:bg-white shadow-sm transition-colors">
              <span class="material-icons text-xl"
                :class="isFav ? 'text-red-500' : 'text-gray-400'">
                {{isFav ? 'favorite' : 'favorite_border'}}
              </span>
            </button>
          </div>

          <div class="flex-1">
            <h1 class="text-3xl font-bold mb-2">{{detail.title}}</h1>
            <p x-show="detail.altTitle" class="text-gray-500 italic mb-2">{{detail.altTitle}}</p>
            <div class="flex flex-wrap gap-2 mb-3">
              <span x-for="author in detail.authors" :key="author"
                class="text-sm bg-blue-100 text-blue-800 px-2 py-1 rounded">
                {{author}}
              </span>
            </div>
            <div class="flex flex-wrap gap-1 mb-3">
              <span x-for="genre in detail.genres" :key="'g-'+genre"
                class="text-xs bg-gray-200 px-2 py-0.5 rounded">
                {{genre}}
              </span>
            </div>
            <div x-show="detail.themes.length" class="flex flex-wrap gap-1 mb-3">
              <span class="text-xs text-gray-400 mr-1 self-center">{{ t('Themes:') }}</span>
              <span x-for="theme in detail.themes" :key="'t-'+theme"
                class="text-xs bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded">
                {{theme}}
              </span>
            </div>
            <div x-show="detail.formats.length" class="flex flex-wrap gap-1 mb-3">
              <span class="text-xs text-gray-400 mr-1 self-center">{{ t('Format:') }}</span>
              <span x-for="fmt in detail.formats" :key="'f-'+fmt"
                class="text-xs bg-amber-50 text-amber-700 px-2 py-0.5 rounded">
                {{fmt}}
              </span>
            </div>
            <div x-show="detail.contents.length" class="flex flex-wrap gap-1 mb-3">
              <span class="text-xs text-gray-400 mr-1 self-center">{{ t('Content:') }}</span>
              <span x-for="c in detail.contents" :key="'c-'+c"
                class="text-xs bg-rose-50 text-rose-700 px-2 py-0.5 rounded">
                {{c}}
              </span>
            </div>
            <span class="text-sm text-gray-500">{{ t('Status:') }} {{detail.status}}</span>
            <div class="mt-3 flex items-center gap-2">
              <span class="material-icons text-base text-gray-500">translate</span>
              <select ref="detailLanguageSelect" x-show="detail.availableLanguages.length > 1" x-model="detailLanguage" @change="changeDetailLanguage($event)"
                class="h-8 rounded-lg border border-gray-200 bg-white px-2 text-sm font-medium text-gray-700 outline-none transition-colors focus:border-blue-500 focus:ring-2 focus:ring-blue-100">
                <option x-for="language in detail.availableLanguages" :key="language.code" :value="language.code">{{language.flag}} {{language.code.toUpperCase()}}</option>
              </select>
              <template x-if="detail.availableLanguages.length === 1">
                <span class="text-sm text-gray-600">{{detail.availableLanguages[0].flag}} {{detail.availableLanguages[0].code.toUpperCase()}}</span>
              </template>
            </div>
            <p x-show="detail.description" class="mt-3 text-gray-700 text-sm leading-relaxed">
              {{detail.description}}
            </p>
          </div>
        </div>

        <h2 class="text-xl font-semibold mb-3 flex items-center gap-2">
          <span class="material-icons">list</span>
          {{ t('Chapters') }}
        </h2>

        <!-- Overlay backdrop for chapter menu -->
        <div x-show="openMenuId" class="fixed inset-0 z-40" @click="closeMenu"></div>

        <div class="space-y-1">
          <div x-for="ch in chapters" :key="ch.id"
            class="flex items-center justify-between p-3 rounded shadow-sm cursor-pointer"
            :class="chaptersCompleted[ch.id] ? 'bg-gray-100 text-gray-500' : 'bg-white hover:shadow'"
            @click="openChapter(ch)">
            <div class="flex-1 min-w-0 pr-3">
              <!-- Line 1: Vol - Ch - Title -->
              <div class="text-sm truncate">
                <template x-if="ch.volume">
                  <span class="font-medium">{{ t('Vol') }} {{ch.volume}} – </span>
                </template>
                <span class="font-mono">{{ t('Ch.') }} {{ch.chapterNumber}}</span>
                <template x-if="ch.title">
                  <span> – {{ch.title}}</span>
                </template>
              </div>
              <!-- Line 2: date • progress -->
              <div class="text-xs text-gray-400 mt-0.5">
                <span>{{formatDate(ch.createdAt)}}</span>
                <span x-show="progressLabel(ch)" class="mx-1">•</span>
                <span x-show="progressLabel(ch)">{{progressLabel(ch)}}</span>
              </div>
            </div>
            <div class="flex items-center gap-2 shrink-0">
              <!-- Kebab menu trigger -->
              <div class="relative">
                <button @click="toggleMenu(ch, $event)"
                  class="flex items-center justify-center w-7 h-7 rounded hover:bg-gray-200 text-gray-400 transition-colors">
                  <span class="material-icons text-base">more_vert</span>
                </button>
                <!-- Balloon -->
                <div x-show="openMenuId === ch.id"
                  class="absolute right-0 bottom-full mb-2 bg-gray-800 rounded-xl shadow-lg px-2 py-1.5 z-50 flex flex-row items-center gap-2"
                  @click="$event.stopPropagation()">
                  <!-- Mark as to read -->
                  <button @click="markToRead(ch, $event)"
                    class="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-gray-600 text-white transition-colors"
                    :title="t('Mark as unread')">
                    <span class="material-icons text-xl">remove_done</span>
                  </button>
                  <!-- Mark this and previous as read -->
                  <button @click="markReadDown(ch, $event)"
                    class="flex items-center justify-center w-9 h-9 rounded-lg hover:bg-gray-600 text-white transition-colors"
                    :title="t('Mark this and previous as read')">
                    <span class="material-icons text-xl">checklist</span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <section-footer current="browse"></section-footer>
      </div>
    `;
  },

  data() {
    return {
      source: "",
      mangaId: "",
      detail: {
        title: "",
        altTitle: null,
        coverUrl: null,
        description: null,
        authors: [],
        genres: [],
        themes: [],
        formats: [],
        contents: [],
        status: "",
        availableLanguages: [],
        displayLanguage: "",
      },
      detailLanguage: "",
      chapters: [],
      chaptersRead: {},
      chaptersCompleted: {},
      isFav: false,
      favList: [],
      openMenuId: null,
    };
  },

  proxyImg(url) {
    return imageUrl(url, this.data.source.value);
  },

  formatDate(iso) {
    if (!iso) return "—";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "—";
    var dd = String(d.getDate()).padStart(2, "0");
    var mm = String(d.getMonth() + 1).padStart(2, "0");
    var yy = String(d.getFullYear()).slice(-2);
    return dd + "/" + mm + "/" + yy;
  },

  progressLabel(ch) {
    // Completed — no text, just the gray bg/color handles it
    if (this.data.chaptersCompleted.value[ch.id]) {
      return "";
    }
    var saved = this.data.chaptersRead.value[ch.id];
    if (saved) {
      // All pages read and page count known — treat as completed
      if (ch.pageCount > 0 && saved >= ch.pageCount) {
        return "";
      }
      // Page count known → show pag. X/Y, otherwise just pag. X
      if (ch.pageCount > 0) {
        return globals.t("page %s/%s", saved, ch.pageCount);
      }
      return globals.t("page %s", saved);
    }
    // Not started: show count only if known
    if (ch.pageCount > 0) {
      return globals.t("%s pages", ch.pageCount);
    }
    return "";
  },

  async init() {
    this._isDestroyed = false;
    await Promise.resolve();
    if (this._isDestroyed) return;
    this.data.source.value = this.$route.params.source || "";
    this.data.mangaId.value = decodeURIComponent(this.$route.params.id || "");
    // Source metadata (available languages + display language) is supplied by
    // the server detail response; the client no longer executes source code.
    this.data.detailLanguage.value = "";

    if (!this.data.mangaId.value) return;

    // Check if we have cached data (coming back from Reader)
    var cache = globals.$mangaCache;
    if (cache && cache.id === this.data.mangaId.value && cache.source === this.data.source.value) {
      // Restore detail and chapters from the in-memory route cache.
      this.data.detail.value = cache.detail;
      this.data.detailLanguage.value = cache.detailLanguage;
      this.data.chapters.value = cache.chapters;
      var savedScrollY = cache.scrollY;
      globals.$mangaCache = null;
      // Re-fetch progress — may have changed in Reader
      await this._loadProgressAndFavs();
      // Restore scroll position after re-render
      tick();
      this.refs.detailLanguageSelect.value = this.data.detailLanguage.value;
      if (savedScrollY != null) {
        window.scrollTo(0, savedScrollY);
      }
      return;
    }

    // Normal load from API
    await this._loadMangaData();
  },

  async _loadMangaData() {
    if (!this.data.mangaId.value) return;
    var requestId = (this._detailRequestId || 0) + 1;
    this._detailRequestId = requestId;

    try {
      var detailData = await manga.detail(this.data.source.value, this.data.mangaId.value, this.data.detailLanguage.value);
      if (this._isDestroyed || requestId !== this._detailRequestId) return;
      this.data.detail.value = detailData;
      this.data.detailLanguage.value = detailData.displayLanguage;
      tick();
      this.refs.detailLanguageSelect.value = this.data.detailLanguage.value;

      var chaptersData = await manga.chapters(this.data.source.value, this.data.mangaId.value, this.data.detailLanguage.value);
      if (this._isDestroyed || requestId !== this._detailRequestId) return;
      this.data.chapters.value = chaptersData;
    } catch (err) {
      console.error("[MangaDetail] load error (detail/chapters):", err);
      return;
    }

    await this._loadProgressAndFavs();
  },

  changeDetailLanguage(event) {
    this.data.detailLanguage.value = event.target.value;
    this._loadMangaData();
  },

  async _loadProgressAndFavs() {
    try {
      var [progressData, favData] = await Promise.all([
        progressApi.get(this.data.mangaId.value),
        favApi.list(),
      ]);

      this.data.favList.value = favData;
      this.data.isFav.value = favApi.check(this.data.mangaId.value, favData);

      var readMap = {};
      var completedMap = {};
      for (var pi = 0; pi < progressData.length; pi++) {
        var p = progressData[pi];
        if (p.completed == 1) {
          completedMap[p.chapter_id] = true;
        } else if (p.page_index > 0) {
          readMap[p.chapter_id] = p.page_index + 1;
        }
      }
      this.data.chaptersRead.value = readMap;
      this.data.chaptersCompleted.value = completedMap;
    } catch (err) {
      // Non-autenticato o errore di rete — ignora, non bloccante
      console.log("[MangaDetail] auth-optional data (progress/favs):", err.message);
    }
  },

  goBack() {
    var params = new URLSearchParams(window.location.search);
    var ref = params.get("ref");
    if (ref) {
      params.delete("ref");
      params.delete("scroll");
      var qs = params.toString();
      history.replaceState(null, "", "/" + (qs ? "?" + qs : "") + window.location.hash);
      replaceRoute(ref);
    } else {
      replaceRoute("/browse/" + this.data.source.value);
    }
  },

  beforeDestroy() {
    this._isDestroyed = true;
    this._detailRequestId = (this._detailRequestId || 0) + 1;
  },

  async toggleFavorite() {
    var isFav = this.data.isFav.value;
    var mid = this.data.mangaId.value;
    var src = this.data.source.value;
    var det = this.data.detail.value;

    try {
      if (isFav) {
        await favApi.remove(mid);
        this.data.isFav.value = false;
      } else {
        await favApi.add(mid, src, det.title, det.coverUrl || "");
        this.data.isFav.value = true;
      }
    } catch (err) {
      console.error("[MangaDetail] favorite error:", err);
    }
  },

  openChapter(ch) {
    // Save current data + scroll position before navigating to Reader
    globals.$mangaCache = {
      id: this.data.mangaId.value,
      source: this.data.source.value,
      detail: this.data.detail.value,
      detailLanguage: this.data.detailLanguage.value,
      chapters: this.data.chapters.value,
      chaptersRead: this.data.chaptersRead.value,
      chaptersCompleted: this.data.chaptersCompleted.value,
      isFav: this.data.isFav.value,
      favList: this.data.favList.value,
      scrollY: window.scrollY,
    };
    var s = this.data.source.value;
    var m = this.data.mangaId.value;
    // Se completato, riparti dalla prima pagina
    var isCompleted = this.data.chaptersCompleted.value[ch.id];
    var startPage = 0;
    if (!isCompleted) {
      var savedPage = this.data.chaptersRead.value[ch.id] || 0;
      startPage = savedPage > 0 ? savedPage - 1 : 0;
    }
    router.navigate("/reader/" + s + "/" + encodeURIComponent(m) + "/" + ch.id + "/" + startPage);
  },

  toggleMenu(ch, ev) {
    ev.stopPropagation();
    var open = this.data.openMenuId.value;
    this.data.openMenuId.value = open === ch.id ? null : ch.id;
  },

  closeMenu() {
    this.data.openMenuId.value = null;
  },

  async markToRead(ch, ev) {
    ev.stopPropagation();
    this.data.openMenuId.value = null;
    var mangaId = this.data.mangaId.value;

    try {
      await progressApi.update(mangaId, ch.id, 0, false);

      // Remove from completed
      var completed = {};
      for (var id in this.data.chaptersCompleted.value) {
        completed[id] = this.data.chaptersCompleted.value[id];
      }
      delete completed[ch.id];
      this.data.chaptersCompleted.value = completed;

      // Remove from partial reads too
      var read = {};
      for (var id in this.data.chaptersRead.value) {
        read[id] = this.data.chaptersRead.value[id];
      }
      delete read[ch.id];
      this.data.chaptersRead.value = read;
    } catch (err) {
      console.error("[MangaDetail] markToRead error:", err);
    }
  },

  async markReadDown(ch, ev) {
    ev.stopPropagation();
    this.data.openMenuId.value = null;
    var mangaId = this.data.mangaId.value;
    var chapters = this.data.chapters.value;

    // Find index of this chapter
    var targetIndex = -1;
    for (var i = 0; i < chapters.length; i++) {
      if (chapters[i].id === ch.id) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex === -1) return;

    // Optimistic UI: mark this and all previous chapters (lower number) as completed
    var completed = {};
    for (var id in this.data.chaptersCompleted.value) {
      completed[id] = this.data.chaptersCompleted.value[id];
    }
    for (var i = targetIndex; i < chapters.length; i++) {
      completed[chapters[i].id] = true;
    }
    this.data.chaptersCompleted.value = completed;

    // Remove from partial reads for these chapters
    var read = {};
    for (var id in this.data.chaptersRead.value) {
      read[id] = this.data.chaptersRead.value[id];
    }
    for (var i = targetIndex; i < chapters.length; i++) {
      delete read[chapters[i].id];
    }
    this.data.chaptersRead.value = read;

    // Fire API calls (already optimistic)
    try {
      var promises = [];
      for (var i = targetIndex; i < chapters.length; i++) {
        promises.push(progressApi.update(mangaId, chapters[i].id, 0, true));
      }
      await Promise.all(promises);
    } catch (err) {
      console.error("[MangaDetail] markReadDown error:", err);
    }
  },
};

export default MangaDetail;

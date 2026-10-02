import { favorites as favApi, imageUrl } from "../api.ts";
import { router } from "../App.bub.js";
import { hasAccountSession, offSessionChanged, onSessionChanged } from "../session.js";
import SectionFooter from "../components/SectionFooter.bub.js";

var Favorites = {
  name: "Favorites",

  components: {
    "section-footer": SectionFooter,
  },

  template() {
    return /*html*/`
      <div class="min-h-[100dvh] flex flex-col">
        <div class="section-page-content p-4 sm:p-6 max-w-6xl mx-auto flex-1 w-full">
        <!-- Header -->
        <div class="mb-6">
          <div class="flex items-center gap-2 mb-3">
            <span class="material-icons text-2xl text-red-500">favorite</span>
            <h1 class="text-2xl font-bold">{{ t('Favorites') }}</h1>
            <div class="ml-auto relative">
              <button @click="toggleSortMenu"
                class="p-2 rounded-lg hover:bg-gray-200 transition-colors"
                :title="t('Sort favorites')">
                <span class="material-icons text-xl text-gray-600">sort</span>
              </button>
              <div x-show="showSortMenu"
                class="absolute right-0 top-full mt-1 bg-white rounded-xl shadow-lg border border-gray-200 py-1 z-50 min-w-[180px]"
                @click="$event.stopPropagation()">
                <button @click="setSort('alpha')"
                  class="flex items-center gap-3 w-full px-4 py-2 text-sm text-left hover:bg-gray-100 transition-colors"
                  :class="sortBy === 'alpha' ? 'text-blue-600 font-medium' : 'text-gray-700'">
                  <span class="material-icons text-lg">sort_by_alpha</span>
                  {{ t('Alphabetical') }}
                </button>
                <button @click="setSort('date')"
                  class="flex items-center gap-3 w-full px-4 py-2 text-sm text-left hover:bg-gray-100 transition-colors"
                  :class="sortBy === 'date' ? 'text-blue-600 font-medium' : 'text-gray-700'">
                  <span class="material-icons text-lg">schedule</span>
                  {{ t('Date added') }}
                </button>
              </div>
            </div>
          </div>
          <!-- Search -->
          <div class="relative">
            <span class="material-icons absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-lg pointer-events-none">search</span>
            <input type="text" x-model="searchQuery" :placeholder="t('Search favorites...')"
              class="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent" />
          </div>
        </div>

        <!-- Sort menu backdrop -->
        <div x-show="showSortMenu" class="fixed inset-0 z-40" @click="closeSortMenu"></div>

        <!-- Not logged in -->
        <div x-show="!isLoggedIn" class="text-center py-16">
          <span class="material-icons text-6xl text-gray-300">favorite_border</span>
          <p class="text-gray-500 mt-3 mb-4">{{ t('Sign in to see your favorites') }}</p>
          <a href="#/login" class="text-blue-600 hover:underline">{{ t('Go to sign in') }}</a>
        </div>

        <!-- No favorites -->
        <div x-show="isLoggedIn && items.length === 0" class="text-center py-16">
          <span class="material-icons text-6xl text-gray-300">bookmark_border</span>
          <p class="text-gray-500 mt-3">{{ t('No favorites yet') }}</p>
          <p class="text-gray-400 text-sm mt-1">{{ t('Add manga to favorites from its details') }}</p>
        </div>

        <!-- No search results -->
        <div x-show="isLoggedIn && items.length > 0 && displayItems().length === 0" class="text-center py-16">
          <span class="material-icons text-6xl text-gray-300">search_off</span>
          <p class="text-gray-500 mt-3">{{ t('No results for "%s"', searchQuery) }}</p>
          <p class="text-gray-400 text-sm mt-1">{{ t('Try a different search term') }}</p>
        </div>

        <!-- Manga grid -->
        <div x-show="isLoggedIn && displayItems().length > 0"
          class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-4">
          <div x-for="item in displayItems()" :key="item.manga_id" class="cursor-pointer" @click="openManga(item)">
            <div class="bg-white rounded-lg shadow overflow-hidden hover:shadow-lg transition-shadow">
              <div class="aspect-[3/4] bg-gray-200 flex items-center justify-center overflow-hidden">
                <template x-if="item.cover_url">
                  <img :src="proxyImg(item.cover_url, item.source)" class="w-full h-full object-cover" loading="lazy" />
                </template>
                <template x-if="!item.cover_url">
                  <span class="material-icons text-6xl text-gray-400">auto_stories</span>
                </template>
              </div>
              <div class="p-2">
                <p class="text-xs sm:text-sm font-medium line-clamp-2">{{item.title}}</p>
              </div>
            </div>
          </div>
        </div>

        </div>
        <section-footer current="favorites"></section-footer>
      </div>
    `;
  },

  data() {
    return {
      items: [],
      isLoggedIn: false,
      showSortMenu: false,
      sortBy: localStorage.getItem('fav_sort') || 'date',
      searchQuery: '',
      _initialScrollDone: false,
    };
  },

  proxyImg(url, source) {
    return imageUrl(url, source);
  },

  async init() {
    // The account can change while this view is open (the account dialog lives
    // in the header), so follow the session instead of reading it once.
    this._onSessionChanged = () => {
      this._loadFavorites();
    };
    onSessionChanged(this._onSessionChanged);
    await this._loadFavorites();
  },

  beforeDestroy() {
    offSessionChanged(this._onSessionChanged);
    this._onSessionChanged = null;
  },

  async _loadFavorites() {
    // A server account is enough: the favorites API reads through the server
    // session when one is active, and through the client account otherwise.
    this.data.isLoggedIn.value = hasAccountSession();
    if (!this.data.isLoggedIn.value) {
      this.data.items.value = [];
      return;
    }
    try {
      this.data.items.value = await favApi.list();
      this._restoreScroll();
    } catch (err) {
      console.error("[Favorites] load error:", err);
      this.data.items.value = [];
    }
  },

  toggleSortMenu() {
    this.data.showSortMenu.value = !this.data.showSortMenu.value;
  },

  closeSortMenu() {
    this.data.showSortMenu.value = false;
  },

  setSort(value) {
    this.data.sortBy.value = value;
    this.data.showSortMenu.value = false;
    localStorage.setItem('fav_sort', value);
  },

  displayItems() {
    var items = this.data.items.value;
    var query = this.data.searchQuery.value.toLowerCase().trim();
    var sort = this.data.sortBy.value;

    // Filter by search
    if (query) {
      var filtered = [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].title && items[i].title.toLowerCase().indexOf(query) !== -1) {
          filtered.push(items[i]);
        }
      }
      items = filtered;
    }

    // Sort
    if (sort === 'alpha') {
      items = items.slice().sort(function (a, b) {
        return (a.title || '').localeCompare(b.title || '');
      });
    }
    // 'date' is the default order from DB (most recent first)

    return items;
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

  openManga(item) {
    this._saveScroll();
    var sc = new URLSearchParams(window.location.search);
    sc.set("ref", window.location.hash.slice(1));
    history.replaceState(null, "", "/?" + sc.toString() + window.location.hash);
    router.navigate("/manga/" + item.source + "/" + encodeURIComponent(item.manga_id));
  },

};

export default Favorites;

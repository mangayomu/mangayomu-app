/**
 * Sticky bottom navigation for section pages (Browse, Favorites, Settings).
 * Usage: <SectionFooter current="browse"></SectionFooter>
 * Props: current - "browse", "favorites" or "settings"
 */

import { browsePath, getSavedSource, router } from "../App.bub.js";

var SectionFooter = {
  name: "SectionFooter",

  props: ["current"],

  template() {
    return /*html*/`
      <div class="fixed inset-x-0 bottom-0 z-50 bg-gray-900/90 backdrop-blur-sm border-t border-gray-700/50 safe-area-bottom">
        <div class="max-w-lg mx-auto flex items-center justify-around h-14">
          <button @click="goBrowse" :aria-label="t('Browse')"
            class="flex flex-col items-center justify-center w-full h-full transition-colors"
            :class="current === 'browse' ? 'text-blue-300' : 'text-gray-500 hover:text-gray-300'">
            <span class="material-icons text-2xl">explore</span>
          </button>
          <button @click="goFavorites" :aria-label="t('Favorites')"
            class="flex flex-col items-center justify-center w-full h-full transition-colors"
            :class="current === 'favorites' ? 'text-red-400' : 'text-gray-500 hover:text-gray-300'">
            <span class="material-icons text-2xl">favorite</span>
          </button>
          <button @click="showQrCode" :aria-label="t('Show QR code')"
            class="flex flex-col items-center justify-center w-full h-full transition-colors text-gray-500 hover:text-gray-300">
            <span class="material-icons text-2xl">qr_code</span>
          </button>
          <button @click="goSettings" :aria-label="t('Settings')"
            class="flex flex-col items-center justify-center w-full h-full transition-colors"
            :class="current === 'settings' ? 'text-gray-100' : 'text-gray-500 hover:text-gray-300'">
            <span class="material-icons text-2xl">settings</span>
          </button>
        </div>
      </div>
    `;
  },

  goBrowse() {
    if (this.props.current.value === "browse") return;
    router.navigate(browsePath(getSavedSource()));
  },

  goFavorites() {
    if (this.props.current.value === "favorites") return;
    router.navigate("/favorites");
  },

  showQrCode() {
    // One dialog lives in the App shell; every view opens the same instance.
    window.dispatchEvent(new CustomEvent("mangayomu:open-share-qr"));
  },

  goSettings() {
    if (this.props.current.value === "settings") return;
    router.navigate("/settings");
  },
};

export default SectionFooter;

import { Capacitor } from "@capacitor/core";
import { App as CapacitorApp } from "@capacitor/app";
import { createRouter } from "tinybubble";
import Browse from "./views/Browse.bub.js";
import MangaDetail from "./views/MangaDetail.bub.js";
import Reader from "./views/Reader.bub.js";
import Favorites from "./views/Favorites.bub.js";
import Login from "./views/Login.bub.js";
import Signup from "./views/Signup.bub.js";
import Settings from "./views/Settings.bub.js";
import ShareQrModal from "./components/ShareQrModal.bub.js";

var router = createRouter({
  mode: "hash",
  routes: [
    { path: "/", component: Browse },
    { path: "/browse", component: Browse },
    { path: "/browse/:source", component: Browse },
    { path: "/browse/:source/:page", component: Browse },
    { path: "/favorites", component: Favorites },
    { path: "/settings", component: Settings },
    { path: "/settings/:tab", component: Settings },
    { path: "/manga/:source/:id", component: MangaDetail },
    { path: "/reader/:source/:mangaId/:chapterId", component: Reader },
    { path: "/reader/:source/:mangaId/:chapterId/:page", component: Reader },
    { path: "/login", component: Login },
    { path: "/signup", component: Signup },
    // Unknown paths (stale links, empty source) fall back to the catalog
    // instead of rendering an empty view.
    { path: "*", component: Browse },
  ],
});

export { router };

export function replaceRoute(path) {
  history.replaceState(null, "", window.location.pathname + window.location.search + "#" + path);
  router.setDestination(path);
}

function getCurrentPath() {
  return window.location.hash.slice(1) || "/";
}

function isAppExitRoute() {
  var path = getCurrentPath();
  return path === "/favorites" || path.indexOf("/browse/") === 0;
}

function getReaderDetailPath(path) {
  var match = path.match(/^\/reader\/([^/]+)\/([^/]+)\/[^/]+(?:\/[^/]+)?$/);
  if (!match) return null;
  return "/manga/" + match[1] + "/" + match[2];
}

function getMangaSource(path) {
  var match = path.match(/^\/manga\/([^/]+)\/[^/]+$/);
  return match ? match[1] : null;
}

/** Import and Sync used to be top-level routes; they now live in Settings. */
function getLegacyDataPath(path) {
  return path === "/import" || path === "/sync" ? "/settings/data" : null;
}

/**
 * The source the user last used, or "" when this profile has none yet.
 * Every caller used to read localStorage again; keep one reader.
 */
export function getSavedSource() {
  var saved = "";
  try {
    var source = localStorage.getItem("manga-source");
    if (source) saved = source;
  } catch (e) {}
  return saved;
}

/**
 * Canonical browse path. An empty source must produce "/browse": "/browse/"
 * matches no route, which left the router view empty (blank window).
 */
export function browsePath(source) {
  return source ? "/browse/" + source : "/browse";
}

var App = {
  name: "App",

  components: {
    "router-view": router.RouterView,
    // One share dialog for the whole client, opened from any view.
    "share-qr-modal": ShareQrModal,
  },

  template() {
    return /*html*/`<div><router-view></router-view><share-qr-modal></share-qr-modal></div>`;
  },

  async init() {
    if (Capacitor.isNativePlatform()) {
      CapacitorApp.addListener("backButton", async function (event) {
        var path = getCurrentPath();
        if (isAppExitRoute()) {
          await CapacitorApp.exitApp();
          return;
        }
        var readerDetailPath = getReaderDetailPath(path);
        if (readerDetailPath) {
          replaceRoute(readerDetailPath);
          return;
        }
        var mangaSource = getMangaSource(path);
        if (mangaSource) {
          replaceRoute(browsePath(mangaSource));
          return;
        }
        if (event.canGoBack) {
          window.history.back();
          return;
        }
        router.navigate(browsePath(getSavedSource()));
      });
    }

    // Views load the active local profile in the background so the catalog
    // remains available while the browser database opens.

    // Root redirect: / -> /browse/:savedSource
    var hash = window.location.hash || "#/";
    var path = hash.slice(1);
    var legacyDataPath = getLegacyDataPath(path);
    if (legacyDataPath) {
      replaceRoute(legacyDataPath);
      return;
    }
    if (path === "/" || path === "") {
      router.navigate(browsePath(getSavedSource()));
    }
  },
};

export default App;

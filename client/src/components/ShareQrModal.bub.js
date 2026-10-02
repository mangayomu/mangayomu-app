/**
 * Share dialog: shows the QR code that opens this same instance from another
 * device on the network.
 *
 * Mounted once in the App shell (the client root), so every view can open it by
 * dispatching "mangayomu:open-share-qr" and there is exactly one instance.
 *
 * The address keeps the origin that serves this client and replaces the host
 * with a local address of the server. One rule covers every platform: desktop
 * and Android windows run on 127.0.0.1 with an embedded server, while a browser
 * may already be on a reachable address (then nothing is replaced).
 */

import { renderSVG } from "uqr";
import { network } from "../api.ts";

const PRIVATE_RANGE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
// macOS names the primary interface en0, Linux wlan*/wl*.
const PRIMARY_INTERFACE = /^(en\d|wl)/;

function isLoopbackHost(host) {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

var ShareQrModal = {
  name: "ShareQrModal",

  data() {
    return {
      open: false,
      loading: false,
      error: "",
      url: "",
      qrSvg: "",
      addresses: [],
      copied: false,
      // True when this client runs on a loopback address (desktop/Android
      // windows do), so the host has to be swapped for a local one.
      onLoopback: false,
    };
  },

  template() {
    return /*html*/`
      <div x-show="open" class="fixed inset-0 z-[70] flex items-center justify-center p-4" role="dialog" :aria-modal="true" :aria-label="t('Open this server on another device')">
        <div class="absolute inset-0 bg-black/60" @click="close"></div>
        <div class="relative z-10 w-full max-w-sm rounded-2xl border border-gray-200 bg-white p-5 shadow-xl dark:border-gray-700 dark:bg-gray-800">
          <div class="mb-4 flex items-start justify-between gap-3">
            <h3 class="text-lg font-semibold text-gray-900 dark:text-gray-100">{{ t('Open this server on another device') }}</h3>
            <button @click="close" :aria-label="t('Close')"
              class="rounded-lg p-1 text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 cursor-pointer">
              <span class="material-icons">close</span>
            </button>
          </div>

          <p x-show="loading" class="py-10 text-center text-sm text-gray-500 dark:text-gray-400">{{ t('Loading…') }}</p>

          <p x-show="error" class="rounded-lg bg-amber-50 px-3 py-3 text-sm text-amber-800 dark:bg-amber-950/40 dark:text-amber-200">{{ error }}</p>

          <div x-show="!loading && !error">
            <div x-html="qrSvg" class="mx-auto w-64 rounded-xl bg-white p-3 [&>svg]:h-auto [&>svg]:w-full"></div>

            <div class="mt-4 flex items-center gap-2">
              <code class="min-w-0 flex-1 break-all rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-800 dark:bg-gray-900 dark:text-gray-100">{{ url }}</code>
              <button @click="copyUrl" :aria-label="t('Copy link')" :title="t('Copy link')"
                class="rounded-lg border border-gray-200 p-2 text-gray-600 hover:bg-gray-50 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900 cursor-pointer">
                <span class="material-icons text-base">{{ copied ? 'check' : 'content_copy' }}</span>
              </button>
            </div>

            <div x-show="addresses.length > 1" class="mt-3">
              <p class="mb-1 text-xs uppercase tracking-wide text-gray-400">{{ t('Other addresses') }}</p>
              <div class="flex flex-wrap gap-1.5">
                <button x-for="entry in addresses" :key="entry.address" @click="useAddress(entry.address)"
                  class="rounded-lg bg-gray-100 px-2.5 py-1 text-xs text-gray-700 hover:bg-gray-200 dark:bg-gray-900 dark:text-gray-200 dark:hover:bg-gray-700 cursor-pointer"
                  :class="url.includes(entry.address) ? 'ring-1 ring-blue-500' : ''">
                  {{ entry.interface }} · {{ entry.address }}
                </button>
              </div>
            </div>

            <p class="mt-4 text-xs leading-5 text-gray-500 dark:text-gray-400">
              {{ t('Any device on this network can open this address. Browsing still requires an account on this server.') }}
            </p>
          </div>
        </div>
      </div>`;
  },

  init() {
    this._onOpen = () => this.show();
    window.addEventListener("mangayomu:open-share-qr", this._onOpen);
    this._onKey = (event) => {
      if (event.key === "Escape" && this.data.open.value) this.close();
    };
    window.addEventListener("keydown", this._onKey);
  },

  beforeDestroy() {
    window.removeEventListener("mangayomu:open-share-qr", this._onOpen);
    window.removeEventListener("keydown", this._onKey);
    this._onOpen = null;
    this._onKey = null;
  },

  show() {
    this.data.open.value = true;
    this.data.copied.value = false;
    this.load();
  },

  close() {
    this.data.open.value = false;
  },

  async load() {
    this.data.loading.value = true;
    this.data.error.value = "";
    try {
      // A client loaded from tauri:// (static fallback, no server) has nothing
      // to share: say so instead of showing an address nobody can reach.
      var protocol = window.location.protocol;
      if (protocol !== "http:" && protocol !== "https:") {
        throw new Error("This client is not served by a server, so there is no address to share.");
      }

      var info = await network.addresses();
      this.data.addresses.value = (info && info.addresses) || [];
      this.data.onLoopback.value = isLoopbackHost(window.location.hostname);

      var primary = this.pickAddress(this.data.addresses.value);
      if (!primary) {
        throw new Error("No local network address found. Connect this machine to a network first.");
      }
      this.render(this.buildUrl(primary));
    } catch (err) {
      this.data.error.value = err.message || "Could not read the server address";
      this.data.url.value = "";
      this.data.qrSvg.value = "";
    } finally {
      this.data.loading.value = false;
    }
  },

  /**
   * The address of this client, with the host swapped for a local one when the
   * client runs on loopback. The port is always the client's own port: that is
   * what another device has to open.
   */
  buildUrl(address) {
    var origin = window.location;
    var hostname = this.data.onLoopback.value ? address : origin.hostname;
    return origin.protocol + "//" + hostname + (origin.port ? ":" + origin.port : "") + "/";
  },

  render(url) {
    this.data.url.value = url;
    this.data.qrSvg.value = renderSVG(url, {
      ecc: "M", border: 4, pixelSize: 8, blackColor: "#0b0b0c", whiteColor: "#ffffff",
    });
  },

  pickAddress(addresses) {
    if (!addresses || addresses.length === 0) return "";
    var privateOnes = addresses.filter((entry) => PRIVATE_RANGE.test(entry.address));
    var candidates = privateOnes.length > 0 ? privateOnes : addresses;
    var primary = candidates.find((entry) => PRIMARY_INTERFACE.test(entry.interface));
    return (primary || candidates[0]).address;
  },

  useAddress(address) {
    this.render(this.buildUrl(address));
  },

  async copyUrl() {
    if (!this.data.url.value) return;
    try {
      await navigator.clipboard.writeText(this.data.url.value);
      this.data.copied.value = true;
    } catch (err) {
      this.data.copied.value = false;
    }
  },
};

export default ShareQrModal;

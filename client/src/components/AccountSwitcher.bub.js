import { auth, remoteAuth } from "../api.ts";
import jsQR from "jsqr";
import { notifySessionChanged } from "../session.js";
import { clearRemoteSession, clearServerConnection, getConnection, hasActiveServerSession, setCatalogTransport, setServerConnection } from "../connection";
import { router } from "../App.bub.js";

function defaultHost() {
  // Capacitor owns http://localhost for bundled assets; the embedded Node
  // server is intentionally reached through 127.0.0.1 instead.
  if (typeof window.Capacitor !== "undefined") return "127.0.0.1";
  var host = window.location.hostname || "";
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.slice(0, host.lastIndexOf(".") + 1);
  }
  return host;
}

var AccountSwitcher = {
  name: "AccountSwitcher",

  template() {
    return /*html*/`
      <div class="relative leading-none">
        <button @click="toggle" class="flex items-center justify-center w-9 h-9 rounded hover:bg-gray-100 text-gray-500" :title="t('Accounts and server')">
          <span class="material-icons text-xl leading-none">account_circle</span>
        </button>

        <div x-show="open" class="fixed inset-0 z-40" @click="close"></div>
        <section x-show="open" class="absolute right-0 top-full mt-1 z-50 w-[min(24rem,calc(100vw-1.5rem))] overflow-hidden rounded-xl border border-gray-200 bg-white shadow-xl text-left">
          <div class="flex border-b border-gray-200">
            <button @click="setTab('local')" class="flex-1 px-3 py-2 text-sm font-medium" :class="tab === 'local' ? 'border-b-2 border-blue-600 text-blue-700' : 'text-gray-500'">{{ t('Local') }}</button>
            <button @click="setTab('remote')" class="flex-1 px-3 py-2 text-sm font-medium" :class="tab === 'remote' ? 'border-b-2 border-blue-600 text-blue-700' : 'text-gray-500'">{{ t('Remote') }}</button>
          </div>

          <!-- ========== LOCAL TAB ========== -->
          <div x-show="tab === 'local'" class="p-4 space-y-3">
            <!-- Source toggle -->
            <div class="flex items-center justify-between rounded-lg border p-3"
              :class="transport === 'direct' ? 'border-blue-400 bg-blue-50' : 'border-gray-200'">
              <div>
                <p class="text-sm font-medium">{{ t('Local source') }}</p>
                <p class="text-xs text-gray-500">{{ t('Direct source requests') }}</p>
              </div>
              <button @click="switchTransport('direct')"
                class="rounded px-3 py-1.5 text-sm"
                :class="transport === 'direct' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'">
                {{ transport === 'direct' ? t('Active') : t('Use local') }}
              </button>
            </div>

            <p class="text-xs uppercase tracking-wide text-gray-400 pt-1">{{ t('Local account') }}</p>
            <template x-if="localEmail">
              <div class="flex items-center gap-2">
                <span class="material-icons text-gray-400">person</span>
                <span class="min-w-0 flex-1 truncate text-sm text-gray-700">{{ localEmail }}</span>
                <button @click="logoutLocal" class="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50">{{ t('Sign out') }}</button>
              </div>
            </template>
            <template x-if="!localEmail">
              <div class="space-y-2">
                <p class="text-sm text-gray-600">{{ t('No local account signed in.') }}</p>
                <div class="flex gap-2">
                  <button @click="goLogin" class="rounded bg-blue-600 px-3 py-1.5 text-sm text-white">{{ t('Sign in') }}</button>
                  <button @click="goSignup" class="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700">{{ t('Create account') }}</button>
                </div>
              </div>
            </template>
          </div>

          <!-- ========== REMOTE TAB ========== -->
          <div x-show="tab === 'remote'" class="p-4 space-y-3">
            <!-- Source toggle -->
            <div x-show="remoteServerUrl" class="flex items-center justify-between rounded-lg border p-3"
              :class="transport === 'server' ? 'border-blue-400 bg-blue-50' : 'border-gray-200'">
              <div>
                <p class="text-sm font-medium">{{ t('Remote source') }}</p>
                <p class="text-xs text-gray-500">{{ t('Source requests go through the server') }}</p>
              </div>
              <button @click="switchTransport('server')"
                class="rounded px-3 py-1.5 text-sm"
                :class="transport === 'server' ? 'bg-blue-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'">
                {{ transport === 'server' ? t('Active') : t('Use remote') }}
              </button>
            </div>

            <p class="text-xs uppercase tracking-wide text-gray-400">{{ t('Server') }}</p>
            <p x-show="message" class="rounded bg-red-50 px-2 py-1.5 text-xs text-red-700">{{ t(message) }}</p>

            <template x-if="!remoteServerUrl">
              <div class="space-y-2">
                <p class="text-sm text-gray-600">{{ t('Connect to a MangaYomu server.') }}</p>
                <div class="grid grid-cols-[5rem_1fr_4rem] gap-2">
                  <select x-model="protocol" class="rounded border border-gray-300 px-2 py-2 text-sm"><option>http</option><option>https</option></select>
                  <input x-model="host" :placeholder="t('Host')" class="min-w-0 rounded border border-gray-300 px-2 py-2 text-sm" />
                  <input x-model="port" inputmode="numeric" placeholder="4567" class="min-w-0 rounded border border-gray-300 px-2 py-2 text-sm" />
                </div>
                <button @click="connectServer" class="rounded bg-blue-600 px-3 py-1.5 text-sm text-white">{{ t('Connect') }}</button>
                <button x-show="cameraAvailable" @click="openScanner"
                  class="ml-2 inline-flex items-center gap-1 rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 dark:border-gray-600 dark:text-gray-200 cursor-pointer">
                  <span class="material-icons text-base">qr_code_scanner</span>
                  {{ t('Scan QR code') }}
                </button>
              </div>
            </template>

            <template x-if="remoteServerUrl">
              <div class="space-y-3">
                <div class="flex items-start gap-2 rounded bg-blue-50 p-2">
                  <span class="material-icons text-base text-blue-600">dns</span>
                  <span class="min-w-0 flex-1 break-all text-xs text-blue-800">{{ remoteServerUrl }}</span>
                </div>

                <template x-if="remoteEmail">
                  <div class="flex items-center gap-2">
                    <span class="material-icons text-gray-400">cloud_done</span>
                    <span class="min-w-0 flex-1 truncate text-sm text-gray-700">{{ remoteEmail }}</span>
                    <button @click="logoutRemote" class="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50">{{ t('Sign out') }}</button>
                  </div>
                </template>

                <template x-if="!remoteEmail">
                  <div class="space-y-2">
                    <p class="text-sm text-gray-600">{{ t('Sign in to a server account.') }}</p>
                    <input ref="remoteEmailInput" type="email" :placeholder="t('Email')" class="w-full rounded border border-gray-300 px-2 py-2 text-sm" />
                    <input ref="remotePasswordInput" type="password" :placeholder="t('Password')" class="w-full rounded border border-gray-300 px-2 py-2 text-sm" />
                    <div class="flex gap-2">
                      <button @click="loginRemote" class="rounded bg-blue-600 px-3 py-1.5 text-sm text-white">{{ t('Sign in') }}</button>
                      <button @click="signupRemote" class="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700">{{ t('Create account') }}</button>
                    </div>
                  </div>
                </template>

                <button x-show="!hostedByNode" @click="forgetServer" class="text-xs text-gray-500 hover:text-red-600">{{ t('Forget this server') }}</button>
                <p x-show="hostedByNode" class="text-xs text-gray-400">{{ t('This UI is served by the connected Node server.') }}</p>
              </div>
            </template>
          </div>
        </section>

      <!-- Camera scanner: reads the QR code of a running instance -->
      <div x-show="scanOpen" class="fixed inset-0 z-[80] flex flex-col bg-black/90 p-4" role="dialog" :aria-modal="true" :aria-label="t('Scan QR code')">
        <div class="flex items-center justify-between gap-3 text-white">
          <span class="text-sm font-medium">{{ t('Point the camera at the QR code') }}</span>
          <button @click="closeScanner" :aria-label="t('Close')" class="rounded p-1 text-white/80 hover:bg-white/10 cursor-pointer">
            <span class="material-icons">close</span>
          </button>
        </div>
        <div class="relative mx-auto mt-4 w-full max-w-sm overflow-hidden rounded-2xl bg-black">
          <video ref="scanVideo" class="block w-full" playsinline muted></video>
        </div>
        <p x-show="scanError" class="mx-auto mt-4 max-w-sm text-center text-sm text-amber-300">{{ scanError }}</p>
        <p x-show="!scanError" class="mx-auto mt-4 max-w-sm text-center text-xs text-white/60">{{ t('Open Settings → Data & Sync on the other instance and show its QR code.') }}</p>
      </div>
      </div>
    `;
  },

  data() {
    return {
      open: false,
      tab: "local",
      localEmail: "",
      remoteEmail: "",
      remoteServerUrl: "",
      hostedByNode: false,
      transport: "direct",
      protocol: "http",
      host: defaultHost(),
      port: "4567",
      message: "",
      // Camera scanning: read a server address from a QR code shown by a
      // running instance (Settings → Data & Sync → Show QR code).
      cameraAvailable: false,
      scanOpen: false,
      scanError: ""
    };
  },

  async init() {
    this._openRemoteConnection = () => {
      this.data.open.value = true;
      this.setTab("remote");
      this.refresh();
    };
    window.addEventListener("mangayomu:open-remote-connection", this._openRemoteConnection);
    // Camera access needs a secure context, which a LAN http address is not.
    this.data.cameraAvailable.value = Boolean(
      typeof navigator !== "undefined" && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.isSecureContext
    );
    await this.refresh();
  },

  destroy() {
    this.closeScanner();
    window.removeEventListener("mangayomu:open-remote-connection", this._openRemoteConnection);
  },

  /**
   * Read a server address from a QR code with the camera.
   *
   * The code carries the client address of another instance; the instance is
   * verified with its health endpoint before this client switches to it, so a
   * stale or foreign code cannot leave the app pointing at nothing.
   */
  openScanner() {
    this.data.scanOpen.value = true;
    this.data.scanError.value = "";
    this._startCamera();
  },

  closeScanner() {
    this.data.scanOpen.value = false;
    if (this._scanFrame) cancelAnimationFrame(this._scanFrame);
    this._scanFrame = null;
    var stream = this._scanStream;
    if (stream) for (const track of stream.getTracks()) track.stop();
    this._scanStream = null;
  },

  async _startCamera() {
    var video = this.refs.scanVideo;
    try {
      this._scanStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment" },
      });
    } catch (err) {
      this.data.scanError.value = navigator.mediaDevices && navigator.mediaDevices.getUserMedia
        ? "The camera is not available. Allow camera access and try again."
        : "This browser cannot open the camera.";
      return;
    }
    if (!this.data.scanOpen.value) return;
    video.srcObject = this._scanStream;
    try { await video.play(); } catch (err) { /* autoplay policies stop nothing here */ }
    this._scanLoop();
  },

  _scanLoop() {
    var self = this;
    var video = this.refs.scanVideo;
    var canvas = this._scanCanvas || (this._scanCanvas = document.createElement("canvas"));
    var context = canvas.getContext("2d", { willReadFrequently: true });

    function tick() {
      if (!self.data.scanOpen.value || !self._scanStream) return;
      if (video.readyState === video.HAVE_ENOUGH_DATA && video.videoWidth > 0) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        context.drawImage(video, 0, 0, canvas.width, canvas.height);
        var image = context.getImageData(0, 0, canvas.width, canvas.height);
        var found = jsQR(image.data, image.width, image.height, { inversionAttempts: "dontInvert" });
        if (found && found.data) {
          self.closeScanner();
          self.applyScannedServer(found.data);
          return;
        }
      }
      self._scanFrame = requestAnimationFrame(tick);
    }

    this._scanFrame = requestAnimationFrame(tick);
  },

  async applyScannedServer(text) {
    var url;
    try {
      url = new URL(String(text || "").trim());
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    } catch (err) {
      this.data.scanError.value = "That QR code is not a MangaYomu server address.";
      this.data.scanOpen.value = true;
      return;
    }
    this.data.message.value = "";
    try {
      var response = await fetch(new URL("/api/health", url).toString(), { cache: "no-store" });
      var health = await response.json().catch(() => ({}));
      if (!response.ok || health.name !== "MangaYomu") throw new Error("not a MangaYomu server");
    } catch (err) {
      this.data.message.value = "That address did not answer as a MangaYomu server.";
      return;
    }
    setServerConnection(url.origin);
    setCatalogTransport("server");
    window.location.reload();
  },

  async refresh() {
    try {
      this.data.localEmail.value = (await auth.me()).user.email;
    } catch {
      this.data.localEmail.value = "";
    }
    var connection = getConnection();
    this.data.remoteServerUrl.value = connection.serverUrl || "";
    this.data.hostedByNode.value = Boolean(connection.hostedByNode);
    this.data.transport.value = connection.transport;
    this.data.remoteEmail.value = hasActiveServerSession(connection)
      ? connection.serverSession?.email || "Server account #" + connection.serverSession?.accountId
      : "";
  },

  toggle() {
    this.data.open.value = !this.data.open.value;
    if (this.data.open.value) this.refresh();
  },

  close() { this.data.open.value = false; },

  setTab(tab) { this.data.tab.value = tab; this.data.message.value = ""; },

  goLogin() { this.close(); router.navigate("/login"); },
  goSignup() { this.close(); router.navigate("/signup"); },

  async logoutLocal() {
    auth.clearToken();
    notifySessionChanged("client-logout");
    await this.refresh();
  },

  async connectServer() {
    this.data.message.value = "";
    try {
      var host = this.data.host.value.trim();
      if (!host) throw new Error("Enter a server host");
      var port = this.data.port.value.trim() || "4567";
      var url = this.data.protocol.value + "://" + host + (port ? ":" + port : "");
      var response = await fetch(new URL("/api/health", url), { cache: "no-store" });
      if (!response.ok) throw new Error("The server did not answer its health check");
      setServerConnection(url);
      await this.refresh();
      // Browse data and the source list must be reloaded through the selected gateway.
      window.location.reload();
    } catch (error) {
      this.data.message.value = error.message || "Could not connect to the server";
    }
  },

  async loginRemote() {
    this.data.message.value = "";
    try {
      await remoteAuth.login(this.refs.remoteEmailInput.value.trim(), this.refs.remotePasswordInput.value);
      await this.refresh();
      // Browse and Favorites are already mounted: tell them the session changed
      // instead of reloading the whole app.
      notifySessionChanged("remote-login");
    } catch (error) {
      this.data.message.value = error.message || "Could not sign in";
    }
  },

  async signupRemote() {
    this.data.message.value = "";
    try {
      await remoteAuth.signup(this.refs.remoteEmailInput.value.trim(), this.refs.remotePasswordInput.value);
      await this.refresh();
      notifySessionChanged("remote-signup");
    } catch (error) {
      this.data.message.value = error.message || "Could not create the server account";
    }
  },

  async logoutRemote() {
    await remoteAuth.logout();
    await this.refresh();
    notifySessionChanged("remote-logout");
  },

  async switchTransport(transport) {
    var connection = getConnection();
    if (transport === "server" && !connection.serverUrl) {
      // In the with-server APK, Remote means the embedded Node peer.
      if (typeof window.Capacitor !== "undefined") await this.connectServer();
      return;
    }
    if (connection.transport === transport) return;
    setCatalogTransport(transport);

    // Return to Capacitor's bundled localhost client for direct requests.
    // A browser-based source permits that origin, unlike the Node origin.
    if (transport === "direct" && connection.hostedByNode && typeof window.Capacitor !== "undefined") {
      window.location.assign("http://localhost/" + window.location.search + window.location.hash);
      return;
    }
    window.location.reload();
  },

  forgetServer() {
    clearRemoteSession();
    clearServerConnection();
    window.location.reload();
  }
};

export default AccountSwitcher;

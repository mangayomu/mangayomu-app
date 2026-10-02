/**
 * Sync panel — mounted by Settings in the "Data & Sync" tab.
 *
 * Manifest-based reconciliation between this installation and a peer
 * MangaYomu instance (protocol v2): both sides exchange key manifests, the
 * client computes the diff, pulls the newer remote records, applies them to
 * the connected server account and pushes its own newer records back.
 *
 * The local side is the account of the currently connected server; the peer
 * authenticates with email + sync PIN, so it can be another device on the
 * network.
 */

import { builds as buildsApi, remoteAuth, sync as syncApi } from "../api.ts";
import { getConnection } from "../connection";
import { diffManifests } from "../sync-diff.js";

var LS_SYNC_PREFIX = "manga-sync-";

var SyncPanel = {
  name: "SyncPanel",

  // Key lists computed by fetchReport, consumed by runSync
  _toPullFavKeys: [],
  _toPullProgKeys: [],
  _toPushFavKeys: [],
  _toPushProgKeys: [],

  template() {
    return /*html*/`
      <div>
        <div x-show="!available" class="rounded-xl border border-gray-200 bg-white p-5 text-sm text-gray-600 shadow-sm dark:border-gray-700 dark:bg-gray-800 dark:text-gray-300">
          {{ t('Connect to a MangaYomu server and sign in to a server account to synchronize this library with another device.') }}
        </div>

        <div x-show="available" class="space-y-4">
          <!-- This device -->
          <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ t('This device') }}</p>
            <div class="mt-3 flex items-center gap-3 text-sm">
              <span class="text-gray-500 dark:text-gray-400">{{ t('Account') }}</span>
              <span class="font-medium text-gray-900 dark:text-gray-100">{{ email }}</span>
            </div>
            <div class="mt-2 flex items-center gap-3">
              <span class="text-sm text-gray-500 dark:text-gray-400">{{ t('Sync PIN') }}</span>
              <span class="font-mono text-2xl font-bold tracking-widest text-amber-600 dark:text-amber-400">{{ localPin }}</span>
            </div>
            <div class="mt-3 flex flex-wrap items-center gap-2">
              <input ref="newPinInput" type="text" inputmode="numeric" maxlength="8" x-model="newPin"
                class="w-32 rounded-lg border border-gray-200 bg-white px-3 py-2 text-center font-mono text-lg tracking-widest text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:ring-blue-950"
                placeholder="000000" @keyup.enter="setPin" />
              <button @click="setPin" :disabled="busy"
                class="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50">
                {{ t('Set PIN') }}
              </button>
              <button @click="randomPin" :disabled="busy"
                class="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-gray-700 dark:text-gray-200 dark:hover:bg-gray-900">
                {{ t('Random') }}
              </button>
            </div>
            <p x-show="pinMessage" class="mt-2 text-xs" :class="pinMessage.indexOf('ok:') === 0 ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">{{ pinMessage.replace('ok:', '') }}</p>
            <p class="mt-3 text-xs leading-5 text-gray-500 dark:text-gray-400">{{ t('Enter this PIN on the other device to authorize the connection.') }}</p>
          </div>

          <!-- Android app of this server -->
          <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ t('Android app') }}</p>

            <template x-if="apkBuildDate">
              <div class="mt-2 space-y-2">
                <div>
                  <a :href="localApkUrl('withServer')" class="flex items-center gap-1 text-blue-600 hover:text-blue-500 dark:text-blue-400">
                    <span class="material-icons text-base">download</span>
                    {{ t('MangaYomu with server (%s)', apkSizeLabel) }}
                  </a>
                  <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('Build of %s', apkBuildDate) }} · {{ t('Self-contained: the device runs its own server.') }}</p>
                </div>
                <div x-show="clientApkDate">
                  <a :href="localApkUrl('client')" class="flex items-center gap-1 text-blue-600 hover:text-blue-500 dark:text-blue-400">
                    <span class="material-icons text-base">download</span>
                    {{ t('MangaYomu client only (%s)', clientApkSizeLabel) }}
                  </a>
                  <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('Build of %s', clientApkDate) }} · {{ t('Needs a server on the same network. Much smaller.') }}</p>
                </div>
                <p x-show="buildSource === 'remote'" class="text-xs text-gray-500 dark:text-gray-400">{{ t('Published build, not built on this server.') }}</p>
              </div>
            </template>

            <template x-if="!apkBuildDate">
              <div class="mt-2">
                <p class="text-xs leading-5 text-gray-500 dark:text-gray-400">{{ t('No Android build on this server yet.') }}</p>
                <button x-show="canBuild && buildEnabled && isAdmin" @click="buildAndroidApp" :disabled="building"
                  class="mt-3 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:opacity-50">
                  <span class="material-icons text-base">{{ building ? 'hourglass_top' : 'build' }}</span>
                  {{ building ? t('Building…') : t('Build Android app') }}
                </button>
                <p x-show="!buildEnabled" class="mt-2 text-xs text-gray-500 dark:text-gray-400">{{ t('On-demand builds are disabled on this server.') }}</p>
                <p x-show="buildEnabled && canBuild && !isAdmin" class="mt-2 text-xs text-gray-500 dark:text-gray-400">{{ t('An administrator of this server can build it.') }}</p>
                <p x-show="buildEnabled && !canBuild" class="mt-2 text-xs text-gray-500 dark:text-gray-400">{{ t('This server can only build the Android app when it runs from a repository checkout with the Android SDK.') }}</p>
              </div>
            </template>

            <div x-show="building || buildError" class="mt-3 rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
              <p x-show="building" class="text-xs text-gray-600 dark:text-gray-300">{{ t('Building since %s', buildElapsed) }}</p>
              <p x-show="buildError" class="text-xs text-red-600 dark:text-red-400">{{ buildError }}</p>
              <pre x-show="buildLogLine" class="mt-2 overflow-hidden whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-gray-500 dark:text-gray-400">{{ buildLogLine }}</pre>
            </div>
          </div>

          <!-- Peer device -->
          <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ t('Peer device') }}</p>
            <div class="mt-3 flex gap-2">
              <div class="flex-1">
                <label class="mb-1 block text-xs text-gray-500 dark:text-gray-400" for="sync-host">{{ t('Host') }}</label>
                <input id="sync-host" type="text" x-model="remoteHost" @change="persistRemoteSettings"
                  class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:ring-blue-950"
                  placeholder="192.168.1.2" />
              </div>
              <div class="w-24">
                <label class="mb-1 block text-xs text-gray-500 dark:text-gray-400" for="sync-port">{{ t('Port') }}</label>
                <input id="sync-port" type="text" inputmode="numeric" x-model="remotePort" @change="persistRemoteSettings"
                  class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:ring-blue-950"
                  placeholder="4567" />
              </div>
            </div>
            <div class="mt-3">
              <label class="mb-1 block text-xs text-gray-500 dark:text-gray-400" for="sync-email">{{ t('Email of the peer account') }}</label>
              <input id="sync-email" type="email" x-model="remoteEmail" @change="persistRemoteSettings"
                class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:ring-blue-950"
                placeholder="email@example.com" />
            </div>
            <div class="mt-3">
              <label class="mb-1 block text-xs text-gray-500 dark:text-gray-400" for="sync-pin">{{ t('Sync PIN of the peer account') }}</label>
              <input id="sync-pin" type="text" inputmode="numeric" maxlength="8" x-model="remotePin" @change="persistRemoteSettings"
                class="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-center font-mono text-lg tracking-widest text-gray-900 outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100 dark:border-gray-700 dark:bg-gray-900 dark:text-gray-100 dark:focus:ring-blue-950"
                placeholder="000000" />
            </div>
            <p x-show="remoteStatus" class="mt-3 text-xs" :class="remoteOk ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'">{{ remoteStatus }}</p>

            <button @click="testConnection" :disabled="busy || !remoteHost || !remotePort || !remoteEmail || !remotePin"
              class="mt-4 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-4 py-2.5 text-sm font-medium text-gray-800 transition-colors hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-900">
              <span class="material-icons text-base">link</span>
              {{ busy ? t('Connecting…') : t('Connect') }}
            </button>

            <div x-show="remoteOk" class="mt-4 space-y-3">
              <div x-show="buildDate" class="rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-gray-900">
                <div class="text-xs text-gray-500 dark:text-gray-400">{{ t('Latest build on the peer') }}</div>
                <div class="text-gray-800 dark:text-gray-100">{{ t('Build of %s', buildDate) }}</div>
                <a :href="apkDownloadUrl()" target="_blank" class="mt-1 flex items-center gap-1 text-blue-600 hover:text-blue-500 dark:text-blue-400">
                  <span class="material-icons text-base">download</span>
                  {{ t('Download %s', apkName()) }}
                </a>
              </div>

              <div x-show="!reportReady" class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
                <p class="text-xs text-gray-500 dark:text-gray-400">{{ t('Compare both libraries before writing anything.') }}</p>
                <button @click="fetchReport" :disabled="reportLoading || busy"
                  class="mt-2 inline-flex w-full items-center justify-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-800 transition-colors hover:bg-white disabled:opacity-50 dark:border-gray-700 dark:text-gray-100 dark:hover:bg-gray-800">
                  <span class="material-icons text-base">summarize</span>
                  {{ reportLoading ? t('Loading…') : t('Load report') }}
                </button>
              </div>

              <div x-show="reportReady" class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
                <p class="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                  <span class="material-icons text-base">summarize</span>
                  {{ t('Report') }}
                </p>
                <div class="mt-2 grid grid-cols-2 gap-2 text-sm">
                  <div class="rounded-lg bg-white p-2 dark:bg-gray-800">
                    <div class="mb-1 text-xs text-gray-500 dark:text-gray-400">{{ t('Peer → this device') }}</div>
                    <div class="flex items-center gap-2 text-gray-800 dark:text-gray-100">
                      <span class="material-icons text-base text-blue-600 dark:text-blue-400">arrow_downward</span>
                      {{ t('%s favorites, %s progress', reportRemoteFavs, reportRemoteProg) }}
                    </div>
                  </div>
                  <div class="rounded-lg bg-white p-2 dark:bg-gray-800">
                    <div class="mb-1 text-xs text-gray-500 dark:text-gray-400">{{ t('This device → peer') }}</div>
                    <div class="flex items-center gap-2 text-gray-800 dark:text-gray-100">
                      <span class="material-icons text-base text-green-600 dark:text-green-400">arrow_upward</span>
                      {{ t('%s favorites, %s progress', reportLocalFavs, reportLocalProg) }}
                    </div>
                  </div>
                </div>
              </div>

              <button @click="runSync" :disabled="syncing || !reportReady"
                class="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50">
                <span class="material-icons text-base">{{ syncing ? 'sync' : 'sync_alt' }}</span>
                {{ syncing ? t('Synchronizing…') : t('Synchronize') }}
              </button>

              <div x-show="status" class="rounded-lg bg-gray-50 p-3 dark:bg-gray-900">
                <div class="mb-2 text-xs text-gray-500 dark:text-gray-400">{{ t('Log') }}</div>
                <pre class="whitespace-pre-wrap font-mono text-xs leading-relaxed text-green-700 dark:text-green-300">{{ status }}</pre>
              </div>
            </div>
          </div>
        </div>
      </div>`;
  },

  data() {
    return {
      available: false,
      email: "",
      localPin: "",
      newPin: "",
      pinMessage: "",
      remoteHost: "192.168.1.",
      remotePort: "4567",
      remoteEmail: "",
      remotePin: "",
      remoteOk: false,
      remoteStatus: "",
      buildDate: "",
      buildInfo: null,
      reportReady: false,
      reportLoading: false,
      reportRemoteFavs: 0,
      reportRemoteProg: 0,
      reportLocalFavs: 0,
      reportLocalProg: 0,
      busy: false,
      syncing: false,
      status: "",
      // Android app of this server (built on demand where the repo is).
      isAdmin: false,
      canBuild: false,
      buildEnabled: true,
      buildSource: "",
      building: false,
      buildElapsed: "",
      buildLogLine: "",
      buildError: "",
      apkBuildDate: "",
      apkNameLabel: "mangayomu-with-server.apk",
      apkSizeLabel: "",
      clientApkDate: "",
      clientApkSizeLabel: "",
    };
  },

  init() {
    this.data.available.value = syncApi.requiresServerSession();
    this._loadBuildState();
    if (!this.data.available.value) return;
    this._refreshPin();
    try {
      var sHost = localStorage.getItem(LS_SYNC_PREFIX + "host");
      if (sHost) this.data.remoteHost.value = sHost;
      var sPort = localStorage.getItem(LS_SYNC_PREFIX + "port");
      if (sPort) this.data.remotePort.value = sPort;
      var sEmail = localStorage.getItem(LS_SYNC_PREFIX + "email");
      if (sEmail) this.data.remoteEmail.value = sEmail;
      var sPin = localStorage.getItem(LS_SYNC_PREFIX + "pin");
      if (sPin) this.data.remotePin.value = sPin;
    } catch (e) {}
  },

  _buildRemoteUrl() {
    var host = String(this.data.remoteHost.value || "").trim();
    var port = String(this.data.remotePort.value || "").trim();
    if (!host) return null;
    return port ? "http://" + host + ":" + port : "http://" + host;
  },

  apkName() {
    var info = this.data.buildInfo.value;
    return info && info.apkName ? info.apkName : "mangayomu.apk";
  },

  apkDownloadUrl() {
    var remoteUrl = this._buildRemoteUrl();
    if (remoteUrl) return remoteUrl + "/api/builds/apk";
    var connection = getConnection();
    return connection.serverUrl ? connection.serverUrl + "/api/builds/apk" : "";
  },

  persistRemoteSettings() {
    try {
      localStorage.setItem(LS_SYNC_PREFIX + "host", this.data.remoteHost.value);
      localStorage.setItem(LS_SYNC_PREFIX + "port", this.data.remotePort.value);
      localStorage.setItem(LS_SYNC_PREFIX + "email", this.data.remoteEmail.value);
      localStorage.setItem(LS_SYNC_PREFIX + "pin", this.data.remotePin.value);
    } catch (e) {}
  },

  beforeDestroy() {
    if (this._buildPoll) clearTimeout(this._buildPoll);
    this._buildPoll = null;
  },

  /**
   * Read what this server can offer for Android: the built APK it already
   * serves, and whether it is able to build one on demand.
   */
  async _loadBuildState() {
    if (!syncApi.requiresServerSession()) return;
    try {
      var me = await remoteAuth.me();
      this.data.isAdmin.value = !!(me.user && me.user.is_admin);
    } catch (err) {
      this.data.isAdmin.value = false;
    }
    try {
      this.applyBuildInfo(await buildsApi.info());
      // The client-only flavour is a separate download; it may not exist.
      var client = await buildsApi.info("client");
      this.data.clientApkDate.value = client.buildDate || "";
      this.data.clientApkSizeLabel.value = this.formatSize(client.apkSize);
      var status = await buildsApi.status();
      this.data.canBuild.value = !!status.canBuild;
      if (status.building) this.watchBuild();
    } catch (err) {
      // A server that cannot answer stays without an Android section.
    }
  },

  formatSize(size) {
    return size > 1048576
      ? (size / 1048576).toFixed(1) + " MB"
      : size > 1024 ? (size / 1024).toFixed(0) + " KB" : "";
  },

  applyBuildInfo(info) {
    this.data.canBuild.value = !!(info && info.canBuild);
    this.data.buildEnabled.value = !info || info.buildEnabled !== false;
    this.data.buildSource.value = (info && info.source) || "";
    this.data.apkBuildDate.value = (info && info.buildDate) || "";
    this.data.apkNameLabel.value = (info && info.apkName) || "mangayomu-with-server.apk";
    this.data.apkSizeLabel.value = this.formatSize((info && info.apkSize) || 0);
  },

  localApkUrl(variant) {
    var connection = getConnection();
    if (!connection.serverUrl) return "";
    return connection.serverUrl + "/api/builds/apk" + (variant === "client" ? "?variant=client" : "");
  },

  async buildAndroidApp() {
    this.data.buildError.value = "";
    this.data.buildLogLine.value = "";
    this.data.building.value = true;
    this._buildStartedAt = Date.now();
    try {
      await buildsApi.buildAndroid();
      this.watchBuild();
    } catch (err) {
      this.data.building.value = false;
      this.data.buildError.value = err.message;
    }
  },

  /** Poll the build until it finishes, then pick up the fresh APK. */
  watchBuild() {
    this.data.building.value = true;
    if (!this._buildStartedAt) this._buildStartedAt = Date.now();
    var self = this;
    var tick = async function () {
      try {
        var status = await buildsApi.status();
        self.data.canBuild.value = !!status.canBuild;
        var log = status.log || [];
        self.data.buildLogLine.value = log.length ? log[log.length - 1] : "";
        if (status.startedAt) {
          var seconds = Math.max(0, Math.round((Date.now() - Date.parse(status.startedAt)) / 1000));
          self.data.buildElapsed.value = Math.floor(seconds / 60) + "m " + String(seconds % 60).padStart(2, "0") + "s";
        }
        if (status.building) {
          self._buildPoll = setTimeout(tick, 2000);
          return;
        }
        self.data.building.value = false;
        self.data.buildError.value = status.error || "";
        self.applyBuildInfo(await buildsApi.info());
      } catch (err) {
        self.data.building.value = false;
        self.data.buildError.value = err.message;
      }
    };
    this._buildPoll = setTimeout(tick, 1500);
  },

  async _refreshPin() {
    try {
      var keyInfo = await syncApi.getOwnKey();
      this.data.email.value = keyInfo.email || "";
      if (!this.data.remoteEmail.value) this.data.remoteEmail.value = keyInfo.email || "";
      if (keyInfo.syncKey) {
        this.data.localPin.value = keyInfo.syncKey;
      } else {
        this.data.localPin.value = "------";
      }
    } catch (err) {
      this.data.localPin.value = "??";
    }
  },

  async setPin() {
    var pin = String(this.data.newPin.value || "").trim();
    if (!/^\d{4,8}$/.test(pin)) {
      this.data.pinMessage.value = "The PIN must be 4 to 8 digits";
      return;
    }
    this.data.busy.value = true;
    try {
      var result = await syncApi.regenerateOwnKey(pin);
      this.data.localPin.value = result.syncKey;
      this.data.newPin.value = "";
      this.data.pinMessage.value = "ok:PIN saved";
    } catch (err) {
      this.data.pinMessage.value = err.message || "Could not save the PIN";
    } finally {
      this.data.busy.value = false;
    }
  },

  randomPin() {
    this.data.newPin.value = String(Math.floor(100000 + Math.random() * 900000));
  },

  async testConnection() {
    this.data.busy.value = true;
    this.data.remoteOk.value = false;
    this.data.remoteStatus.value = "";
    this.data.reportReady.value = false;
    this.data.reportRemoteFavs.value = 0;
    this.data.reportRemoteProg.value = 0;
    this.data.reportLocalFavs.value = 0;
    this.data.reportLocalProg.value = 0;

    var remoteUrl = this._buildRemoteUrl();
    if (!remoteUrl) {
      this.data.remoteStatus.value = "Missing host";
      this.data.busy.value = false;
      return;
    }

    this.persistRemoteSettings();
    try {
      var hello = await syncApi.hello(remoteUrl, this.data.remoteEmail.value.trim(), this.data.remotePin.value.trim());
      if (hello.protocolVersion !== 2) {
        this.data.remoteStatus.value = "Incompatible version: update the app on both devices";
        return;
      }
      this.data.remoteOk.value = true;
      this.data.remoteStatus.value = "Connected";
      this._fetchBuildInfo(remoteUrl);
    } catch (err) {
      this.data.remoteOk.value = false;
      this.data.remoteStatus.value = err.message || "Connection failed";
    } finally {
      this.data.busy.value = false;
    }
  },

  async _fetchBuildInfo(remoteUrl) {
    var info = await syncApi.getBuildInfo(remoteUrl);
    if (!info || !info.buildDate) return;
    this.data.buildInfo.value = info;
    this.data.buildDate.value = info.buildDate;
  },

  async fetchReport() {
    this.data.reportLoading.value = true;
    this.data.status.value = "";
    var remoteUrl = this._buildRemoteUrl();
    try {
      var email = this.data.remoteEmail.value.trim();
      var pin = this.data.remotePin.value.trim();
      var results = await Promise.all([
        syncApi.manifest(remoteUrl, email, pin),
        syncApi.getLocalManifest(),
      ]);
      var remoteManifest = results[0];
      var localManifest = results[1];

      var favDiff = diffManifests(remoteManifest.favorites, localManifest.favorites);
      var progDiff = diffManifests(remoteManifest.progress, localManifest.progress);

      this._toPullFavKeys = favDiff.toPull;
      this._toPullProgKeys = progDiff.toPull;
      this._toPushFavKeys = favDiff.toPush;
      this._toPushProgKeys = progDiff.toPush;

      this.data.reportRemoteFavs.value = this._toPullFavKeys.length;
      this.data.reportRemoteProg.value = this._toPullProgKeys.length;
      this.data.reportLocalFavs.value = this._toPushFavKeys.length;
      this.data.reportLocalProg.value = this._toPushProgKeys.length;
      this.data.reportReady.value = true;
    } catch (err) {
      this._addLog("Report failed: " + (err.message || err));
    } finally {
      this.data.reportLoading.value = false;
    }
  },

  async runSync() {
    this.data.syncing.value = true;
    this.data.status.value = "";
    var remoteUrl = this._buildRemoteUrl();
    if (!remoteUrl) {
      this._addLog("Missing host");
      this.data.syncing.value = false;
      return;
    }
    var email = this.data.remoteEmail.value.trim();
    var pin = this.data.remotePin.value.trim();

    try {
      this._addLog("Starting synchronization…");

      this._addLog("Pulling " + this._toPullFavKeys.length + " favorites and " + this._toPullProgKeys.length + " progress items…");
      var pulled = await syncApi.pull(remoteUrl, email, pin, this._toPullFavKeys, this._toPullProgKeys);
      var pulledFavs = pulled.favorites || [];
      var pulledProg = pulled.progress || [];

      if (pulledFavs.length > 0 || pulledProg.length > 0) {
        this._addLog("Applying " + pulledFavs.length + " favorites and " + pulledProg.length + " progress items…");
        await syncApi.localApply({ favorites: pulledFavs, progress: pulledProg });
        this._addLog("Peer data applied");
      }

      var pushFavs = [];
      var pushProg = [];
      if (this._toPushFavKeys.length > 0 || this._toPushProgKeys.length > 0) {
        this._addLog("Collecting local changes…");
        var pushData = await syncApi.getLocalPushData(this._toPushFavKeys, this._toPushProgKeys);
        pushFavs = pushData.favorites || [];
        pushProg = pushData.progress || [];
      }

      if (pushFavs.length > 0 || pushProg.length > 0) {
        this._addLog("Sending " + pushFavs.length + " favorites and " + pushProg.length + " progress items…");
        await syncApi.push(remoteUrl, email, pin, { favorites: pushFavs, progress: pushProg });
        this._addLog("Upload complete");
      } else {
        this._addLog("Nothing to send: already aligned");
      }

      this._addLog("Synchronization complete.");
    } catch (err) {
      this._addLog("Error: " + (err.message || err));
    } finally {
      this.data.syncing.value = false;
    }
  },

  _addLog(message) {
    var timestamp = new Date().toLocaleTimeString();
    var current = this.data.status.value;
    this.data.status.value = current ? current + "\n[" + timestamp + "] " + message : "[" + timestamp + "] " + message;
  },
};

export default SyncPanel;

/**
 * Backup import panel — mounted by Settings in the "Data & Sync" tab.
 *
 * Reads a Tachiyomi/Mihon backup (.proto / .proto.gz / .tachibk) entirely on
 * the device and writes it either into the local client library or into the
 * connected server account.
 */

import { backupImport } from "../api.ts";
import { getConnection } from "../connection";
import { previewBackup } from "@mangayomu/backup-import";

var BackupImportPanel = {
  name: "BackupImportPanel",

  template() {
    return /*html*/`
      <div class="rounded-xl border border-gray-200 bg-white p-5 shadow-sm dark:border-gray-700 dark:bg-gray-800">
        <p class="text-sm leading-6 text-gray-600 dark:text-gray-300">{{ t('The Tachiyomi/Mihon backup is read and decoded only on this device. You can then save its data locally or send the processed data to the selected server.') }}</p>
          <label class="mt-5 block text-sm font-medium text-gray-700 dark:text-gray-200" for="backup-file">{{ t('File .proto, .proto.gz, or .tachibk') }}</label>
          <input id="backup-file" ref="file" type="file" accept=".proto,.gz,.tachibk" @change="readFile($event)" class="mt-2 block w-full text-sm text-gray-600 dark:text-gray-300" />

          <div x-show="payload" class="mt-5 rounded-lg bg-gray-50 p-4 text-sm dark:bg-gray-900">
            <p class="font-medium text-gray-900 dark:text-gray-100">{{fileName}}</p>
            <p class="mt-1 text-gray-600 dark:text-gray-300">{{ t('%s manga · %s favorites · %s progress items', summary.mangaTotal, summary.favorites, summary.progress) }}</p>
            <p x-show="summary.skipped" class="mt-1 text-amber-700 dark:text-amber-300">{{ t('%s unsupported source items will be skipped.', summary.skipped) }}</p>
          </div>
          <p x-show="error" class="mt-4 text-sm text-red-600 dark:text-red-400">{{ t(error) }}</p>

          <div x-show="payload" class="mt-5">
            <p class="text-sm font-medium text-gray-700 dark:text-gray-200">{{ t('Destination') }}</p>
            <div class="mt-2 grid grid-cols-2 gap-2 rounded-lg bg-gray-100 p-1 dark:bg-gray-900">
              <button @click="selectTarget('local')" :class="target === 'local' ? 'bg-white shadow dark:bg-gray-700' : ''" class="rounded-md px-3 py-2 text-sm font-medium">{{ t('This device') }}</button>
              <button @click="selectTarget('remote')" :disabled="!remoteAvailable" :class="target === 'remote' ? 'bg-white shadow dark:bg-gray-700' : ''" class="rounded-md px-3 py-2 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40">{{ t('Remote server') }}</button>
            </div>
            <p x-show="!remoteAvailable" class="mt-2 text-xs text-gray-500 dark:text-gray-400">{{ t('To import to the server, connect to it and sign in to a remote account.') }}</p>
            <button @click="apply" :disabled="loading" class="mt-4 inline-flex items-center gap-2 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"><span class="material-icons text-base">{{loading ? 'hourglass_top' : 'file_download'}}</span>{{ loading ? t('Importing…') : t('Import data') }}</button>
          </div>
          <p x-show="result" class="mt-4 text-sm text-green-700 dark:text-green-300">{{ result ? t('Imported %s manga.', result.importedManga) : '' }}</p>
      </div>`;
  },

  data() {
    return { payload: null, fileName: "", summary: {}, target: "local", remoteAvailable: false, loading: false, error: "", result: null };
  },

  init() {
    this.data.remoteAvailable.value = Boolean(getConnection().serverSession);
  },

  async readFile(event) {
    this.data.error.value = "";
    this.data.result.value = null;
    var file = event.target.files && event.target.files[0];
    if (!file) return;
    try {
      var payload = await backupImport.decode(file);
      this.data.payload.value = payload;
      this.data.fileName.value = file.name;
      this.data.summary.value = previewBackup(payload);
    } catch (error) {
      this.data.payload.value = null;
      this.data.error.value = error.message || "Unable to read the backup";
    }
  },

  selectTarget(target) {
    if (target === "local" || this.data.remoteAvailable.value) this.data.target.value = target;
  },

  async apply() {
    if (!this.data.payload.value) return;
    this.data.loading.value = true;
    this.data.error.value = "";
    try {
      this.data.result.value = this.data.target.value === "remote"
        ? await backupImport.applyRemote(this.data.payload.value)
        : await backupImport.applyLocal(this.data.payload.value);
    } catch (error) {
      this.data.error.value = error.message || "Import failed";
    } finally {
      this.data.loading.value = false;
    }
  },
};

export default BackupImportPanel;

import protobuf from "protobufjs";

// Kept in JS so the same decoder runs in a browser, Node, and embedded Node.
// Unknown backup fields are safely skipped by protobuf, therefore only import-relevant
// Mihon/Tachiyomi fields are declared here.
const SCHEMA = `syntax = "proto2"; package backup;
message BackupChapter { optional string url = 1; optional string name = 2; optional bool read = 4; optional int64 lastPageRead = 6; optional float chapterNumber = 9; }
message BackupManga { optional int64 source = 1; optional string url = 2; optional string title = 3; optional string artist = 4; optional string author = 5; optional string description = 6; repeated string genre = 7; optional string thumbnailUrl = 9; repeated BackupChapter chapters = 16; optional bool favorite = 100; }
message Backup { repeated BackupManga backupManga = 1; }`;
const Backup = protobuf.parse(SCHEMA).root.lookupType("backup.Backup");
// Kotlin source IDs are signed 64-bit values. Keep their decimal form as
// strings: converting them to JavaScript Number silently rounds the low bits.
const SOURCE_IDS = {
  "2499283573021220255": "mangadex",
  "7114846210461894145": "mangaworld",
};

export function isSupportedBackupFile(name) {
  return /\.(proto|proto\.gz|tachibk|gz)$/i.test(name || "");
}

async function decompress(bytes) {
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes;
  if (typeof DecompressionStream !== "function") {
    throw new Error("Questo browser non supporta la decompressione gzip. Usa un backup .proto non compresso.");
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function mangaId(source, url) {
  const value = String(url || "");
  if (source === "mangadex") {
    const match = value.match(/\/(?:manga|title)\/([0-9a-f-]{36})/i);
    return match ? match[1] : value.replace(/^\/manga\//, "").split("?")[0];
  }
  return value.replace(/^\/manga\//, "").split("?")[0];
}

function chapterId(source, url) {
  const value = String(url || "");
  if (source === "mangadex") {
    const match = value.match(/\/chapter\/([0-9a-f-]{36})/i);
    return match ? match[1] : value.replace(/^\/chapter\//, "").split("?")[0];
  }
  return value.includes("/read/") ? value.split("/read/")[1].split("?")[0] : value;
}

/** Decode locally and return transport-neutral, JSON-safe import data. */
export async function decodeBackup(bytes, fileName = "backup.proto") {
  if (!isSupportedBackupFile(fileName)) throw new Error("Unsupported format. Use .proto, .proto.gz, or .tachibk");
  const raw = await decompress(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  const decoded = Backup.toObject(Backup.decode(raw), { longs: String, defaults: true });
  const skipped = [];
  const manga = [];
  for (const item of decoded.backupManga || []) {
    const source = SOURCE_IDS[String(item.source)];
    if (!source) { skipped.push(String(item.title || "Senza titolo")); continue; }
    const id = mangaId(source, item.url);
    if (!id) { skipped.push(String(item.title || "Senza titolo")); continue; }
    manga.push({
      id, source, title: String(item.title || ""), coverUrl: item.thumbnailUrl || null,
      author: item.author || item.artist || "", description: item.description || "", genres: item.genre || [],
      // Tachiyomi serializes the library list as backupManga. Older .tachibk
      // exports leave the optional `favorite` field unset, so it decodes as
      // false even though every entry belongs to the exported library.
      favorite: true,
      chapters: (item.chapters || []).filter((chapter) => chapter.read || Number(chapter.lastPageRead) > 0).map((chapter) => ({
        id: chapterId(source, chapter.url), chapterNumber: Number(chapter.chapterNumber) || 0,
        title: chapter.name || "", lang: source === "mangaworld" ? "it" : "unknown",
        pageIndex: Number(chapter.lastPageRead) || 0, completed: Boolean(chapter.read),
      })).filter((chapter) => chapter.id),
    });
  }
  return { version: 1, manga, skipped };
}

export function previewBackup(payload) {
  const manga = payload.manga || [];
  return {
    mangaTotal: manga.length, favorites: manga.filter((item) => item.favorite).length,
    progress: manga.reduce((count, item) => count + item.chapters.length, 0), skipped: (payload.skipped || []).length,
  };
}

/** Apply the same normalized payload to either a browser or server storage adapter. */
export async function applyBackup(payload, target) {
  const summary = { ...previewBackup(payload), importedManga: 0, errors: [] };
  for (const item of payload.manga || []) {
    try {
      await target.saveManga(item);
      if (item.favorite) await target.saveFavorite(item);
      for (const chapter of item.chapters) await target.saveProgress(item, chapter);
      summary.importedManga++;
    } catch (error) {
      summary.errors.push(`${item.title || item.id}: ${error.message}`);
    }
  }
  return summary;
}

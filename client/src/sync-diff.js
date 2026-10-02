/**
 * sync-diff.js — pure function for manifest comparison.
 *
 * Takes remote manifest + local manifest → computes what to pull/push.
 * No dependencies, no side effects, testable with `node:test`.
 *
 * Manifest format:
 *   [{ key: "source:manga_id" | "manga_id:chapter_id", updated_at: "ISO datetime" | null, deleted: bool }]
 */

export function diffManifests(remoteManifest, localManifest) {
  // Fast path: key set identico → già allineati, skip confronto timestamp.
  // Timestamp possono differire per ri-migrazione su altra macchina.
  if (keysEqual(remoteManifest, localManifest)) {
    return { toPull: [], toPush: [] };
  }

  var remoteMap = new Map();
  for (var i = 0; i < remoteManifest.length; i++) {
    remoteMap.set(remoteManifest[i].key, remoteManifest[i]);
  }

  var toPull = [];
  var toPush = [];

  for (var i = 0; i < localManifest.length; i++) {
    var l = localManifest[i];
    var r = remoteMap.get(l.key);
    if (!r) {
      toPush.push(l.key);                          // locale-only → push
    } else if (cmp(r.updated_at, l.updated_at) > 0) {
      toPull.push(l.key);                           // remoto più recente → pull
    } else if (cmp(l.updated_at, r.updated_at) > 0) {
      toPush.push(l.key);                           // locale più recente → push
    }
    // timestamp uguali (o entrambi null) → già allineati, skip
    if (r) remoteMap.delete(l.key);
  }

  // chiavi rimaste: esistono solo sul remoto
  for (var key of remoteMap.keys()) {
    toPull.push(key);
  }

  return { toPull: toPull, toPush: toPush };
}

/** True if both arrays contain exactly the same set of keys with the same deleted state. */
function keysEqual(a, b) {
  if (a.length !== b.length) return false;
  var map = new Map();
  for (var i = 0; i < a.length; i++) map.set(a[i].key, a[i].deleted);
  for (var i = 0; i < b.length; i++) {
    var aDel = map.get(b[i].key);
    if (aDel === undefined) return false;
    if (!!aDel !== !!b[i].deleted) return false;
  }
  return true;
}

/** Compare two SQL datetime strings (may be null). */
function cmp(a, b) {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (a > b) return 1;
  if (a < b) return -1;
  return 0;
}

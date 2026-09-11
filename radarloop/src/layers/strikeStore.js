/**
 * A local store of lightning frames, so history can outlive the provider's.
 *
 * The provider keeps exactly 24 hours: a frame 24 hours old is served in full,
 * one 25 hours old returns 204, and every hour beyond that stays empty. That is
 * retention, not a gap — their own client has no other endpoint, and it skips
 * lightning entirely in archive mode. So there is nowhere to ask for more.
 *
 * What there is instead is everything already fetched. Frames are immutable
 * once published, so each one that passes through is kept here, and the layer
 * asks this store before it asks the network. History therefore reaches back 24
 * hours on a first run and grows from there, for as long as the browser keeps
 * the database.
 *
 * The raw bytes are stored rather than the parsed arrays: 40 KB against 80 KB a
 * frame, and re-parsing one costs about a millisecond.
 *
 * Everything here degrades to a no-op when IndexedDB is unavailable — a private
 * window, or a browser with storage switched off — leaving the layer with the
 * provider's 24 hours and no error.
 */

const DB_NAME = 'radarloop-lightning';
const DB_VERSION = 1;
const STORE = 'frames';

/** How long frames are kept. Beyond the provider's 24 hours, this is the limit. */
export const RETENTION_DAYS = 7;

/**
 * Ceiling on what the store may hold.
 *
 * A frame is around 40 KB and there are 288 a day, so a week is roughly 80 MB.
 * The cap is what stops an unusually stormy fortnight filling the disk; the
 * oldest frames go first.
 */
export const MAX_BYTES = 200 * 1024 * 1024;

let dbPromise = null;
let unavailable = false;

function openDb() {
  if (unavailable) return Promise.resolve(null);
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let request;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      unavailable = true;
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'ts' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { unavailable = true; resolve(null); };
    request.onblocked = () => resolve(null);
  });
  return dbPromise;
}

/** Wraps one transaction as a promise. Resolves null on any failure. */
function run(mode, work) {
  return openDb().then((db) => {
    if (!db) return null;
    return new Promise((resolve) => {
      let result = null;
      let tx;
      try {
        tx = db.transaction(STORE, mode);
      } catch {
        resolve(null);
        return;
      }
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => resolve(null);
      tx.onabort = () => resolve(null);
      try {
        work(tx.objectStore(STORE), (value) => { result = value; });
      } catch {
        resolve(null);
      }
    });
  });
}

/** The bytes of a stored frame, or null. */
export function readFrame(ts) {
  return run('readonly', (store, done) => {
    const request = store.get(ts);
    request.onsuccess = () => done(request.result ? request.result.bytes : null);
  });
}

/** Keeps a frame. Empty frames are stored too — they are an answer, not a gap. */
export function writeFrame(ts, bytes) {
  return run('readwrite', (store) => {
    store.put({ ts, bytes, size: bytes.byteLength, at: Date.now() });
  });
}

/** Which frame timestamps in a list are already held. */
export function storedKeys(from, to) {
  return run('readonly', (store, done) => {
    const keys = [];
    const request = store.getAllKeys(IDBKeyRange.bound(from, to));
    request.onsuccess = () => {
      for (const key of request.result) keys.push(key);
      done(keys);
    };
  }).then((keys) => keys || []);
}

/** Oldest and newest frame held, with a count and a total size. */
export function summary() {
  return run('readonly', (store, done) => {
    let oldest = null;
    let newest = null;
    let count = 0;
    let bytes = 0;
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        done({ oldest, newest, count, bytes });
        return;
      }
      if (oldest === null) oldest = cursor.value.ts;
      newest = cursor.value.ts;
      count += 1;
      bytes += cursor.value.size || 0;
      cursor.continue();
    };
  }).then((value) => value || { oldest: null, newest: null, count: 0, bytes: 0 });
}

/**
 * Drops what is past the retention window, then the oldest until under the cap.
 *
 * Run once at startup rather than per write: the cost is one cursor walk, and a
 * frame or two over the limit for a few minutes is not worth paying it more
 * often.
 */
export function prune({ retentionDays = RETENTION_DAYS, maxBytes = MAX_BYTES } = {}) {
  const horizon = Date.now() - retentionDays * 24 * 3600 * 1000;
  return run('readwrite', (store, done) => {
    let removed = 0;
    let bytes = 0;
    const sizes = [];
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        if (cursor.value.ts < horizon) {
          cursor.delete();
          removed += 1;
        } else {
          bytes += cursor.value.size || 0;
          sizes.push([cursor.value.ts, cursor.value.size || 0]);
        }
        cursor.continue();
        return;
      }
      // Oldest first until the total is under the cap.
      sizes.sort((a, b) => a[0] - b[0]);
      for (const [ts, size] of sizes) {
        if (bytes <= maxBytes) break;
        store.delete(ts);
        bytes -= size;
        removed += 1;
      }
      done({ removed, bytes });
    };
  }).then((value) => value || { removed: 0, bytes: 0 });
}

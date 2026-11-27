export const READING_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const READING_BUDGET_BYTES = 5 * 1024 * 1024;
const databaseName = 'lingo-private-reading';
const storeName = 'pages';
const encoder = new TextEncoder();

export type StoredReading = {
  owner: string;
  key: string;
  checkedAt: number;
  savedAt: number;
  value: unknown;
};

let connection: Promise<IDBDatabase> | undefined;
function openDisk() {
  if (!connection) {
    connection = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: ['owner', 'key'] });
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); connection = undefined; };
        resolve(db);
      };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('READING_CACHE_UNAVAILABLE'));
    });
    void connection.catch(() => { connection = undefined; });
  }
  return connection;
}

// A single transaction also prevents an account switch from pruning a snapshot
// part way through a write in another tab on this device.
async function editDisk<T>(edit: (store: IDBObjectStore, rows: StoredReading[]) => T) {
  const db = await openDisk();
  return new Promise<T>((resolve, reject) => {
    const transaction = db.transaction(storeName, 'readwrite');
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    let result: T;
    request.onsuccess = () => {
      try { result = edit(store, request.result); }
      catch { transaction.abort(); }
    };
    transaction.oncomplete = () => resolve(result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error || new Error('READING_CACHE_UNAVAILABLE'));
  });
}

const expired = (entry: StoredReading, now: number) => !Number.isFinite(entry.savedAt) || now - entry.savedAt >= READING_RETENTION_MS;
function withinBudget(rows: StoredReading[], now: number) {
  let used = 0;
  return rows.filter(row => !expired(row, now)).sort((a, b) => b.savedAt - a.savedAt).filter(row => {
    const size = encoder.encode(JSON.stringify(row)).byteLength;
    if (used + size > READING_BUDGET_BYTES) return false;
    used += size;
    return true;
  });
}

export async function readStoredReading(owner: string, allowed: () => boolean) {
  return await editDisk((store, rows) => {
    if (!allowed()) return [];
    const kept = withinBudget(rows.filter(row => row.owner === owner), Date.now());
    const retained = new Set(kept);
    for (const row of rows) if (!retained.has(row)) store.delete([row.owner, row.key]);
    return kept;
  });
}

export async function writeStoredReading(owner: string, updated: StoredReading[], removed: string[], allowed: () => boolean) {
  await editDisk((store, rows) => {
    if (!allowed()) return;
    const replaced = new Set([...removed, ...updated.map(row => row.key)]);
    const kept = withinBudget([...updated, ...rows.filter(row => row.owner === owner && !replaced.has(row.key))], Date.now());
    const retained = new Set(kept.map(row => row.key));
    for (const row of rows) if (row.owner !== owner || !retained.has(row.key)) store.delete([row.owner, row.key]);
    for (const row of updated) if (retained.has(row.key)) store.put(row);
  });
}

export async function clearStoredReading(owner: string) {
  await editDisk((store, rows) => {
    for (const row of rows) if (row.owner === owner) store.delete([owner, row.key]);
  });
}

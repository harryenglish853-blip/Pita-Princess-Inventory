"use client";
/** Minimal promise wrapper around IndexedDB for offline counts. */
const DB_NAME = "stockline-offline";
const VERSION = 1;
export const STORES = { sheets: "sheets", queue: "queue", entries: "entries" } as const;

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.sheets)) db.createObjectStore(STORES.sheets, { keyPath: "session_id" });
      if (!db.objectStoreNames.contains(STORES.queue)) {
        const q = db.createObjectStore(STORES.queue, { keyPath: "client_entry_id" });
        q.createIndex("session_id", "session_id");
      }
      if (!db.objectStoreNames.contains(STORES.entries)) {
        const e = db.createObjectStore(STORES.entries, { keyPath: "key" });
        e.createIndex("session_id", "session_id");
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx<T>(store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const t = db.transaction(store, mode);
        const s = t.objectStore(store);
        const r = fn(s);
        let result: T;
        if (r) r.onsuccess = () => { result = r.result; };
        t.oncomplete = () => resolve(result);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error);
      }),
  );
}

export const idb = {
  get: <T>(store: string, key: IDBValidKey) => tx<T>(store, "readonly", (s) => s.get(key) as IDBRequest<T>),
  put: <T>(store: string, value: T) => tx<IDBValidKey>(store, "readwrite", (s) => s.put(value)),
  del: (store: string, key: IDBValidKey) => tx<undefined>(store, "readwrite", (s) => s.delete(key) as IDBRequest<undefined>),
  all: <T>(store: string) => tx<T[]>(store, "readonly", (s) => s.getAll() as IDBRequest<T[]>),
  byIndex: <T>(store: string, index: string, key: IDBValidKey) => tx<T[]>(store, "readonly", (s) => s.index(index).getAll(key) as IDBRequest<T[]>),
  count: (store: string) => tx<number>(store, "readonly", (s) => s.count()),
};

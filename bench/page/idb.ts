/** Promise wrappers for raw IndexedDB. */

export function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error("transaction aborted"));
  });
}

export function openIdb(name: string, upgrade: (db: IDBDatabase) => void): Promise<IDBDatabase> {
  const req = indexedDB.open(name, 1);
  req.onupgradeneeded = () => upgrade(req.result);
  return request(req);
}

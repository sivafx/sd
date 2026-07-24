/**
 * db.js — File Handle Registry (disk-first storage)
 *
 * Canvas data is stored ONLY in .shiva files on the user's hard disk.
 * This module stores ONLY the FileSystemFileHandle objects (plus a small
 * metadata record: docId + title) so the app can re-open the same files
 * on the next browser session and re-request permission automatically.
 *
 * localStorage is still used for tiny UI prefs (theme, scale, active doc id).
 */

// ─── File Handle Registry ──────────────────────────────────────────────────
const REGISTRY_DB_NAME = "shivadraw_fileregistry";
const REGISTRY_STORE   = "file_handles";
const REGISTRY_VERSION = 1;

let _registryDbPromise = null;

function getRegistryDB() {
  if (_registryDbPromise) return _registryDbPromise;

  _registryDbPromise = new Promise((resolve, reject) => {
    let timeoutId = setTimeout(() => {
      timeoutId = null;
      _registryDbPromise = null;
      reject(new Error("FileHandle registry DB timeout"));
    }, 2000);

    try {
      const request = indexedDB.open(REGISTRY_DB_NAME, REGISTRY_VERSION);

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(REGISTRY_STORE)) {
          db.createObjectStore(REGISTRY_STORE, { keyPath: "docId" });
        }
      };

      request.onsuccess = (event) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          resolve(event.target.result);
        } else {
          try { event.target.result.close(); } catch (e) {}
        }
      };

      request.onerror = (event) => {
        const error = event.target.error;
        console.error("FileHandle registry DB open error:", error);
        if (timeoutId) {
          clearTimeout(timeoutId);
          _registryDbPromise = null;
          reject(error || new Error("Registry DB open error"));
        }
      };

      request.onblocked = () => {
        console.warn("FileHandle registry DB open blocked");
        if (timeoutId) {
          clearTimeout(timeoutId);
          _registryDbPromise = null;
          reject(new Error("Registry DB blocked"));
        }
      };
    } catch (err) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        _registryDbPromise = null;
        reject(err);
      }
    }
  });

  return _registryDbPromise;
}

/**
 * Store a FileSystemFileHandle for a document.
 * @param {string} docId
 * @param {FileSystemFileHandle} handle
 * @param {string} title
 * @param {string} [backgroundStyle]
 */
export async function storeFileHandle(docId, handle, title, backgroundStyle) {
  try {
    const db = await getRegistryDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REGISTRY_STORE, 'readwrite');
      const store = tx.objectStore(REGISTRY_STORE);
      const request = store.put({
        docId,
        handle,
        title: title || 'Untitled',
        backgroundStyle: backgroundStyle || 'pure-white',
        updatedAt: Date.now()
      });
      request.onsuccess = () => resolve();
      request.onerror  = () => reject(request.error);
    });
  } catch (err) {
    console.error('storeFileHandle error:', err);
  }
}

/**
 * Retrieve all stored file handles.
 * @returns {Promise<Array<{docId, handle, title, backgroundStyle, updatedAt}>>}
 */
export async function getAllFileHandles() {
  try {
    const db = await getRegistryDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REGISTRY_STORE, 'readonly');
      const store = tx.objectStore(REGISTRY_STORE);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result || []);
      request.onerror  = () => reject(request.error);
    });
  } catch (err) {
    console.error('getAllFileHandles error:', err);
    return [];
  }
}

/**
 * Remove a file handle from the registry (e.g. when a board is deleted).
 * @param {string} docId
 */
export async function removeFileHandle(docId) {
  try {
    const db = await getRegistryDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REGISTRY_STORE, 'readwrite');
      const store = tx.objectStore(REGISTRY_STORE);
      const request = store.delete(docId);
      request.onsuccess = () => resolve();
      request.onerror  = () => reject(request.error);
    });
  } catch (err) {
    console.error('removeFileHandle error:', err);
  }
}

/**
 * Update the title stored in the registry entry.
 */
export async function updateHandleTitle(docId, title) {
  try {
    const db = await getRegistryDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REGISTRY_STORE, 'readwrite');
      const store = tx.objectStore(REGISTRY_STORE);
      const getReq = store.get(docId);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) { resolve(); return; }
        const putReq = store.put({ ...existing, title, updatedAt: Date.now() });
        putReq.onsuccess = () => resolve();
        putReq.onerror   = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } catch (err) {
    console.error('updateHandleTitle error:', err);
  }
}

/**
 * Update the backgroundStyle stored in the registry entry.
 */
export async function updateHandleBackground(docId, backgroundStyle) {
  try {
    const db = await getRegistryDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(REGISTRY_STORE, 'readwrite');
      const store = tx.objectStore(REGISTRY_STORE);
      const getReq = store.get(docId);
      getReq.onsuccess = () => {
        const existing = getReq.result;
        if (!existing) { resolve(); return; }
        const putReq = store.put({ ...existing, backgroundStyle, updatedAt: Date.now() });
        putReq.onsuccess = () => resolve();
        putReq.onerror   = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  } catch (err) {
    console.error('updateHandleBackground error:', err);
  }
}

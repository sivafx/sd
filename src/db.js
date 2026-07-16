const DB_NAME = "shivadraw_db";
const STORE_NAME = "documents_store";
const DB_VERSION = 1;

let dbPromise = null;

function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    let timeoutId = setTimeout(() => {
      timeoutId = null;
      dbPromise = null;
      reject(new Error("IndexedDB connection timeout (1500ms)"));
    }, 1500);

    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onblocked = () => {
        console.warn("IndexedDB open blocked by another connection.");
        if (timeoutId) {
          clearTimeout(timeoutId);
          dbPromise = null;
          reject(new Error("IndexedDB blocked"));
        }
      };

      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };

      request.onsuccess = (event) => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          resolve(event.target.result);
        } else {
          // If connection opened after timeout, close it to avoid leaking/blocking
          try {
            event.target.result.close();
          } catch (e) {}
        }
      };

      request.onerror = (event) => {
        const error = event.target.error;
        console.error("IndexedDB open error:", error);
        if (error && error.name === "CorruptError") {
          console.warn("IndexedDB database is corrupted. Attempting to delete database to recover...");
          try {
            indexedDB.deleteDatabase(DB_NAME);
          } catch (e) {
            console.error("Failed to delete corrupted IndexedDB:", e);
          }
        }
        if (timeoutId) {
          clearTimeout(timeoutId);
          dbPromise = null;
          reject(error || new Error("IndexedDB open error"));
        }
      };
    } catch (err) {
      if (timeoutId) {
        clearTimeout(timeoutId);
        dbPromise = null;
        reject(err);
      }
    }
  });

  return dbPromise;
}

/**
 * Retrieves an item from IndexedDB.
 * Falls back to localStorage if IndexedDB fails or is unavailable.
 */
export async function getItem(key) {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readonly");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(key);

      request.onsuccess = () => {
        resolve(request.result !== undefined ? request.result : null);
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch (error) {
    console.error("IndexedDB getItem error, falling back to localStorage:", error);
    try {
      const val = localStorage.getItem(key);
      return val ? JSON.parse(val) : null;
    } catch (e) {
      return null;
    }
  }
}

/**
 * Checks if IndexedDB is supported and accessible in the current browser context.
 */
export async function isIndexedDBSupported() {
  try {
    const db = await getDB();
    return !!db;
  } catch (e) {
    return false;
  }
}

/**
 * Stores an item in IndexedDB.
 * Falls back to localStorage if IndexedDB fails or is unavailable.
 */
export async function setItem(key, value) {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put(value, key);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch (error) {
    console.error("IndexedDB setItem error, falling back to localStorage:", error);
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      console.error("LocalStorage fallback setItem error:", e);
      throw e;
    }
  }
}

/**
 * Removes an item from IndexedDB.
 * Falls back to localStorage if IndexedDB fails or is unavailable.
 */
export async function removeItem(key) {
  try {
    const db = await getDB();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(key);

      request.onsuccess = () => {
        resolve();
      };

      request.onerror = () => {
        reject(request.error);
      };
    });
  } catch (error) {
    console.error("IndexedDB removeItem error, falling back to localStorage:", error);
    try {
      localStorage.removeItem(key);
    } catch (e) {}
  }
}

/**
 * Stores an item in the Origin Private File System (OPFS).
 * OPFS allows storing unlimited data directly to the user's hard drive without permission dialogs.
 */
export async function setItemOPFS(key, value) {
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) return;
    const dir = await navigator.storage.getDirectory();
    // Using a .json extension for clarity, but the key is fine
    const fileHandle = await dir.getFileHandle(`${key}.json`, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify(value));
    await writable.close();
  } catch (error) {
    console.warn(`OPFS setItemOPFS error for key ${key}:`, error);
  }
}

/**
 * Retrieves an item from the Origin Private File System (OPFS).
 */
export async function getItemOPFS(key) {
  try {
    if (!navigator.storage || !navigator.storage.getDirectory) return null;
    const dir = await navigator.storage.getDirectory();
    const fileHandle = await dir.getFileHandle(`${key}.json`);
    const file = await fileHandle.getFile();
    const text = await file.text();
    return JSON.parse(text);
  } catch (error) {
    // Usually means the file doesn't exist yet, which is normal
    return null;
  }
}

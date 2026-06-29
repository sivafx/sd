const DB_NAME = "shivadraw_db";
const STORE_NAME = "documents_store";
const DB_VERSION = 1;

let dbPromise = null;

function getDB() {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };

    request.onsuccess = (event) => {
      resolve(event.target.result);
    };

    request.onerror = (event) => {
      reject(event.target.error);
    };
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

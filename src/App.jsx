import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { Excalidraw, MainMenu, exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { getItem, setItem, isIndexedDBSupported } from "./db";

// Helper function to create basic Excalidraw elements
const BACKGROUND_PRESETS = ["pure-white", "solid-classic", "blueprint", "dot-grid", "graph-grid", "schoolboard", "sunset", "aurora", "midnight"];
const isPresetBackground = (style) => BACKGROUND_PRESETS.includes(style);

// Presets that are dark — watermark should be light on these
const DARK_BACKGROUND_PRESETS = new Set(["blueprint", "schoolboard", "midnight"]);

// For custom hex/rgba colors: return true if the color is perceived as dark
const isColorDark = (color) => {
  if (!color || color === "transparent") return false;
  try {
    // Handle hex colors
    const hex = color.replace("#", "");
    if (/^[0-9a-fA-F]{3,6}$/.test(hex)) {
      const full = hex.length === 3 ? hex.split("").map(c => c + c).join("") : hex;
      const r = parseInt(full.slice(0, 2), 16);
      const g = parseInt(full.slice(2, 4), 16);
      const b = parseInt(full.slice(4, 6), 16);
      // Perceived luminance formula
      return (0.299 * r + 0.587 * g + 0.114 * b) < 128;
    }
    // Handle rgb/rgba
    const m = color.match(/rgba?\s*\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
    if (m) {
      return (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) < 128;
    }
  } catch (e) { /* ignore */ }
  return false;
};


const createBaseElement = (type, x, y, width, height, custom = {}) => ({
  id: `${type}-${Math.random().toString(36).substr(2, 9)}`,
  type,
  x,
  y,
  width,
  height,
  angle: 0,
  strokeColor: "#6366f1",
  backgroundColor: "transparent",
  fillStyle: "hachure",
  strokeWidth: 1,
  strokeStyle: "solid",
  roughness: 0,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: type === "rectangle" ? null : { type: 2 },
  seed: Math.floor(Math.random() * 100000),
  version: 1,
  versionNonce: Math.floor(Math.random() * 100000),
  isDeleted: false,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
  ...custom
});

const createTextElement = (text, x, y, size = 20, custom = {}) => 
  createBaseElement("text", x, y, text.length * (size * 0.6), size * 1.2, {
    text,
    fontSize: size,
    fontFamily: 5, // Sans-serif (Virgil is 1, Helvetica is 2, Monospace is 3, Excalifont/Roboto is 5)
    textAlign: "center",
    verticalAlign: "middle",
    ...custom
  });

// Singleton canvas reused across all measureTextDimensions calls — avoids allocating a new
// HTMLCanvasElement + CanvasRenderingContext2D on every call (costly during font refresh).
let _measureCanvas = null;
let _measureCtx = null;

const measureTextDimensions = (text, fontSize, fontFamilyName, lineHeight = 1.25) => {
  if (!_measureCanvas) {
    _measureCanvas = document.createElement("canvas");
    _measureCtx = _measureCanvas.getContext("2d");
  }
  const ctx = _measureCtx;
  if (!ctx) return { width: text.length * (fontSize * 0.6), height: fontSize * lineHeight };
  
  ctx.font = `${fontSize}px "${fontFamilyName}", sans-serif`;
  const lines = text.split("\n");
  let maxWidth = 0;
  for (const line of lines) {
    const metrics = ctx.measureText(line);
    if (metrics.width > maxWidth) {
      maxWidth = metrics.width;
    }
  }
  
  const height = lines.length * fontSize * lineHeight;
  return {
    width: Math.ceil(maxWidth),
    height: Math.ceil(height)
  };
};

const createArrowElement = (x, y, points, custom = {}) => 
  createBaseElement("arrow", x, y, 10, 10, {
    points,
    ...custom
  });

const sanitizeAppState = (appState) => {
  if (!appState) return {};
  return {
    currentItemStrokeColor: appState.currentItemStrokeColor,
    currentItemBackgroundColor: appState.currentItemBackgroundColor,
    currentItemFillStyle: appState.currentItemFillStyle,
    currentItemStrokeWidth: appState.currentItemStrokeWidth,
    currentItemStrokeStyle: appState.currentItemStrokeStyle,
    currentItemRoughness: appState.currentItemRoughness,
    currentItemOpacity: appState.currentItemOpacity,
    // NOTE: currentItemFontFamily and currentItemFontSize are intentionally NOT
    // persisted. Saving them caused a bug where changing one text element's font
    // would make that font the "default" for the whole scene on next reload.
    // Each element stores its own fontFamily directly on the element itself.
    currentItemTextAlign: appState.currentItemTextAlign,
    currentItemStartArrowhead: appState.currentItemStartArrowhead,
    currentItemEndArrowhead: appState.currentItemEndArrowhead,
    currentItemRoundnessType: appState.currentItemRoundnessType,
    currentItemRoundness: appState.currentItemRoundness,
    // Always save as transparent so our CSS wrapper controls the background.
    // This prevents the saved white viewBackgroundColor from overriding background presets on next load.
    viewBackgroundColor: "transparent",
    zoom: appState.zoom ? { value: appState.zoom.value } : undefined,
    scrollX: appState.scrollX,
    scrollY: appState.scrollY
  };
};


const smoothPoints = (points, iterations = 2) => {
  if (points.length < 3) return points;
  let current = points.map(p => [...p]);
  for (let iter = 0; iter < iterations; iter++) {
    const next = [];
    next.push(current[0]);
    for (let i = 1; i < current.length - 1; i++) {
      const prev = current[i - 1];
      const curr = current[i];
      const nxt = current[i + 1];
      const smoothX = 0.25 * prev[0] + 0.5 * curr[0] + 0.25 * nxt[0];
      const smoothY = 0.25 * prev[1] + 0.5 * curr[1] + 0.25 * nxt[1];
      next.push([smoothX, smoothY]);
    }
    next.push(current[current.length - 1]);
    current = next;
  }
  return current;
};

// Deep-clone elements and map their binding/group IDs to ensure uniqueness
const cloneElements = (elements) => {
  if (!elements || elements.length === 0) return [];
  const idMap = {};
  
  // 1. Generate new unique IDs and establish mapping
  const cloned = elements.map(el => {
    const newId = `${el.type}-${Math.random().toString(36).substr(2, 9)}`;
    idMap[el.id] = newId;
    return { ...el, id: newId };
  });

  // 2. Remap parent/child linkings, seeds and version nonces
  return cloned.map(el => {
    const updated = {
      ...el,
      seed: Math.floor(Math.random() * 100000),
      version: el.version + 1,
      versionNonce: Math.floor(Math.random() * 100000),
      updated: Date.now()
    };

    if (updated.boundElements) {
      updated.boundElements = updated.boundElements.map(bound => ({
        ...bound,
        id: idMap[bound.id] || bound.id
      }));
    }

    if (updated.startBinding) {
      updated.startBinding = {
        ...updated.startBinding,
        elementId: idMap[updated.startBinding.elementId] || updated.startBinding.elementId
      };
    }
    
    if (updated.endBinding) {
      updated.endBinding = {
        ...updated.endBinding,
        elementId: idMap[updated.endBinding.elementId] || updated.endBinding.elementId
      };
    }

    return updated;
  });
};


// Preloaded drawings for templates
const SEED_DOCS = [
  {
    id: "blank-canvas",
    title: "New Canvas 🎨",
    updatedAt: Date.now(),
    elements: [],
    appState: {
      currentItemStrokeWidth: 1,
      currentItemRoughness: 0,
      currentItemRoundness: "sharp",
      currentItemFontFamily: 2
    },
    backgroundStyle: "pure-white"
  }
];

const FLOWCHART_ELEMENTS = [
  createBaseElement("ellipse", 350, 60, 120, 60, { strokeColor: "#10b981", fillStyle: "solid", backgroundColor: "#d1fae5" }),
  createTextElement("Start", 390, 78, 16, { strokeColor: "#065f46" }),
  
  createArrowElement(410, 120, [[0, 0], [0, 60]], { strokeColor: "#94a3b8" }),
  
  createBaseElement("diamond", 330, 180, 160, 90, { strokeColor: "#f59e0b", fillStyle: "solid", backgroundColor: "#fef3c7" }),
  createTextElement("Is it working?", 355, 212, 14, { strokeColor: "#92400e" }),
  
  createArrowElement(490, 225, [[0, 0], [100, 0]], { strokeColor: "#94a3b8" }), 
  createTextElement("Yes", 515, 200, 14, { strokeColor: "#475569" }),
  
  createArrowElement(330, 225, [[0, 0], [-100, 0]], { strokeColor: "#94a3b8" }), 
  createTextElement("No", 285, 200, 14, { strokeColor: "#475569" }),
  
  createBaseElement("rectangle", 590, 185, 160, 80, { strokeColor: "#10b981", roundness: { type: 3 } }),
  createTextElement("Celebrate! 🎉", 620, 212, 16, { strokeColor: "#065f46" }),
  
  createBaseElement("rectangle", 80, 185, 210, 80, { strokeColor: "#ef4444", roundness: { type: 3 } }),
  createTextElement("Fix with Antigravity! 🚀", 95, 212, 14, { strokeColor: "#991b1b" })
];

const MINDMAP_ELEMENTS = [
  createBaseElement("ellipse", 340, 200, 180, 80, { strokeColor: "#6366f1", fillStyle: "solid", backgroundColor: "#e0e7ff", strokeWidth: 3 }),
  createTextElement("Launch Idea 💡", 360, 225, 18, { strokeColor: "#3730a3" }),
  
  createArrowElement(340, 220, [[0, 0], [-140, -80]], { strokeColor: "#818cf8" }),
  createBaseElement("rectangle", 110, 100, 130, 60, { strokeColor: "#ec4899", roundness: { type: 3 } }),
  createTextElement("Design 🎨", 140, 118, 16, { strokeColor: "#9d174d" }),
  
  createArrowElement(520, 220, [[0, 0], [140, -80]], { strokeColor: "#818cf8" }),
  createBaseElement("rectangle", 630, 100, 130, 60, { strokeColor: "#3b82f6", roundness: { type: 3 } }),
  createTextElement("Tech Stack 💻", 640, 118, 15, { strokeColor: "#1e3a8a" }),
  
  createArrowElement(340, 260, [[0, 0], [-140, 80]], { strokeColor: "#818cf8" }),
  createBaseElement("rectangle", 110, 320, 130, 60, { strokeColor: "#10b981", roundness: { type: 3 } }),
  createTextElement("Marketing 📣", 120, 338, 15, { strokeColor: "#065f46" }),
  
  createArrowElement(520, 260, [[0, 0], [140, 80]], { strokeColor: "#818cf8" }),
  createBaseElement("rectangle", 630, 320, 130, 60, { strokeColor: "#f59e0b", roundness: { type: 3 } }),
  createTextElement("Launch 🏁", 655, 338, 16, { strokeColor: "#92400e" })
];

const WIREFRAME_ELEMENTS = [
  createBaseElement("rectangle", 300, 50, 280, 500, { strokeColor: "#475569", strokeWidth: 4, roundness: { type: 3 } }),
  createBaseElement("rectangle", 300, 50, 280, 25, { strokeColor: "#94a3b8", strokeWidth: 1 }),
  createTextElement("09:41", 310, 55, 11, { strokeColor: "#64748b" }),
  createTextElement("📶 🔋", 530, 55, 11, { strokeColor: "#64748b" }),
  
  createBaseElement("rectangle", 300, 75, 280, 50, { strokeColor: "#94a3b8", strokeWidth: 1 }),
  createTextElement("Shiva Mobile App", 350, 88, 15, { strokeColor: "#334155" }),
  
  createBaseElement("rectangle", 320, 145, 240, 150, { strokeColor: "#cbd5e1", strokeStyle: "dashed" }),
  createArrowElement(320, 145, [[0, 0], [240, 150]], { strokeColor: "#e2e8f0" }),
  createArrowElement(560, 145, [[0, 0], [-240, 150]], { strokeColor: "#e2e8f0" }),
  
  createTextElement("Explore the Infinite Canvas", 340, 315, 16, { strokeColor: "#0f172a" }),
  createTextElement("Create high fidelity designs, flowchart\ndiagrams and mockups in seconds.", 320, 345, 11, { strokeColor: "#64748b" }),
  
  createBaseElement("rectangle", 320, 415, 240, 45, { strokeColor: "#6366f1", fillStyle: "solid", backgroundColor: "#e0e7ff", roundness: { type: 3 } }),
  createTextElement("Get Started Now", 375, 428, 14, { strokeColor: "#4f46e5" }),
  
  createBaseElement("rectangle", 300, 510, 280, 40, { strokeColor: "#cbd5e1", strokeWidth: 1 }),
  createTextElement("🏠 Home     🔍 Search     ⚙️ Settings", 325, 520, 12, { strokeColor: "#475569" })
];

export default function App() {
  const [documents, setDocuments] = useState([]);
  const [activeDocId, setActiveDocId] = useState("");
  const [editingDocId, setEditingDocId] = useState(null);
  const [theme, setTheme] = useState("light");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [propertiesPanelVisible, setPropertiesPanelVisible] = useState(true);
  const [notification, setNotification] = useState(null);
  const [excalidrawAPI, setExcalidrawAPI] = useState(null);
  const [loading, setLoading] = useState(true);
  const [predefinedColors, setPredefinedColors] = useState({
    stroke: [],
    background: []
  });

  const activeDocIdRef = useRef("");
  const isSwitchingRef = useRef(true);
  const saveTimeoutRef = useRef(null);
  const latestDataRef = useRef({ elements: [] });
  const fileInputRef = useRef(null);
  const backupInputRef = useRef(null);
  const isInitialMountRef = useRef(true);
  const autoSaveEnabledRef = useRef(false); // mirror of autoSaveEnabled for use inside callbacks
  const initialDataRef = useRef(null);
  // Ref to guard setSaveStatus — avoids a React re-render on every 60fps onChange call
  const saveStatusRef = useRef("saved");
  // Single shared MutationObserver registry — avoids 4 separate body+subtree observers
  const sharedObserverCallbacks = useRef(new Set());
  const sharedObserverRef = useRef(null);
  // Ref mirror of documents — allows emergency save / stable callbacks to read the latest
  // docs without capturing them in a stale closure or needing them as effect deps.
  const latestDocumentsRef = useRef([]);
  const [activeDropdown, setActiveDropdown] = useState(null);
  const [brushSmoothing, setBrushSmoothing] = useState(() => {
    return parseInt(localStorage.getItem("shivadraw_brush_smoothing") || "3", 10);
  });

  const [saveStatus, setSaveStatus] = useState("saved"); // "saved" | "saving"
  const [searchQuery, setSearchQuery] = useState("");
  const [pdfDialogOpen, setPdfDialogOpen] = useState(false);
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(false);
  const [autoSaveFileName, setAutoSaveFileName] = useState(""); // display name of the file handle
  const [autoSaveDiskStatus, setAutoSaveDiskStatus] = useState("idle"); // "idle" | "saving" | "saved" | "error"
  // Map of docId -> FileSystemFileHandle to support per-board file handles
  const fileHandlesRef = useRef({});
  const autoSaveTimeoutRef = useRef(null);
  const lastDiskSaveTimeRef = useRef(0);
  const [filePermissionState, setFilePermissionState] = useState("granted"); // "granted" | "prompt" | "denied"

  const [showNotifications, setShowNotifications] = useState(() => {
    const saved = localStorage.getItem("shivadraw_show_notifications");
    return saved ? saved === "true" : true;
  });
  const [showCanvasControls, setShowCanvasControls] = useState(() => {
    const saved = localStorage.getItem("shivadraw_show_canvas_controls");
    return saved ? saved === "true" : true;
  });

  const handleToggleCanvasControls = useCallback((e) => {
    const checked = e.target.checked;
    setShowCanvasControls(checked);
    localStorage.setItem("shivadraw_show_canvas_controls", checked);
  }, []);
  const [uiScale, setUiScale] = useState(() => {
    const saved = localStorage.getItem("shivadraw_ui_scale");
    return saved ? parseFloat(saved) : 0.75;
  });
  const [watermarkSize, setWatermarkSize] = useState(() => {
    return localStorage.getItem("shivadraw_watermark_size") || "0.9";
  });

  useEffect(() => {
    document.documentElement.style.setProperty("--ui-scale", uiScale);
  }, [uiScale]);

  useEffect(() => {
    document.title = "Shiva Canvas";
  }, []);

  // Sync showNotifications setting to document.body class list
  useEffect(() => {
    if (!showNotifications) {
      document.body.classList.add("hide-toasts");
    } else {
      document.body.classList.remove("hide-toasts");
    }
    return () => {
      document.body.classList.remove("hide-toasts");
    };
  }, [showNotifications]);

  const toggleDropdown = useCallback((name, e) => {
    e.stopPropagation();
    setActiveDropdown(prev => prev === name ? null : name);
  }, []);

  // ─── Single shared MutationObserver for all DOM-injection features ───────────
  // Each feature effect registers a callback here instead of creating its own
  // observer watching document.body with subtree:true (which fires on every repaint).
  useEffect(() => {
    const observer = new MutationObserver(() => {
      sharedObserverCallbacks.current.forEach(cb => cb());
    });
    observer.observe(document.body, { childList: true, subtree: true });
    sharedObserverRef.current = observer;
    return () => {
      observer.disconnect();
      sharedObserverRef.current = null;
    };
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    const handleOutsideClick = () => setActiveDropdown(null);
    window.addEventListener("click", handleOutsideClick);
    return () => window.removeEventListener("click", handleOutsideClick);
  }, []);

  // Sync activeDocId to ref
  useEffect(() => {
    activeDocIdRef.current = activeDocId;
    if (activeDocId) {
      localStorage.setItem("shivadraw_active_id", activeDocId);
    }
  }, [activeDocId]);

  // Keep latestDocumentsRef always current so stable callbacks (emergency save, handleKeyDown)
  // can read the latest docs without capturing them in stale closures or effect deps.
  useEffect(() => {
    latestDocumentsRef.current = documents;
  }, [documents]);

  // Load documents on mount
  useEffect(() => {
    const loadData = async () => {
      // Load theme synchronously from localStorage as it affects the initial render theme immediately
      const savedTheme = localStorage.getItem("shivadraw_theme") || localStorage.getItem("exceldraw_theme") || "light";
      setTheme(savedTheme);
      document.documentElement.className = savedTheme === "dark" ? "theme-dark" : "theme-light";

      let loadedDocs = null;
      let initialActiveId = "";

      try {
        // Try getting from IndexedDB first
        loadedDocs = await getItem("shivadraw_docs");
      } catch (err) {
        console.error("Error loading documents from IndexedDB:", err);
      }

      // Check if loadedDocs is a valid array
      if (loadedDocs && !Array.isArray(loadedDocs)) {
        console.warn("Loaded documents from IndexedDB is not an array:", loadedDocs);
        loadedDocs = null;
      }

      // Migration from localStorage if not in IndexedDB
      if (!loadedDocs) {
        const hasNewDocs = localStorage.getItem("shivadraw_docs") !== null;
        const savedDocsString = localStorage.getItem("shivadraw_docs") || localStorage.getItem("exceldraw_docs");
        
        if (savedDocsString) {
          try {
            loadedDocs = JSON.parse(savedDocsString);
            if (!Array.isArray(loadedDocs)) {
              console.warn("Parsed migrated documents from localStorage is not an array:", loadedDocs);
              loadedDocs = null;
            }
            
            // Check if IndexedDB is available/supported before writing and cleaning up
            if (loadedDocs) {
              const isSupported = await isIndexedDBSupported();
              if (isSupported) {
                // Save to IndexedDB
                await setItem("shivadraw_docs", loadedDocs);
                
                // Clean up localStorage to free up space (since it has a 5MB limit)
                localStorage.removeItem("shivadraw_docs");
                localStorage.removeItem("exceldraw_docs");
                console.log("Successfully migrated localStorage documents to IndexedDB and cleared legacy keys.");
              } else {
                console.log("IndexedDB not supported or blocked. Keeping original documents in localStorage fallback.");
              }
            }
          } catch (e) {
            console.error("Migration from localStorage failed:", e);
            loadedDocs = null;
          }
        }
      }

      // Secondary recovery: fallback to localStorage backup if still no documents loaded
      if (!loadedDocs || loadedDocs.length === 0) {
        const backupStr = localStorage.getItem("shivadraw_docs_backup");
        if (backupStr) {
          try {
            const parsed = JSON.parse(backupStr);
            if (Array.isArray(parsed) && parsed.length > 0) {
              loadedDocs = parsed;
              console.log("Successfully recovered documents from localStorage backup!");
              // Try restoring to IndexedDB to rebuild database
              const isSupported = await isIndexedDBSupported();
              if (isSupported) {
                await setItem("shivadraw_docs", loadedDocs);
              }
            }
          } catch (e) {
            console.error("Failed to parse localStorage backup:", e);
          }
        }
      }

      // Seed initial data if still no documents found
      if (!loadedDocs || loadedDocs.length === 0) {
        loadedDocs = SEED_DOCS;
        try {
          await setItem("shivadraw_docs", SEED_DOCS);
        } catch (err) {
          console.error("Failed to seed documents in IndexedDB:", err);
        }
        showToast("Welcome to Shiva Canvas! 🎨", "success");
      }

      // Ensure loadedDocs is indeed an array here and sanitize documents
      if (Array.isArray(loadedDocs)) {
        loadedDocs = loadedDocs.filter(doc => doc && typeof doc === "object" && typeof doc.id === "string");
      } else {
        loadedDocs = SEED_DOCS;
      }

      // Resolve the active document ID
      const savedActiveId = localStorage.getItem("shivadraw_active_id") || localStorage.getItem("exceldraw_active_id");
      if (savedActiveId && loadedDocs.some(d => d.id === savedActiveId)) {
        initialActiveId = savedActiveId;
      } else if (loadedDocs.length > 0) {
        initialActiveId = loadedDocs[0].id;
      }

      // Clean up legacy localStorage active_id/theme if migrating
      if (localStorage.getItem("exceldraw_theme") !== null) {
        try {
          localStorage.setItem("shivadraw_theme", savedTheme);
          if (initialActiveId) {
            localStorage.setItem("shivadraw_active_id", initialActiveId);
          }
          localStorage.removeItem("exceldraw_theme");
          localStorage.removeItem("exceldraw_active_id");
        } catch (e) {
          console.error("Clean up of old settings keys failed:", e);
        }
      }

      // Populate fileHandlesRef from loaded docs
      if (Array.isArray(loadedDocs)) {
        loadedDocs.forEach(doc => {
          if (doc.fileHandle) {
            fileHandlesRef.current[doc.id] = doc.fileHandle;
          }
        });
      }

      // Update React states and initial refs
      setDocuments(loadedDocs);
      if (initialActiveId) {
        setActiveDocId(initialActiveId);
        const activeDoc = loadedDocs.find(d => d.id === initialActiveId);
        if (activeDoc) {
          const savedAppState = activeDoc.appState && typeof activeDoc.appState === "object" ? activeDoc.appState : {};
          // If the doc has a custom/preset background, force transparent so our CSS wrapper shows through
          const hasCustomBg = activeDoc.backgroundStyle && activeDoc.backgroundStyle !== "pure-white";
          const initialElements = Array.isArray(activeDoc.elements) ? activeDoc.elements : [];
          const initialFiles = activeDoc.files && typeof activeDoc.files === "object" ? activeDoc.files : {};

          initialDataRef.current = {
            elements: initialElements,
            appState: hasCustomBg
              ? { currentItemFontFamily: 2, ...savedAppState, viewBackgroundColor: "transparent" }
              : { currentItemFontFamily: 2, ...savedAppState },
            files: initialFiles
          };

          // Initialize latestDataRef on mount with the correct active document data
          latestDataRef.current = {
            elements: initialElements,
            appState: savedAppState,
            files: initialFiles
          };
        }
      }
      setLoading(false);
    };

    loadData();
  }, []);

  // Sync documents state changes to IndexedDB
  useEffect(() => {
    if (loading) return;

    let isCurrent = true;
    const saveDocs = async () => {
      setSaveStatus("saving");
      try {
        await setItem("shivadraw_docs", documents);
        
        // Save lightweight backup to localStorage
        try {
          const backupDocs = documents.map(doc => ({
            id: doc.id,
            title: doc.title,
            updatedAt: doc.updatedAt,
            elements: doc.elements,
            appState: doc.appState,
            backgroundStyle: doc.backgroundStyle,
            fileHandle: doc.fileHandle,
            autoSaveEnabled: doc.autoSaveEnabled
          }));
          localStorage.setItem("shivadraw_docs_backup", JSON.stringify(backupDocs));
        } catch (e) {
          console.warn("Failed to save localStorage backup:", e);
        }

        if (isCurrent) {
          setSaveStatus("saved");
        }
      } catch (err) {
        console.error("Failed to auto-save documents to IndexedDB:", err);
        // Fallback backup attempt if IndexedDB write fails
        try {
          const backupDocs = documents.map(doc => ({
            id: doc.id,
            title: doc.title,
            updatedAt: doc.updatedAt,
            elements: doc.elements,
            appState: doc.appState,
            backgroundStyle: doc.backgroundStyle,
            fileHandle: doc.fileHandle,
            autoSaveEnabled: doc.autoSaveEnabled
          }));
          localStorage.setItem("shivadraw_docs_backup", JSON.stringify(backupDocs));
          if (isCurrent) {
            setSaveStatus("saved");
          }
        } catch (e) {
          console.error("LocalStorage fallback backup also failed:", e);
          showToast("Failed to save changes! Storage issue.", "error");
          if (isCurrent) {
            setSaveStatus("saved");
          }
        }
      }
    };

    saveDocs();
    return () => {
      isCurrent = false;
    };
  }, [documents, loading]);

  // Load custom colors from colors.json if available
  useEffect(() => {
    fetch(`${import.meta.env.BASE_URL}colors.json`)
      .then((r) => {
        if (!r.ok) throw new Error("File not found");
        return r.json();
      })
      .then((data) => {
        setPredefinedColors({
          stroke: Array.isArray(data.stroke) ? data.stroke : [],
          background: Array.isArray(data.background) ? data.background : []
        });
      })
      .catch((err) => {
        console.log("No custom colors.json loaded, using defaults.");
        // Fallback default structure
        setPredefinedColors({
          stroke: ["#6366f1", "#ec4899", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#8b5cf6", "#3b82f6"],
          background: [
            "rgba(99, 102, 241, 0.15)",
            "rgba(236, 72, 153, 0.15)",
            "rgba(16, 185, 129, 0.15)",
            "rgba(245, 158, 11, 0.15)",
            "rgba(239, 68, 68, 0.15)",
            "rgba(6, 182, 212, 0.15)",
            "rgba(139, 92, 246, 0.15)",
            "rgba(59, 130, 246, 0.15)"
          ]
        });
      });
  }, []);

  // Intercept and inject custom colors from colors.txt into the built-in Excalidraw color picker popovers as EXTRA colors
  useEffect(() => {
    if (loading || (!predefinedColors.stroke.length && !predefinedColors.background.length)) return;

    const injectCustomColors = () => {
      // Find all color picker popovers / dropdowns in Excalidraw UI (globally, supporting Radix Portal)
      const popovers = document.querySelectorAll(
        ".color-picker, .popover, [class*='color-picker']"
      );
      
      popovers.forEach((popover) => {
        // Only process popovers that contain swatch buttons
        const buttons = Array.from(popover.querySelectorAll("button"));
        const swatches = buttons.filter((btn) => {
          const text = btn.innerText.trim();
          return text.length === 1 && !btn.classList.contains("custom-appended-swatch");
        });

        if (swatches.length === 0) return;

        const gridContainer = swatches[0].parentElement;
        if (!gridContainer) return;

        // Find and hide Excalidraw's built-in "most used custom colors" / "recent colors" section
        const customColorsPanels = popover.querySelectorAll(
          ".color-picker__custom-colors, .color-picker-custom-colors, [class*='color-picker__custom-colors'], [class*='color-picker-custom-colors'], .color-picker__custom-colors-wrapper"
        );
        customColorsPanels.forEach(panel => {
          panel.style.setProperty("display", "none", "important");
        });

        // Hide headings and their next sibling panels by matching text content exactly (case-insensitive) for leaf nodes
        const headings = Array.from(popover.querySelectorAll("h3, span, label, .color-picker__heading, [class*='heading']"));
        headings.forEach(el => {
          if (el.children.length > 0) return; // Only target leaf nodes (text elements) to avoid hiding parent containers
          const text = el.textContent.trim().toLowerCase();
          if (
            text === "most used" || 
            text === "recent" || 
            text === "custom colors" || 
            text === "most used custom colors" ||
            text === "recently used"
          ) {
            el.style.setProperty("display", "none", "important");
            if (el.nextElementSibling) {
              el.nextElementSibling.style.setProperty("display", "none", "important");
            }
          }
        });

        // Determine whether this popover is for stroke, fill background, or canvas background
        let isCanvasBackground = false;
        let isBackground = false;
        
        const activeTrigger = document.querySelector("button[aria-expanded='true']");
        if (activeTrigger) {
          const label = (activeTrigger.getAttribute("aria-label") || activeTrigger.getAttribute("title") || "").toLowerCase();
          if (label.includes("canvas")) {
            isCanvasBackground = true;
          } else if (label.includes("background")) {
            isBackground = true;
          }
        } else {
          // Fallback to DOM hierarchy
          const container = popover.closest(".color-picker-container, .color-picker-control-container") || popover.parentElement;
          const trigger = container ? container.querySelector("button") : null;
          
          isCanvasBackground = !!(
            trigger &&
            (trigger.getAttribute("aria-label")?.toLowerCase().includes("canvas") ||
             trigger.getAttribute("title")?.toLowerCase().includes("canvas"))
          );

          isBackground = !!(
            trigger &&
            !isCanvasBackground &&
            (trigger.getAttribute("aria-label")?.toLowerCase().includes("background") ||
             trigger.getAttribute("title")?.toLowerCase().includes("background"))
          );
        }

        // Mix custom solid colors for this section
        let customPalette = [];
        if (isCanvasBackground || isBackground) {
          customPalette = [...predefinedColors.background];
        } else {
          customPalette = [...predefinedColors.stroke];
        }

        // Append custom colors as extra swatches
        customPalette.forEach((item) => {
          const displayColor = item;

          // Check if we already appended this color to this grid container
          const existing = Array.from(gridContainer.querySelectorAll(".custom-appended-swatch"))
                               .find(swatch => swatch.dataset.color === displayColor);
          if (existing) return;

          // Clone the template swatch button to keep the exact styling
          const newSwatch = swatches[0].cloneNode(true);
          newSwatch.className = swatches[0].className; // copy classes
          newSwatch.classList.add("custom-appended-swatch");
          newSwatch.classList.remove("is-transparent");
          newSwatch.dataset.color = displayColor;
          newSwatch.title = displayColor;
          newSwatch.setAttribute("aria-label", displayColor);
          
          // Clear any letter text inside the cloned swatch so it's a solid color
          newSwatch.textContent = "";

          // Target color display
          const colorDisplay = newSwatch.querySelector("[style*='background-color']") || newSwatch;
          if (colorDisplay !== newSwatch) {
            colorDisplay.classList.remove("is-transparent");
          }
          colorDisplay.style.background = displayColor;
          colorDisplay.style.setProperty("background", displayColor, "important");

          // Intercept click to trigger Excalidraw hex change
          const handleSwatchClick = (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (isCanvasBackground) {
              // Save it to the active document backgroundStyle state
              setDocuments(prevDocs => {
                return prevDocs.map(doc => {
                  if (doc.id === activeDocIdRef.current) {
                    return {
                      ...doc,
                      backgroundStyle: displayColor,
                      updatedAt: Date.now()
                    };
                  }
                  return doc;
                });
              });

              // Update Excalidraw to use a transparent background so our wrapper background shows through
              if (excalidrawAPI) {
                excalidrawAPI.updateScene({
                  appState: {
                    viewBackgroundColor: "transparent"
                  }
                });
              }
              
              showToast("Canvas background updated");
              return;
            }

            // 1. Direct API update (extremely fast and works for selected text elements and shapes)
            if (excalidrawAPI) {
              const elements = excalidrawAPI.getSceneElements();
              const appState = excalidrawAPI.getAppState();
              const selectedIds = appState.selectedElementIds || {};
              
              const updatedElements = elements.map(el => {
                if (selectedIds[el.id]) {
                  return {
                    ...el,
                    [isBackground ? "backgroundColor" : "strokeColor"]: displayColor,
                    version: el.version + 1,
                    updated: Date.now()
                  };
                }
                return el;
              });

              excalidrawAPI.updateScene({
                elements: updatedElements,
                appState: {
                  [isBackground ? "currentItemBackgroundColor" : "currentItemStrokeColor"]: displayColor
                }
              });
            }

            // 2. Fallback to DOM input in case the API is not synced
            const hexInput = popover.querySelector(".color-picker-input") || 
                             popover.querySelector("input[type='text']") ||
                             Array.from(popover.querySelectorAll("input")).find(
                               (input) => input.type === "text" || !["radio", "checkbox", "range", "button"].includes(input.type)
                             );
            if (hexInput) {
              const expectsHash = hexInput.value ? hexInput.value.startsWith("#") : true;
              const hasHash = displayColor.startsWith("#");
              let hexValue = displayColor;
              if (expectsHash && !hasHash) {
                hexValue = `#${displayColor}`;
              } else if (!expectsHash && hasHash) {
                hexValue = displayColor.slice(1);
              }

              // Focus the input first to let Excalidraw know we are editing
              hexInput.focus();

              // Bypass React's internal value tracker to successfully trigger onChange / state update
              const nativeValueSetter = Object.getOwnPropertyDescriptor(
                HTMLInputElement.prototype,
                "value"
              ).set;
              nativeValueSetter.call(hexInput, hexValue);

              hexInput.dispatchEvent(new Event("input", { bubbles: true }));
              hexInput.dispatchEvent(new Event("change", { bubbles: true }));

              // Dispatch keyup event to trigger any internal keystroke-based update listeners
              hexInput.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));
            }
          };

          newSwatch.addEventListener("click", handleSwatchClick, true);
          
          // Append to grid container
          gridContainer.appendChild(newSwatch);
        });
      });
    };

    // Run immediately for currently open menus
    injectCustomColors();

    // Throttle via requestAnimationFrame: the shared MutationObserver fires on every DOM
    // subtree change. Wrapping ensures at most one injection sweep per animation frame,
    // eliminating redundant querySelectorAll traversals during active canvas drawing.
    let rafId = null;
    const throttledInject = () => {
      if (rafId !== null) return; // already scheduled — skip
      rafId = requestAnimationFrame(() => {
        rafId = null;
        injectCustomColors();
      });
    };

    // Register with shared observer instead of creating a new body+subtree observer
    sharedObserverCallbacks.current.add(throttledInject);
    return () => {
      sharedObserverCallbacks.current.delete(throttledInject);
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
    };
  }, [loading, predefinedColors, excalidrawAPI]);

  // Recalculate text dimensions once fonts are loaded
  useEffect(() => {
    if (!excalidrawAPI || loading) return;

    let isCurrent = true;

    const refreshTextDimensions = () => {
      const elements = excalidrawAPI.getSceneElements();
      let hasUpdates = false;
      const updatedElements = elements.map(el => {
        if (el.type === "text") {
          let fontName = "Nunito";
          if (el.fontFamily === 1 || el.fontFamily === 5) {
            fontName = "Excalifont";
          } else if (el.fontFamily === 3) {
            fontName = "Comic Shanns";
          } else if (el.fontFamily === 4) {
            fontName = "Lilita One";
          }
          const { width, height } = measureTextDimensions(
            el.text,
            el.fontSize,
            fontName,
            el.lineHeight ? Number(el.lineHeight) : 1.25
          );
          if (Math.abs(el.width - width) > 1 || Math.abs(el.height - height) > 1) {
            hasUpdates = true;
            return {
              ...el,
              width,
              height,
              version: el.version + 1,
              versionNonce: Math.floor(Math.random() * 100000),
              updated: Date.now()
            };
          }
        }
        return el;
      });

      if (hasUpdates && isCurrent) {
        excalidrawAPI.updateScene({ elements: updatedElements });
      }
    };

    // Run after document fonts are fully loaded
    document.fonts.ready.then(() => {
      if (isCurrent) {
        refreshTextDimensions();
      }
    });

    // Run a fallback delay in case fonts take time to download/initialize
    const timeoutId = setTimeout(() => {
      if (isCurrent) {
        refreshTextDimensions();
      }
    }, 150);

    return () => {
      isCurrent = false;
      clearTimeout(timeoutId);
    };
  }, [excalidrawAPI, loading]);

  // Intercept Excalidraw's built-in font menu to customize labels and styles
  useEffect(() => {
    if (loading) return;

    let isRunning = false;

    const interceptFontMenu = () => {
      if (isRunning) return;
      isRunning = true;

      try {
        const dropdown = document.querySelector(".dropdown-menu.fonts");
        if (!dropdown) return;

        const listWrapper = dropdown.querySelector(".ScrollableList__wrapper") || dropdown.querySelector(".dropdown-menu-container") || dropdown;
        if (!listWrapper) return;

        // Hide group headers (like "In this scene" or "Available fonts") if they are present
        const groupHeaders = listWrapper.querySelectorAll(".dropdown-menu-group-title, .dropdown-menu-item-group-title, h3, h4, span[class*='heading']");
        groupHeaders.forEach(header => {
          header.style.setProperty("display", "none", "important");
        });

        const buttons = Array.from(listWrapper.querySelectorAll(".dropdown-menu-item, button"));
        buttons.forEach(btn => {
          const textEl = btn.querySelector(".dropdown-menu-item__text") || btn;
          const text = textEl.textContent.trim();
          const cleanText = text.replace(/['"]/g, "").toLowerCase();

          if (cleanText.includes("lilita") || cleanText.includes("heading")) {
            // Hide the Heading font slot entirely so we only show Option B fonts
            btn.style.setProperty("display", "none", "important");
          } else if (cleanText.includes("nunito") || cleanText.includes("normal") || cleanText.includes("inter")) {
            if (textEl.textContent !== "Inter (Normal)") {
              textEl.textContent = "Inter (Normal)";
            }
            btn.style.fontFamily = '"Inter", sans-serif';
            btn.style.display = ""; // Ensure visible
          } else if (cleanText.includes("comic") || cleanText.includes("shanns") || cleanText.includes("fira") || cleanText.includes("monospace") || cleanText.includes("code")) {
            if (textEl.textContent !== "Fira Code (Monospace)") {
              textEl.textContent = "Fira Code (Monospace)";
            }
            btn.style.fontFamily = '"Fira Code", monospace';
            btn.style.display = ""; // Ensure visible
          } else if (cleanText.includes("hand-drawn") || cleanText.includes("excalifont") || cleanText.includes("caveat")) {
            if (textEl.textContent !== "Caveat (Hand-drawn)") {
              textEl.textContent = "Caveat (Hand-drawn)";
            }
            btn.style.fontFamily = '"Caveat", sans-serif';
            btn.style.fontSize = "1.1rem";
            btn.style.display = ""; // Ensure visible
          }
        });
      } finally {
        isRunning = false;
      }
    };

    interceptFontMenu();

    sharedObserverCallbacks.current.add(interceptFontMenu);

    return () => {
      sharedObserverCallbacks.current.delete(interceptFontMenu);
    };
  }, [loading]);

  // Inject custom shortcuts list into Excalidraw's built-in Help dialog modal
  useEffect(() => {
    if (loading) return;

    const injectCustomShortcuts = () => {
      // Find Excalidraw Help dialog (may be rendered via React Portals directly under document.body)
      const helpDialog = document.querySelector(".HelpDialog, [class*='HelpDialog'], .help-dialog, [role='dialog']");
      if (!helpDialog) return;

      // Check if we already injected our custom section
      if (helpDialog.querySelector(".shivadraw-custom-shortcuts-section")) return;

      // Find the active tab panel or inner dialog contents (never fall back to outer overlay wrapper to prevent clicking bugs)
      const contentContainer = helpDialog.querySelector("[role='tabpanel']") || 
                               helpDialog.querySelector(".HelpDialog__content, [class*='HelpDialog__content'], .HelpDialog-content") ||
                               helpDialog.querySelector(".Dialog__content, [class*='Dialog__content'], .Dialog-content");
      
      if (!contentContainer) return;

      // Find the tools column in the help dialog
      const toolsColumn = contentContainer.querySelector(".HelpDialog__island--tools, [class*='HelpDialog__island--tools']");
      
      // CRITICAL: If the tools column is not rendered yet, return and wait for the next mutation tick!
      if (!toolsColumn) return;

      const toolsContent = toolsColumn.querySelector(".HelpDialog__island-content, [class*='HelpDialog__island-content']");
      if (!toolsContent) return;

      // Create our custom section
      const customSection = document.createElement("div");
      customSection.classList.add("shivadraw-custom-shortcuts-section");
      customSection.style.display = "flex";
      customSection.style.flexDirection = "column";
      customSection.style.gap = "0.25rem";
      customSection.style.marginBottom = "1.5rem";
      customSection.style.width = "100%";
      
      // Create a section title
      const title = document.createElement("h5");
      title.innerText = "Shiva Canvas Custom Shortcuts";
      title.style.marginTop = "0.5rem";
      title.style.marginBottom = "0.75rem";
      title.style.borderBottom = "1px solid var(--border-color, #e2e8f0)";
      title.style.paddingBottom = "0.25rem";
      title.style.fontSize = "0.95rem";
      title.style.fontWeight = "700";
      title.style.color = "#8b5cf6"; // Distinct violet color for custom section
      customSection.appendChild(title);

      // Custom shortcuts data including bracket shortcuts
      const shortcuts = [
        { desc: "Toggle Left Panel", keys: ["Ctrl + \\"] },
        { desc: "Toggle Element Properties Panel", keys: ["Alt + S"] },
        { desc: "Increase Brush/Stroke Size", keys: ["]"] },
        { desc: "Decrease Brush/Stroke Size", keys: ["["] },
        { desc: "Circle/Ellipse Tool", keys: ["C"] },
        { desc: "Line Tool", keys: ["D"] },
        { desc: "Draw (Freehand) Tool", keys: ["X"] },
        { desc: "Diamond Tool", keys: ["L"] },
        { desc: "Delete Selected", keys: ["Z"] }
      ];

      // Clone one of the existing rows for matching styles if possible
      const existingRow = toolsContent.querySelector(".HelpDialog__shortcut, [class*='HelpDialog__shortcut']") || toolsContent.querySelector("tr, li");

      shortcuts.forEach(shortcut => {
        const row = document.createElement("div");
        if (existingRow) {
          row.className = existingRow.className;
        } else {
          row.className = "HelpDialog__shortcut";
        }
        
        // Ensure proper flex layout for each row regardless of cloned styles
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.paddingTop = "0.35rem";
        row.style.paddingBottom = "0.35rem";
        row.style.borderBottom = "1px solid var(--border-color, rgba(0,0,0,0.05))";
        row.style.fontSize = "0.85rem";
        row.style.width = "100%";

        const descSpan = document.createElement("span");
        descSpan.innerText = shortcut.desc;
        descSpan.style.color = "var(--text-secondary)";
        row.appendChild(descSpan);

        const keysWrapper = document.createElement("div");
        keysWrapper.style.display = "flex";
        keysWrapper.style.gap = "0.25rem";
        keysWrapper.style.alignItems = "center";

        shortcut.keys.forEach((key, kIdx) => {
          if (kIdx > 0) {
            const orSpan = document.createElement("span");
            orSpan.innerText = "or";
            orSpan.style.fontSize = "0.7rem";
            orSpan.style.color = "var(--text-muted)";
            keysWrapper.appendChild(orSpan);
          }
          const kbd = document.createElement("kbd");
          kbd.innerText = key;
          kbd.style.padding = "0.15rem 0.35rem";
          kbd.style.fontSize = "0.75rem";
          kbd.style.fontWeight = "bold";
          kbd.style.borderRadius = "4px";
          kbd.style.background = "rgba(139, 92, 246, 0.08)";
          kbd.style.border = "1px solid #8b5cf6";
          kbd.style.color = "#8b5cf6";
          kbd.style.boxShadow = "var(--shadow-sm)";
          keysWrapper.appendChild(kbd);
        });

        row.appendChild(keysWrapper);
        customSection.appendChild(row);
      });

      // Insert our custom section at the very beginning of the tools list
      toolsContent.insertBefore(customSection, toolsContent.firstChild);
    };

    // Register with shared observer instead of creating a new body+subtree observer
    sharedObserverCallbacks.current.add(injectCustomShortcuts);
    return () => {
      sharedObserverCallbacks.current.delete(injectCustomShortcuts);
    };
  }, [loading]);

  // Update canvas scene when active document changes
  useEffect(() => {
    if (!excalidrawAPI || !activeDocId || loading) return;

    const activeDoc = latestDocumentsRef.current.find((d) => d.id === activeDocId);
    if (activeDoc) {
      // Setup file handle and auto-save state (runs on both initial mount and document switch)
      const handle = fileHandlesRef.current[activeDocId] || activeDoc.fileHandle;
      if (handle) {
        fileHandlesRef.current[activeDocId] = handle;
        setAutoSaveFileName(handle.name);
        
        const wasAutoSaveEnabled = !!activeDoc.autoSaveEnabled;
        checkFilePermission(handle).then((permStatus) => {
          if (wasAutoSaveEnabled && permStatus === "granted") {
            setAutoSaveEnabled(true);
            autoSaveEnabledRef.current = true;
          } else {
            setAutoSaveEnabled(false);
            autoSaveEnabledRef.current = false;
          }
        });
      } else {
        setAutoSaveFileName("");
        setAutoSaveEnabled(false);
        autoSaveEnabledRef.current = false;
        setFilePermissionState("granted"); // default back to granted
      }

      // If it's the initial mount, skip updating the canvas scene (handled by initialData prop)
      if (isInitialMountRef.current) {
        isInitialMountRef.current = false;
        // Still set isSwitchingRef to false after a delay so onChange can save
        setTimeout(() => {
          isSwitchingRef.current = false;
        }, 150);
        return;
      }

      isSwitchingRef.current = true;
      
      // Load files into Excalidraw scene
      if (activeDoc.files && Object.keys(activeDoc.files).length > 0) {
        try {
          const filesArray = Object.values(activeDoc.files);
          excalidrawAPI.addFiles(filesArray);
        } catch (e) {
          console.error("Error adding files to canvas:", e);
        }
      }

      // Determine if this doc has a custom/preset background so we can force transparency
      const hasCustomBg = activeDoc.backgroundStyle && activeDoc.backgroundStyle !== "pure-white";
      excalidrawAPI.updateScene({
        elements: activeDoc.elements || [],
        appState: {
          currentItemStrokeWidth: 1,
          currentItemRoughness: 0,
          currentItemRoundness: "sharp",
          currentItemFontFamily: 2, // Default to Inter (Normal)
          ...(activeDoc.appState || {}),
          // Always override: if doc has a preset/custom bg, keep canvas transparent so our CSS shows through
          viewBackgroundColor: hasCustomBg ? "transparent" : (activeDoc.appState?.viewBackgroundColor || "transparent"),
        }
      });
      // Reset ref memory to current loaded scene
      latestDataRef.current = { 
        elements: activeDoc.elements || [],
        appState: activeDoc.appState || {},
        files: activeDoc.files || {}
      };

      // Delay disabling the switching flag to absorb the subsequent onChange triggers
      setTimeout(() => {
        isSwitchingRef.current = false;
      }, 150);
    }
  }, [activeDocId, excalidrawAPI, loading]);

  // Inject logo inside Excalidraw toolbar dynamically and observe internally
  useEffect(() => {
    const injectLogo = () => {
      const toolbar = document.querySelector(".excalidraw .App-toolbar");
      if (toolbar && !toolbar.querySelector(".toolbar-logo-injected")) {
        const logoWrapper = document.createElement("div");
        logoWrapper.className = "toolbar-logo-injected";
        logoWrapper.innerHTML = `
          <span class="toolbar-logo-text">S H I V A</span>
          <div class="toolbar-logo-separator"></div>
        `;
        toolbar.insertBefore(logoWrapper, toolbar.firstChild);
      }
    };

    injectLogo();

    // Register with shared observer instead of creating a new body+subtree observer
    sharedObserverCallbacks.current.add(injectLogo);
    return () => {
      sharedObserverCallbacks.current.delete(injectLogo);
    };
  }, []);

  // Global keyboard shortcut to map 'z' to 'Delete' key for selected items
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Toggle sidebar shortcut: Ctrl + \ (or Cmd + \)
      if ((e.ctrlKey || e.metaKey) && e.key === "\\") {
        e.preventDefault();
        e.stopPropagation();
        setSidebarOpen(prev => !prev);
        return;
      }

      // Intercept Ctrl+S (Save) or Cmd+S to write directly to the linked disk file or prompt once
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !e.altKey) {
        e.preventDefault();
        e.stopPropagation();
        saveNowToDisk();
        return;
      }

      // Intercept Ctrl+O (Open) or Cmd+O to open Shiva Canvas .shiva/.json file dialog
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "o") {
        e.preventDefault();
        e.stopPropagation();
        openFileFromDisk();
        return;
      }

      // Toggle element properties panel shortcut: Alt + S
      if (e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        setPropertiesPanelVisible(prev => {
          const next = !prev;
          showToast(next ? "Properties panel shown" : "Properties panel hidden", "info");
          return next;
        });
        return;
      }

      // Don't intercept if ctrl/cmd/alt are pressed (e.g. Ctrl+Z/Cmd+Z for undo)
      if (e.ctrlKey || e.altKey || e.metaKey) return;

      // Ignore if user is typing inside any inputs, textareas, or Excalidraw text editor
      if (
        document.activeElement &&
        (document.activeElement.tagName === "INPUT" ||
         document.activeElement.tagName === "TEXTAREA" ||
         document.activeElement.contentEditable === "true" ||
         document.activeElement.closest(".excalidraw__text-editor") ||
         document.activeElement.classList.contains("excalidraw__text-editor") ||
         document.activeElement.tagName === "STYLE" ||
         document.activeElement.tagName === "SCRIPT")
      ) {
        return;
      }

      // Ignore if Excalidraw's floating color picker popover is open (identified by having color swatch buttons with single letter hotkeys)
      const isColorPickerOpen = Array.from(document.querySelectorAll(".excalidraw .color-picker, .excalidraw .popover, [class*='color-picker']"))
        .some(popover => Array.from(popover.querySelectorAll("button")).some(btn => btn.innerText.trim().length === 1));
      if (isColorPickerOpen) {
        return;
      }

      // Activate circle/ellipse tool on 'c' keypress
      if (e.key.toLowerCase() === "c") {
        if (excalidrawAPI) {
          e.preventDefault();
          e.stopPropagation();
          excalidrawAPI.setActiveTool({ type: "ellipse" });
        }
      }



      // Activate line tool on 'd' keypress
      if (e.key.toLowerCase() === "d") {
        if (excalidrawAPI) {
          e.preventDefault();
          e.stopPropagation();
          excalidrawAPI.setActiveTool({ type: "line" });
        }
      }

      // Activate freehand draw/pen tool on 'x' keypress
      if (e.key.toLowerCase() === "x") {
        if (excalidrawAPI) {
          e.preventDefault();
          e.stopPropagation();
          excalidrawAPI.setActiveTool({ type: "freedraw" });
        }
      }

      // Activate diamond tool on 'l' keypress
      if (e.key.toLowerCase() === "l") {
        if (excalidrawAPI) {
          e.preventDefault();
          e.stopPropagation();
          excalidrawAPI.setActiveTool({ type: "diamond" });
        }
      }

      if (e.key.toLowerCase() === "z") {
        e.preventDefault();
        e.stopPropagation();

        // Simulate a "Delete" keydown event
        const deleteEvent = new KeyboardEvent("keydown", {
          key: "Delete",
          code: "Delete",
          keyCode: 46,
          which: 46,
          bubbles: true,
          cancelable: true,
        });

        // Dispatch the event to the active excalidraw canvas container
        const canvasContainer = document.querySelector(".excalidraw-container");
        if (canvasContainer) {
          canvasContainer.dispatchEvent(deleteEvent);
        } else {
          document.body.dispatchEvent(deleteEvent);
        }
      }

      // Bracket keys: change stroke width of selected elements and current tool
      if (e.key === "[" || e.key === "]") {
        if (excalidrawAPI) {
          e.preventDefault();
          e.stopPropagation();

          const currentAppState = excalidrawAPI.getAppState();
          const deltaSign = e.key === "]" ? 1 : -1;
          const currentElements = excalidrawAPI.getSceneElements();
          const selectedIds = currentAppState.selectedElementIds || {};
          const selectedIdsArray = Object.keys(selectedIds).filter(id => selectedIds[id]);

          // Helper to adjust stroke width (pixel-by-pixel above 1, 0.1 steps below 1, minimum 0.01)
          const adjustWidth = (currentWidth, sign) => {
            const numWidth = Number(currentWidth) || 1;
            let nextWidth;
            if (sign > 0) { // Increase
              if (numWidth < 1) {
                nextWidth = Math.min(1, parseFloat((numWidth + 0.1).toFixed(2)));
              } else {
                nextWidth = Math.floor(numWidth) + 1;
              }
            } else { // Decrease
              if (numWidth <= 1.01) {
                nextWidth = Math.max(0.01, parseFloat((numWidth - 0.1).toFixed(2)));
              } else {
                nextWidth = Math.ceil(numWidth) - 1;
              }
            }
            return nextWidth;
          };

          if (selectedIdsArray.length > 0) {
            // Update selected elements' strokeWidth
            const updatedElements = currentElements.map(el => {
              if (selectedIds[el.id]) {
                const newWidth = adjustWidth(el.strokeWidth || 1, deltaSign);
                return {
                  ...el,
                  strokeWidth: newWidth,
                  version: el.version + 1,
                  versionNonce: Math.floor(Math.random() * 100000),
                  updated: Date.now()
                };
              }
              return el;
            });
            excalidrawAPI.updateScene({ elements: updatedElements });
            const sampleEl = currentElements.find(el => selectedIds[el.id]);
            const finalWidth = adjustWidth(sampleEl?.strokeWidth || 1, deltaSign);
            showToast(`Selected elements stroke width: ${finalWidth}px`);
          } else {
            // Update current/next tool strokeWidth
            const currentWidth = currentAppState.currentItemStrokeWidth || 1;
            const newWidth = adjustWidth(currentWidth, deltaSign);
            excalidrawAPI.updateScene({
              appState: {
                currentItemStrokeWidth: newWidth
              }
            });
            showToast(`Brush/Tool stroke width: ${newWidth}px`);
          }
          // Update the label in the DOM immediately
          setTimeout(updateStrokeWidthLabel, 0);
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown, true); // Use capture phase to intercept early
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
    };
    // Note: documents and activeDocId are intentionally NOT in deps here.
    // We read them via activeDocIdRef / latestDocumentsRef (always current) to avoid
    // re-registering the listener on every canvas change (which updates documents state).
  }, [excalidrawAPI]);

  const showToast = useCallback((message, type = "success") => {
    setNotification({ message, type });
  }, []);

  // Auto-dismiss notifications
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => {
        setNotification(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // Update document title bar (PWA title) to reflect linked file name
  useEffect(() => {
    if (autoSaveFileName) {
      const cleanName = autoSaveFileName.replace(/\.shiva$/, "");
      document.title = cleanName;
    } else {
      document.title = "Shiva Canvas";
    }
  }, [autoSaveFileName]);

  // Toggle application themes
  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    localStorage.setItem("shivadraw_theme", nextTheme);
    document.documentElement.className = nextTheme === "dark" ? "theme-dark" : "theme-light";
    

    
    if (excalidrawAPI) {
      excalidrawAPI.updateScene({
        appState: {
          viewBackgroundColor: "transparent",
        }
      });
    }
    showToast(`Switched to ${nextTheme} theme`);
  };

  // Create a new board
  const createNewBoard = (title = "Untitled Board", elements = [], appState = {}, files = {}) => {
    const clonedElements = cloneElements(elements);
    const mergedAppState = {
      currentItemStrokeWidth: 1,
      currentItemRoughness: 0,
      currentItemRoundness: "sharp",
      currentItemFontFamily: 2, // Default to Inter (Normal)
      ...appState
    };
    const newDoc = {
      id: `doc-${Date.now()}`,
      title,
      updatedAt: Date.now(),
      elements: clonedElements,
      appState: mergedAppState,
      files,
      backgroundStyle: "pure-white" // Default to Pure White background
    };

    const updated = [newDoc, ...documents];
    setDocuments(updated);
    setActiveDocId(newDoc.id);
    showToast(`"${title}" created`);
  };

  // Duplicate an existing board
  const duplicateBoard = (doc, e) => {
    e.stopPropagation();
    const clonedElements = cloneElements(doc.elements || []);
    const newDoc = {
      id: `doc-${Date.now()}`,
      title: `${doc.title} (Copy)`,
      updatedAt: Date.now(),
      elements: clonedElements,
      appState: { ...doc.appState },
      files: { ...doc.files }
    };

    const updated = [newDoc, ...documents];
    setDocuments(updated);
    setActiveDocId(newDoc.id);
    showToast(`"${doc.title}" duplicated`);
  };

  // Delete a board
  const deleteBoard = (id, e) => {
    e.stopPropagation();
    const docToDelete = documents.find(d => d.id === id);
    if (!docToDelete) return;

    if (confirm(`Are you sure you want to delete "${docToDelete.title}"?`)) {
      const filtered = documents.filter(d => d.id !== id);
      setDocuments(filtered);

      if (activeDocId === id) {
        if (filtered.length > 0) {
          setActiveDocId(filtered[0].id);
        } else {
          // If no documents left, seed an empty board
          const fallbackDoc = {
            id: `doc-${Date.now()}`,
            title: "New Canvas 🎨",
            updatedAt: Date.now(),
            elements: [],
            appState: {
              currentItemStrokeWidth: 1,
              currentItemRoughness: 0,
              currentItemRoundness: "sharp"
            }
          };
          setDocuments([fallbackDoc]);
          setActiveDocId(fallbackDoc.id);
        }
      }
      showToast("Board deleted", "error");
    }
  };



  // Change workspace background style
  const handleBackgroundChange = (newBgStyle) => {
    if (!activeDocId) return;
    
    const updated = documents.map(doc => {
      if (doc.id === activeDocId) {
        return { ...doc, backgroundStyle: newBgStyle, updatedAt: Date.now() };
      }
      return doc;
    });
    setDocuments(updated);
    
    // Force Excalidraw canvas transparency redraw
    if (excalidrawAPI) {
      excalidrawAPI.updateScene({
        appState: {
          viewBackgroundColor: "transparent"
        }
      });
    }

    setItem("shivadraw_docs", updated).catch(err => {
      console.error("Failed to save background style to IndexedDB:", err);
    });
    
    showToast("Workspace background updated");
  };

  // Rename a board
  const renameBoard = (id, newTitle) => {
    setEditingDocId(null);
    if (!newTitle.trim()) return;

    const updated = documents.map(doc => {
      if (doc.id === id) {
        return { ...doc, title: newTitle.trim(), updatedAt: Date.now() };
      }
      return doc;
    });

    setDocuments(updated);
    showToast("Board renamed");
  };

  // Reset the active board (clear elements)
  const resetBoard = () => {
    if (confirm("Reset current board? All drawings will be cleared.")) {
      if (excalidrawAPI) {
        excalidrawAPI.updateScene({ elements: [] });
      }
      latestDataRef.current = { elements: [], files: {} };
      
      const updated = documents.map(doc => {
        if (doc.id === activeDocId) {
          return { ...doc, elements: [], files: {}, updatedAt: Date.now() };
        }
        return doc;
      });
      setDocuments(updated);
      showToast("Canvas cleared", "error");
    }
  };

  // Handle drawing mutations in Excalidraw
  const handleCanvasChange = useCallback((elements, appState, files) => {
    // If switching documents or Excalidraw is loading, skip saving to prevent overwrites
    if (isSwitchingRef.current) return;

    // Guard: only trigger a React re-render when status actually changes (avoids 60fps re-renders)
    if (saveStatusRef.current !== "saving") {
      saveStatusRef.current = "saving";
      setSaveStatus("saving");
    }

    // Filter out deleted elements to save memory
    const activeElements = elements.filter(el => !el.isDeleted);
    latestDataRef.current = { elements: activeElements, appState: sanitizeAppState(appState), files };

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      const currentActiveId = activeDocIdRef.current;
      if (!currentActiveId) {
        saveStatusRef.current = "saved";
        setSaveStatus("saved");
        return;
      }

      // Snapshot active files BEFORE entering the setDocuments updater.
      // React may call updater functions more than once in Concurrent Mode;
      // calling the Excalidraw API inside an updater is unsafe.
      const snapshotActiveFiles = (excalidrawAPI && excalidrawAPI.getFiles) ? excalidrawAPI.getFiles() : {};

      setDocuments(prevDocs => {
        const docIndex = prevDocs.findIndex(d => d.id === currentActiveId);
        if (docIndex === -1) {
          return prevDocs;
        }

        const updatedDocs = [...prevDocs];
        
        // Merge image files to prevent losing previously pasted files
        const existingFiles = updatedDocs[docIndex].files || {};
        const newFiles = latestDataRef.current.files || {};
        const mergedFiles = { ...existingFiles, ...newFiles };

        // Garbage collect orphaned files (files not referenced by active elements and not in active session memory)
        const referencedFileIds = new Set(
          latestDataRef.current.elements
            .filter(el => el.type === "image" && el.fileId)
            .map(el => el.fileId)
        );
        const activeFiles = snapshotActiveFiles;
        for (const fileId in activeFiles) {
          referencedFileIds.add(fileId);
        }

        const cleanedFiles = {};
        for (const fileId in mergedFiles) {
          if (referencedFileIds.has(fileId)) {
            cleanedFiles[fileId] = mergedFiles[fileId];
          }
        }

        updatedDocs[docIndex] = {
          ...updatedDocs[docIndex],
          elements: latestDataRef.current.elements,
          appState: latestDataRef.current.appState,
          files: cleanedFiles,
          updatedAt: Date.now()
        };

        saveStatusRef.current = "saved";
        setSaveStatus("saved");

        // Auto-save to disk if enabled and a file handle is set for the active doc
        const activeHandle = fileHandlesRef.current[currentActiveId];
        if (autoSaveEnabledRef.current && activeHandle) {
          const docData = updatedDocs[docIndex];
          
          // SAFETY GUARD: Do not auto-save if elements are empty, to prevent overwriting with blank canvas during/after crash
          if (!docData.elements || docData.elements.length === 0) {
            console.log("Auto-save skipped: Canvas is empty.");
            return updatedDocs;
          }

          if (autoSaveTimeoutRef.current) clearTimeout(autoSaveTimeoutRef.current);
          
          const timeSinceLastSave = Date.now() - lastDiskSaveTimeRef.current;
          const saveDelay = Math.max(500, 30000 - timeSinceLastSave); // 30 seconds throttle

          autoSaveTimeoutRef.current = setTimeout(async () => {
            try {
              // Verify permission before attempting write (non-interactive check)
              const currentPerm = await activeHandle.queryPermission({ mode: "readwrite" });
              if (currentPerm !== "granted") {
                console.warn("Auto-save skipped: File write permission not granted.");
                setFilePermissionState(currentPerm);
                setAutoSaveDiskStatus("error");
                return;
              }

              setAutoSaveDiskStatus("saving");
              const dataStr = JSON.stringify({
                version: 1,
                title: docData.title,
                elements: docData.elements,
                appState: docData.appState || {},
                files: docData.files || {}
              }, null, 2);
              const writable = await activeHandle.createWritable();
              await writable.write(dataStr);
              await writable.close();
              lastDiskSaveTimeRef.current = Date.now();
              setAutoSaveDiskStatus("saved");
              // Reset to idle after 2s
              setTimeout(() => setAutoSaveDiskStatus("idle"), 2000);
            } catch (err) {
              console.error("Auto-save to disk failed:", err);
              setAutoSaveDiskStatus("error");
              setTimeout(() => setAutoSaveDiskStatus("idle"), 3000);
            }
          }, saveDelay);
        }

        return updatedDocs;
      });
    }, 500); // 500ms debounce — more frequent saves to survive unexpected shutdowns
  }, [excalidrawAPI]);

  // Handle smoothing on pointer up (when drawing ends)
  const handlePointerUp = useCallback((activeTool) => {
    if (activeTool && activeTool.type === "freedraw" && brushSmoothing > 0) {
      setTimeout(() => {
        if (!excalidrawAPI) return;
        const elements = excalidrawAPI.getSceneElements();
        
        // Find the last freedraw element that has not been smoothed yet
        const lastFreedrawIndex = [...elements].reverse().findIndex(
          el => el.type === "freedraw" && (!el.customData || !el.customData.isSmoothed)
        );
        
        if (lastFreedrawIndex !== -1) {
          const originalIndex = elements.length - 1 - lastFreedrawIndex;
          const element = elements[originalIndex];
          
          if (element.points && element.points.length > 2) {
            // Convert points to absolute coordinates
            const absolutePoints = element.points.map(([px, py]) => [element.x + px, element.y + py]);
            
            // Smooth points using the weighted moving average algorithm
            const smoothedAbsolutePoints = smoothPoints(absolutePoints, brushSmoothing);
            
            // Recalculate bounding box
            let minX = Infinity;
            let minY = Infinity;
            let maxX = -Infinity;
            let maxY = -Infinity;
            for (const [px, py] of smoothedAbsolutePoints) {
              if (px < minX) minX = px;
              if (py < minY) minY = py;
              if (px > maxX) maxX = px;
              if (py > maxY) maxY = py;
            }
            
            // Recalculate relative points
            const smoothedRelativePoints = smoothedAbsolutePoints.map(([px, py]) => [px - minX, py - minY]);
            
            // Create a new updated element copy
            const updatedElement = {
              ...element,
              x: minX,
              y: minY,
              width: maxX - minX,
              height: maxY - minY,
              points: smoothedRelativePoints,
              version: element.version + 1,
              versionNonce: Math.floor(Math.random() * 100000),
              customData: {
                ...(element.customData || {}),
                isSmoothed: true
              }
            };
            
            // Replace the old element with the updated one
            const nextElements = [...elements];
            nextElements[originalIndex] = updatedElement;
            
            // Update the scene with the smoothed elements
            excalidrawAPI.updateScene({
              elements: nextElements
            });
          }
        }
      }, 50);
    }
  }, [excalidrawAPI, brushSmoothing]);




  // Export canvas drawing to PNG or SVG image file
  const exportAsImage = async (type = "png") => {
    if (!excalidrawAPI) {
      showToast("Canvas API not ready yet", "error");
      return;
    }
    
    const elements = excalidrawAPI.getSceneElements();
    const activeElements = elements.filter(el => !el.isDeleted);
    
    if (activeElements.length === 0) {
      showToast("Canvas is empty. Add elements to export.", "error");
      return;
    }
    
    const appState = excalidrawAPI.getAppState();
    
    try {
      const activeDoc = documents.find(d => d.id === activeDocId);
      const filename = `${(activeDoc?.title || "drawing").replace(/\s+/g, "_")}`;

      if (type === "png") {
        const blob = await exportToBlob({
          elements: activeElements,
          mimeType: "image/png",
          appState: {
            ...appState,
            exportBackground: true,
          },
          files: excalidrawAPI.getFiles() || {}
        });
        
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${filename}.png`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("Drawing exported as PNG");
      } else if (type === "svg") {
        const svg = await exportToSvg({
          elements: activeElements,
          appState: {
            ...appState,
            exportBackground: true,
          },
          files: excalidrawAPI.getFiles() || {}
        });
        
        // Inject font styles so fonts render correctly when SVG is viewed externally
        let defs = svg.querySelector("defs");
        if (!defs) {
          defs = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "defs");
          svg.insertBefore(defs, svg.firstChild);
        }
        const style = svg.ownerDocument.createElementNS("http://www.w3.org/2000/svg", "style");
        style.textContent = `
          @import url('https://fonts.googleapis.com/css2?family=Caveat:wght@400;700&family=Fira+Code:wght@400;700&family=Inter:wght@400;700&display=swap');
          
          @font-face {
            font-family: "Excalifont";
            src: local("Caveat"), local("Caveat Regular"), local("Caveat-Regular"), url("https://fonts.gstatic.com/s/caveat/v18/Wn15HCAcZNypGL4QLbtqzdZy.woff2") format("woff2");
          }
          @font-face {
            font-family: "Comic Shanns";
            src: local("Fira Code"), local("FiraCode-Regular"), local("Fira Code Regular"), url("https://fonts.gstatic.com/s/firacode/v22/u8ReQDpcRURCYcEpb2UPzRf6.woff2") format("woff2");
          }
          @font-face {
            font-family: "Helvetica";
            src: local("Inter"), local("Inter Regular"), local("Inter-Regular"), url("https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZJhjp-Ek-_eeAmJ.woff2") format("woff2");
          }
          @font-face {
            font-family: "Helvetica Neue";
            src: local("Inter"), local("Inter Regular"), local("Inter-Regular"), url("https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZJhjp-Ek-_eeAmJ.woff2") format("woff2");
          }
          @font-face {
            font-family: "Arial";
            src: local("Inter"), local("Inter Regular"), local("Inter-Regular"), url("https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZJhjp-Ek-_eeAmJ.woff2") format("woff2");
          }
          @font-face {
            font-family: "Nunito";
            src: local("Inter"), local("Inter Regular"), local("Inter-Regular"), url("https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZJhjp-Ek-_eeAmJ.woff2") format("woff2");
          }
          @font-face {
            font-family: "Lilita One";
            src: local("Inter"), local("Inter Regular"), local("Inter-Regular"), url("https://fonts.gstatic.com/s/inter/v13/UcCO3FwrK3iLTeHuS_fvQtMwCp50KnMw2boKoduKmMEVuLyfAZJhjp-Ek-_eeAmJ.woff2") format("woff2");
          }
        `;
        defs.appendChild(style);

        const svgString = new XMLSerializer().serializeToString(svg);
        const blob = new Blob([svgString], { type: "image/svg+xml" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${filename}.svg`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        showToast("Drawing exported as SVG");
      }
    } catch (err) {
      console.error("Image export error:", err);
      showToast("Failed to export image", "error");
    }
  };

  // ─── Build the shared print-window HTML ────────────────────────────────────
  // Uses exportToBlob (PNG) instead of exportToSvg so the printed output is
  // rendered by the same Excalidraw canvas engine — guaranteeing fonts, colors
  // and styling are pixel-perfect matches of the canvas view.
  const buildAndOpenPrintWindow = async (mode) => {
    if (!excalidrawAPI) {
      showToast("Canvas API not ready yet", "error");
      return;
    }
    const elements = excalidrawAPI.getSceneElements();
    const activeElements = elements.filter(el => !el.isDeleted);
    if (activeElements.length === 0) {
      showToast("Canvas is empty. Add elements to export.", "error");
      return;
    }
    const appState = excalidrawAPI.getAppState();
    try {
      showToast("Preparing PDF...");

      // Render at 2× for sharp print quality
      const SCALE = 2;
      const blob = await exportToBlob({
        elements: activeElements,
        appState: { ...appState, exportBackground: true, exportWithDarkMode: false },
        files: excalidrawAPI.getFiles() || {},
        getDimensions: (w, h) => ({ width: w * SCALE, height: h * SCALE, scale: SCALE })
      });

      // Convert blob to a data URL so it survives the window boundary
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });

      // We need natural pixel dimensions to calculate A4 pagination
      const naturalSize = await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
        img.src = dataUrl;
      });

      const docTitle = (activeDoc?.title || "drawing")
        .replace(/</g, "&lt;").replace(/>/g, "&gt;");

      const printWindow = window.open("", "_blank", "width=900,height=700");
      if (!printWindow) {
        showToast("Pop-up blocked. Please allow pop-ups for this site.", "error");
        return;
      }

      const commonStyles = `
        * { margin: 0; padding: 0; box-sizing: border-box; }
        .print-btn {
          position: fixed; top: 1.5rem; right: 1.5rem;
          background: linear-gradient(135deg,#6366f1,#ec4899);
          color: white; border: none; padding: 0.75rem 1.5rem;
          border-radius: 10px; font-size: 1rem; font-weight: 600;
          cursor: pointer; box-shadow: 0 4px 12px rgba(99,102,241,0.4);
          z-index: 999; font-family: sans-serif;
        }
        .print-btn:hover { opacity: 0.9; transform: translateY(-1px); }
        @media print { .print-btn { display: none !important; } }
      `;

      if (mode === "single") {
        // ── Single page: one PNG scaled to fit the page ───────────────────────
        const orientation = naturalSize.w >= naturalSize.h ? "landscape" : "portrait";
        printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${docTitle}</title>
  <style>
    ${commonStyles}
    html, body { width: 100%; height: 100%; }
    @page { size: ${orientation}; margin: 0.5cm; }
    body {
      display: flex; align-items: center; justify-content: center;
      background: white;
      print-color-adjust: exact; -webkit-print-color-adjust: exact;
    }
    .drawing-container { width: 100%; max-width: 100%; display: flex; align-items: center; justify-content: center; }
    .drawing-container img { max-width: 100%; max-height: 100vh; width: auto; height: auto; display: block; }
    .footer { position: fixed; bottom: 0.3cm; right: 0.5cm; font-size: 8pt; color: #94a3b8; font-family: sans-serif; }
    @media screen {
      body { background: #f1f5f9; padding: 2rem; }
      .drawing-container { background: white; border-radius: 12px; padding: 2rem; box-shadow: 0 4px 32px rgba(0,0,0,0.12); }
    }
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">🖨️ Save as PDF</button>
  <div class="drawing-container">
    <img src="${dataUrl}" alt="${docTitle}" />
  </div>
  <div class="footer">${docTitle} &mdash; Shiva Canvas</div>
  <script>
    window.onload = () => setTimeout(() => window.print(), 300);
  <\/script>
</body>
</html>`);

      } else {
        // ── A4 multi-page: clip the PNG across A4 portrait sheets ─────────────
        // A4 at 96 dpi: 794 × 1123 px (portrait)
        const A4_W = 794;
        const A4_H = 1123;
        const MARGIN = 40;
        const printW = A4_W - MARGIN * 2;
        const printH = A4_H - MARGIN * 2;

        // Scale the image so its width = printW
        const scale = printW / naturalSize.w;
        const scaledImgH = Math.round(naturalSize.h * scale);
        const pageCount = Math.ceil(scaledImgH / printH);

        printWindow.document.write(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <title>${docTitle}</title>
  <style>
    ${commonStyles}
    @page { size: A4 portrait; margin: 0; }
    body { background: #e2e8f0; }
    .page {
      width: ${A4_W}px;
      height: ${A4_H}px;
      overflow: hidden;
      position: relative;
      background: white;
      page-break-after: always;
      break-after: page;
    }
    .page:last-child { page-break-after: auto; break-after: auto; }
    .page-inner {
      position: absolute;
      top: ${MARGIN}px;
      left: ${MARGIN}px;
      width: ${printW}px;
      height: ${printH}px;
      overflow: hidden;
    }
    /* The same image is used on every page; each page offsets the img
       upward by (pageIndex × printH) to reveal its slice */
    .page-inner img {
      display: block;
      width: ${printW}px;
      height: ${scaledImgH}px;
      position: absolute;
      left: 0;
    }
    .page-label {
      position: absolute;
      bottom: 8px;
      right: 14px;
      font-size: 8pt;
      color: #94a3b8;
      font-family: sans-serif;
    }
    @media screen {
      body { padding: 2rem; display: flex; flex-direction: column; align-items: center; gap: 2rem; }
      .page { border-radius: 6px; box-shadow: 0 4px 24px rgba(0,0,0,0.15); }
    }
    @media print { body { background: white; padding: 0; gap: 0; } }
  </style>
</head>
<body>
  <button class="print-btn" onclick="window.print()">🖨️ Save as PDF</button>
  ${Array.from({ length: pageCount }, (_, i) => {
    const topOffset = -(i * printH);
    return `<div class="page">
    <div class="page-inner">
      <img src="${dataUrl}" alt="${docTitle}" style="top:${topOffset}px" />
    </div>
    <div class="page-label">${docTitle} &mdash; Page ${i + 1} / ${pageCount} &mdash; Shiva Canvas</div>
  </div>`;
  }).join("\n")}
  <script>
    window.onload = () => setTimeout(() => window.print(), 400);
  <\/script>
</body>
</html>`);
      }

      printWindow.document.close();
    } catch (err) {
      console.error("PDF export error:", err);
      showToast("Failed to prepare PDF", "error");
    }
  };


  // Export canvas drawing to PDF — opens mode picker dialog
  const exportAsPdf = () => {
    if (!excalidrawAPI) {
      showToast("Canvas API not ready yet", "error");
      return;
    }
    const elements = excalidrawAPI.getSceneElements();
    const activeElements = elements.filter(el => !el.isDeleted);
    if (activeElements.length === 0) {
      showToast("Canvas is empty. Add elements to export.", "error");
      return;
    }
    setPdfDialogOpen(true);
  };



  const copyToClipboard = async () => {
    if (!excalidrawAPI) {
      showToast("Canvas API not ready yet", "error");
      return;
    }
    
    if (!navigator.clipboard || !window.ClipboardItem) {
      showToast("Clipboard copy is only supported in secure contexts (HTTPS/localhost)", "error");
      return;
    }
    
    const elements = excalidrawAPI.getSceneElements();
    const activeElements = elements.filter(el => !el.isDeleted);
    
    if (activeElements.length === 0) {
      showToast("Canvas is empty. Add elements to copy.", "error");
      return;
    }
    
    const appState = excalidrawAPI.getAppState();
    
    try {
      showToast("Generating image...", "info");
      
      const blob = await exportToBlob({
        elements: activeElements,
        mimeType: "image/png",
        appState: {
          ...appState,
          exportBackground: true,
        },
        files: excalidrawAPI.getFiles() || {}
      });
      
      await navigator.clipboard.write([
        new ClipboardItem({
          [blob.type]: blob
        })
      ]);
      showToast("Copied PNG image to clipboard! 📋");
    } catch (err) {
      console.error("Clipboard copy error:", err);
      showToast("Failed to copy image to clipboard", "error");
    }
  };

  // Update the stroke width label inside Excalidraw's floating panel
  const updateStrokeWidthLabel = () => {
    if (!excalidrawAPI) return;
    
    // Fast path: check if Excalidraw's floating panel/color-picker/popover is actually open in the DOM.
    // If not open, return immediately. This prevents performance lagging during active drawing.
    const panel = document.querySelector(".excalidraw .color-picker, .excalidraw .popover, [class*='color-picker']");
    if (!panel) return;
    
    // Look for the elements that could be the stroke width label
    const labels = Array.from(document.querySelectorAll(".excalidraw legend, .excalidraw .color-picker-label, .excalidraw label, .excalidraw div, .excalidraw span"));
    const strokeWidthLabel = labels.find(el => {
      const text = el.textContent || "";
      return text.trim().toLowerCase().startsWith("stroke width");
    });

    if (strokeWidthLabel) {
      // Retrieve current stroke width from active selection or current brush
      let currentWidth = 1;
      try {
        const currentElements = excalidrawAPI.getSceneElements();
        const appState = excalidrawAPI.getAppState();
        const selectedIds = appState.selectedElementIds || {};
        const selectedIdsArray = Object.keys(selectedIds).filter(id => selectedIds[id]);

        if (selectedIdsArray.length > 0) {
          const sampleEl = currentElements.find(el => selectedIds[el.id]);
          if (sampleEl && sampleEl.strokeWidth !== undefined) {
            currentWidth = sampleEl.strokeWidth;
          }
        } else {
          currentWidth = appState.currentItemStrokeWidth || 1;
        }
      } catch (err) {
        console.error("Error reading stroke width for label:", err);
      }

      // Append or update our custom value span in the label
      let valueSpan = strokeWidthLabel.querySelector(".shivadraw-stroke-width-value");
      if (!valueSpan) {
        valueSpan = document.createElement("span");
        valueSpan.className = "shivadraw-stroke-width-value";
        valueSpan.style.marginLeft = "0.4rem";
        valueSpan.style.fontSize = "0.75rem";
        valueSpan.style.color = "#8b5cf6"; // Violet color matching our custom theme
        valueSpan.style.fontWeight = "bold";
        strokeWidthLabel.appendChild(valueSpan);
      }
      valueSpan.textContent = `(${parseFloat(Number(currentWidth).toFixed(2))}px)`;
    }
  };

  // Trigger stroke width label sync on low-frequency window mouse release and click events.
  // This completely eliminates high-frequency DOM overhead during active canvas draws.
  useEffect(() => {
    if (loading || !excalidrawAPI) return;

    const handleWindowUpdate = () => {
      // Short delay to let Excalidraw finalize state/DOM renders
      setTimeout(updateStrokeWidthLabel, 50);
    };

    window.addEventListener("mouseup", handleWindowUpdate);
    window.addEventListener("click", handleWindowUpdate);
    return () => {
      window.removeEventListener("mouseup", handleWindowUpdate);
      window.removeEventListener("click", handleWindowUpdate);
    };
  }, [loading, excalidrawAPI]);

  // Export board to a local .shiva file (download)
  function exportBoard() {
    const activeDoc = documents.find(d => d.id === activeDocId);
    if (!activeDoc) return;

    const dataStr = JSON.stringify({
      version: 1,
      title: activeDoc.title,
      elements: activeDoc.elements,
      appState: activeDoc.appState || {},
      files: activeDoc.files || {}
    }, null, 2);

    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const day = String(now.getDate()).padStart(2, '0');
    const hours = String(now.getHours()).padStart(2, '0');
    const minutes = String(now.getMinutes()).padStart(2, '0');
    const dateString = `${year}-${month}-${day}-${hours}${minutes}`;

    const cleanTitle = activeDoc.title
      .replace(/[\uD800-\uDFFF]./g, "")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/\s+/g, "_");

    const exportFileDefaultName = `${cleanTitle}-${dateString}.shiva`;

    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    showToast("Drawing exported as .shiva file 💾");
  }

  // Query permission of a file handle
  const checkFilePermission = useCallback(async (handle) => {
    if (!handle) return "prompt";
    try {
      const status = await handle.queryPermission({ mode: "readwrite" });
      setFilePermissionState(status);
      return status;
    } catch (err) {
      console.error("Error querying file permission:", err);
      setFilePermissionState("prompt");
      return "prompt";
    }
  }, []);

  // Request permission of a file handle
  const requestFilePermission = useCallback(async (handle) => {
    if (!handle) return false;
    try {
      const status = await handle.requestPermission({ mode: "readwrite" });
      setFilePermissionState(status);
      if (status === "granted") {
        autoSaveEnabledRef.current = true;
        setAutoSaveEnabled(true);
        showToast("Connected to file successfully! 💾");
        // Save immediately to sync changes
        saveNowToDisk();
        return true;
      } else {
        showToast("Permission to write file denied", "error");
        return false;
      }
    } catch (err) {
      console.error("Error requesting file permission:", err);
      showToast("Failed to request file permission", "error");
      return false;
    }
  }, [showToast]);

  // ─── Auto-Save to Disk (File System Access API) ────────────────────────────

  // Pick a file location on disk and store the handle for subsequent auto-saves
  async function pickSaveFile(docTitle = "") {
    if (!window.showSaveFilePicker) {
      showToast("Auto-save to disk requires Chrome or Edge browser", "error");
      return null;
    }
    try {
      const now = new Date();
      const year = now.getFullYear();
      const month = String(now.getMonth() + 1).padStart(2, '0');
      const day = String(now.getDate()).padStart(2, '0');
      const hours = String(now.getHours()).padStart(2, '0');
      const minutes = String(now.getMinutes()).padStart(2, '0');
      const dateString = `${year}-${month}-${day}-${hours}${minutes}`;

      const cleanTitle = (docTitle || "drawing")
        .replace(/[\uD800-\uDFFF]./g, "")
        .replace(/[^\w\s-]/g, "")
        .trim()
        .replace(/\s+/g, "_");

      const suggestedName = `${cleanTitle}-${dateString}.shiva`;
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{
          description: "Shiva Canvas File",
          accept: { "application/json": [".shiva"] }
        }]
      });
      // Store in our board-specific map
      fileHandlesRef.current[activeDocIdRef.current] = handle;
      // Also update the document object to persist the handle in IndexedDB
      setDocuments(prevDocs => prevDocs.map(doc => {
        if (doc.id === activeDocIdRef.current) {
          return { ...doc, fileHandle: handle, autoSaveEnabled: true, updatedAt: Date.now() };
        }
        return doc;
      }));
      setAutoSaveFileName(handle.name);
      setFilePermissionState("granted");
      showToast(`Linked to disk file → ${handle.name} 💾`, "success");
      return handle;
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("File picker error:", err);
        showToast("Could not open file picker", "error");
      }
      return null;
    }
  }

  // Toggle auto-save: prompt for file location if turning on and no handle yet
  async function handleToggleAutoSave(checked) {
    autoSaveEnabledRef.current = checked;
    if (checked) {
      const activeDoc = documents.find(d => d.id === activeDocId);
      let currentHandle = fileHandlesRef.current[activeDocId] || activeDoc?.fileHandle;
      if (!currentHandle) {
        const handle = await pickSaveFile(activeDoc?.title || "drawing");
        if (!handle) {
          // User cancelled the picker — keep auto-save off
          autoSaveEnabledRef.current = false;
          setAutoSaveEnabled(false);
          return;
        }
      } else {
        fileHandlesRef.current[activeDocId] = currentHandle;
        // Verify permission (since this is triggered by user click, request permission)
        const permStatus = await currentHandle.queryPermission({ mode: "readwrite" });
        if (permStatus !== "granted") {
          const reqStatus = await currentHandle.requestPermission({ mode: "readwrite" });
          setFilePermissionState(reqStatus);
          if (reqStatus !== "granted") {
            autoSaveEnabledRef.current = false;
            setAutoSaveEnabled(false);
            showToast("Write permission required to enable Auto-save", "error");
            return;
          }
        } else {
          setFilePermissionState("granted");
        }

        // Persist autoSaveEnabled = true in the document object
        setDocuments(prevDocs => prevDocs.map(doc => {
          if (doc.id === activeDocIdRef.current) {
            return { ...doc, autoSaveEnabled: true, updatedAt: Date.now() };
          }
          return doc;
        }));

        showToast(`Auto-save ON → ${currentHandle.name} 💾`);
      }
      setAutoSaveEnabled(true);
    } else {
      // Persist autoSaveEnabled = false in the document object
      setDocuments(prevDocs => prevDocs.map(doc => {
        if (doc.id === activeDocIdRef.current) {
          return { ...doc, autoSaveEnabled: false, updatedAt: Date.now() };
        }
        return doc;
      }));
      setAutoSaveEnabled(false);
      setAutoSaveDiskStatus("idle");
      showToast("Auto-save to disk disabled", "info");
    }
  }

  // Manual "Save Now" to disk — always writes immediately
  async function saveNowToDisk() {
    const activeDoc = documents.find(d => d.id === activeDocId);
    if (!activeDoc) return;
    let handle = fileHandlesRef.current[activeDoc.id] || activeDoc.fileHandle;
    if (!handle) {
      handle = await pickSaveFile(activeDoc.title);
      if (!handle) return;
    }
    try {
      fileHandlesRef.current[activeDoc.id] = handle;
      // Verify and request permission (runs on user click)
      const currentPerm = await handle.queryPermission({ mode: "readwrite" });
      if (currentPerm !== "granted") {
        const reqPerm = await handle.requestPermission({ mode: "readwrite" });
        setFilePermissionState(reqPerm);
        if (reqPerm !== "granted") {
          showToast("Permission to write file denied", "error");
          return;
        }
      } else {
        setFilePermissionState("granted");
      }

      setAutoSaveDiskStatus("saving");
      const dataStr = JSON.stringify({
        version: 1,
        title: activeDoc.title,
        elements: activeDoc.elements,
        appState: activeDoc.appState || {},
        files: activeDoc.files || {}
      }, null, 2);
      const writable = await handle.createWritable();
      await writable.write(dataStr);
      await writable.close();
      lastDiskSaveTimeRef.current = Date.now();
      setAutoSaveDiskStatus("saved");
      
      // Update document object in state with fileHandle and autoSaveEnabled
      setDocuments(prevDocs => prevDocs.map(doc => {
        if (doc.id === activeDoc.id) {
          return { ...doc, fileHandle: handle, autoSaveEnabled: true, updatedAt: Date.now() };
        }
        return doc;
      }));
      
      // Automatically enable Auto-Save option on successful save
      autoSaveEnabledRef.current = true;
      setAutoSaveEnabled(true);

      showToast(`Saved & Auto-save enabled → ${handle.name} ✅`);
      setTimeout(() => setAutoSaveDiskStatus("idle"), 2000);
    } catch (err) {
      console.error("Save to disk failed:", err);
      setAutoSaveDiskStatus("error");
      showToast("Save to disk failed!", "error");
      setTimeout(() => setAutoSaveDiskStatus("idle"), 3000);
    }
  }

  // Backup all drawings to a single JSON file
  const backupAllDrawings = () => {
    if (documents.length === 0) {
      showToast("No drawings to backup", "error");
      return;
    }
    const backupData = {
      version: "shiva-canvas-backup-v1",
      timestamp: Date.now(),
      documents: documents
    };
    const dataStr = JSON.stringify(backupData, null, 2);
    const dataUri = 'data:application/json;charset=utf-8,' + encodeURIComponent(dataStr);
    const exportFileDefaultName = `shiva_canvas_backup_${new Date().toISOString().slice(0, 10)}.json`;

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    showToast("All drawings backed up successfully! 💾");
  };

  // Restore drawings from a backup JSON file
  const restoreBackup = (e) => {
    const file = e.target.files[0];
    if (!file) return;

    const fileReader = new FileReader();
    fileReader.onload = async (event) => {
      try {
        const backup = JSON.parse(event.target.result);
        if (backup && backup.version === "shiva-canvas-backup-v1" && Array.isArray(backup.documents)) {
          let restoredCount = 0;
          const existingIds = new Set(documents.map(d => d.id));
          const mergedDocs = [...documents];

          for (const doc of backup.documents) {
            if (!doc || typeof doc !== "object" || !doc.id || !doc.title) continue;

            if (!existingIds.has(doc.id)) {
              mergedDocs.push(doc);
              restoredCount++;
            } else {
              const newDoc = {
                ...doc,
                id: `doc-${Math.random().toString(36).substr(2, 9)}`,
                title: `${doc.title} (Restored)`,
                updatedAt: Date.now()
              };
              mergedDocs.push(newDoc);
              restoredCount++;
            }
          }

          if (restoredCount > 0) {
            await setItem("shivadraw_docs", mergedDocs);
            setDocuments(mergedDocs);
            const firstRestored = mergedDocs[mergedDocs.length - restoredCount];
            if (firstRestored) {
              setActiveDocId(firstRestored.id);
            }
            showToast(`Restored ${restoredCount} drawings from backup! 📂`, "success");
          } else {
            showToast("No new drawings to restore", "info");
          }
        } else {
          showToast("Invalid backup file format", "error");
        }
      } catch (err) {
        showToast("Error restoring backup file", "error");
      }
    };
    fileReader.readAsText(file);
    e.target.value = "";
  };

  // Import board from a .shiva or .json file
  const handleImport = (e) => {
    const fileReader = new FileReader();
    const file = e.target.files[0];
    if (!file) return;

    fileReader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        if (parsed && Array.isArray(parsed.elements)) {
          createNewBoard(parsed.title || "Imported Board", parsed.elements, parsed.appState || {}, parsed.files || {});
          showToast("Drawing imported successfully! 🎨");
        } else {
          showToast("Invalid file format: must contain elements array", "error");
        }
      } catch (err) {
        showToast("Error reading file", "error");
      }
    };
    fileReader.readAsText(file);
    // Reset file input
    e.target.value = "";
  };

  // Open a file from disk using the File System Access API to capture writeable handle for Auto-Save
  async function openFileFromDisk() {
    if (!window.showOpenFilePicker) {
      // Fallback: trigger the hidden input click
      if (fileInputRef.current) {
        fileInputRef.current.click();
      }
      return;
    }

    try {
      const [handle] = await window.showOpenFilePicker({
        types: [{
          description: "Shiva Canvas File",
          accept: { "application/json": [".shiva"] }
        }],
        multiple: false
      });

      const file = await handle.getFile();
      const text = await file.text();
      try {
        const parsed = JSON.parse(text);
        if (parsed && Array.isArray(parsed.elements)) {
          const docId = `doc-${Date.now()}`;
          const clonedElements = cloneElements(parsed.elements);
          const newDoc = {
            id: docId,
            title: parsed.title || file.name.replace(/\.shiva$/, "").replace(/_/g, " "),
            updatedAt: Date.now(),
            elements: clonedElements,
            appState: parsed.appState || {},
            files: parsed.files || {},
            fileHandle: handle,
            autoSaveEnabled: true // Enable auto-save on newly imported disk file
          };

          // Store the writeable handle in our map
          fileHandlesRef.current[docId] = handle;
          setFilePermissionState("granted");

          // Initialize latestDataRef with correct imported drawing data
          latestDataRef.current = {
            elements: clonedElements,
            appState: parsed.appState || {},
            files: parsed.files || {}
          };

          // Add to documents and activate it
          setDocuments(prevDocs => [newDoc, ...prevDocs]);
          setActiveDocId(docId);

          // Automatically enable Auto-Save
          autoSaveEnabledRef.current = true;
          setAutoSaveEnabled(true);
          setAutoSaveFileName(handle.name);

          showToast(`"${file.name}" loaded & Auto-save enabled! 💾`);
        } else {
          showToast("Invalid file format: must contain elements array", "error");
        }
      } catch (err) {
        showToast("Error parsing .shiva file content", "error");
      }
    } catch (err) {
      if (err.name !== "AbortError") {
        console.error("Open file error:", err);
        showToast("Could not open file", "error");
      }
    }
  }

  // Emergency save: flush any pending debounced changes immediately to IndexedDB
  // This runs on page unload (browser close/refresh) and on tab visibility change (power cut / switching away)
  useEffect(() => {
    const emergencySave = async () => {
      const currentId = activeDocIdRef.current;
      if (!currentId || !latestDataRef.current) return;

      // Flush the pending debounced save immediately
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
        saveTimeoutRef.current = null;
      }

      // If we are currently switching documents or loading, do not save!
      if (isSwitchingRef.current) {
        console.log("Emergency save skipped: App is in switching/loading state.");
        return;
      }

      // Build updated documents array with the latest canvas data
      setDocuments(prevDocs => {
        const docIndex = prevDocs.findIndex(d => d.id === currentId);
        if (docIndex === -1) return prevDocs;

        const updatedDocs = [...prevDocs];
        const activeDocInDB = updatedDocs[docIndex];
        const existingFiles = activeDocInDB.files || {};
        const newFiles = latestDataRef.current.files || {};
        
        // Safeguard to prevent overwriting elements with empty array during initialization/race condition
        const hasExistingElements = activeDocInDB.elements && activeDocInDB.elements.length > 0;
        const incomingElements = latestDataRef.current.elements;
        const isIncomingEmpty = !incomingElements || incomingElements.length === 0;

        let finalElements = activeDocInDB.elements;
        let finalAppState = activeDocInDB.appState;
        
        if (!isIncomingEmpty || !hasExistingElements) {
          finalElements = incomingElements;
          finalAppState = latestDataRef.current.appState || activeDocInDB.appState;
        } else {
          console.warn("Emergency save prevented: would have overwritten elements with empty array.");
        }

        updatedDocs[docIndex] = {
          ...updatedDocs[docIndex],
          elements: finalElements,
          appState: finalAppState,
          files: { ...existingFiles, ...newFiles },
          updatedAt: Date.now()
        };

        // Fire-and-forget IndexedDB write immediately (synchronous-as-possible)
        setItem("shivadraw_docs", updatedDocs).catch(err => {
          console.error("Emergency save to IndexedDB failed:", err);
        });

        // Save backup to localStorage
        try {
          const backupDocs = updatedDocs.map(doc => ({
            id: doc.id,
            title: doc.title,
            updatedAt: doc.updatedAt,
            elements: doc.elements,
            appState: doc.appState,
            backgroundStyle: doc.backgroundStyle,
            fileHandle: doc.fileHandle,
            autoSaveEnabled: doc.autoSaveEnabled
          }));
          localStorage.setItem("shivadraw_docs_backup", JSON.stringify(backupDocs));
        } catch (e) {
          console.warn("Emergency save failed to write backup to localStorage:", e);
        }

        return updatedDocs;
      });
    };

    const handleBeforeUnload = () => {
      emergencySave();
    };

    const handleVisibilityChange = () => {
      // Save when user hides the tab (Alt+Tab, power loss, etc.)
      if (document.visibilityState === "hidden") {
        emergencySave();
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  // Intercept drag-and-drop of .shiva files globally to prevent Excalidraw from crashing with "invalid file"
  useEffect(() => {
    const handleDragOver = (e) => {
      e.preventDefault();
    };

    const handleDrop = async (e) => {
      const files = Array.from(e.dataTransfer?.files || []);
      const shivaFiles = files.filter(file => file.name.endsWith(".shiva"));

      if (shivaFiles.length > 0) {
        // Intercept it completely before Excalidraw's listener can run
        e.preventDefault();
        e.stopPropagation();

        for (const file of shivaFiles) {
          const fileReader = new FileReader();
          fileReader.onload = (event) => {
            try {
              const parsed = JSON.parse(event.target.result);
              if (parsed && Array.isArray(parsed.elements)) {
                createNewBoard(
                  parsed.title || file.name.replace(/\.shiva$/, "").replace(/_/g, " "),
                  parsed.elements,
                  parsed.appState || {},
                  parsed.files || {}
                );
                showToast(`"${file.name}" imported successfully! 🎨`);
              } else {
                showToast("Invalid file format: must contain elements array", "error");
              }
            } catch (err) {
              showToast("Error reading file", "error");
            }
          };
          fileReader.readAsText(file);
        }
      }
    };

    // Use capture phase (true) to intercept the drop event before Excalidraw can process it
    window.addEventListener("dragover", handleDragOver, true);
    window.addEventListener("drop", handleDrop, true);

    return () => {
      window.removeEventListener("dragover", handleDragOver, true);
      window.removeEventListener("drop", handleDrop, true);
    };
  }, []);

  // Formatting date for document lists (stable: no deps)
  const formatTime = useCallback((timestamp) => {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }, []);

  // Memoized: avoids linear scan of documents array on every render
  const activeDoc = useMemo(() => documents.find(d => d.id === activeDocId), [documents, activeDocId]);

  // Memoized watermark color — only recomputes when background style or theme changes
  const watermarkColor = useMemo(() => {
    const bgStyle = activeDoc?.backgroundStyle;
    if (bgStyle && isPresetBackground(bgStyle)) {
      return DARK_BACKGROUND_PRESETS.has(bgStyle) ? "#ffffff" : "var(--text-primary)";
    } else if (bgStyle && !isPresetBackground(bgStyle)) {
      return isColorDark(bgStyle) ? "#ffffff" : "var(--text-primary)";
    }
    return "var(--text-primary)";
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeDoc?.backgroundStyle, theme]);

  return (
    <div className={`app-container ${sidebarOpen ? "sidebar-open" : "sidebar-collapsed"} ${showCanvasControls ? "show-canvas-controls" : "hide-canvas-controls"} ${showNotifications ? "show-toasts" : "hide-toasts"} ${propertiesPanelVisible ? "show-properties-panel" : "hide-properties-panel"}`}>
      {/* Left Sidebar Panel */}
      <aside className={`sidebar ${!sidebarOpen ? "collapsed" : ""}`}>
        {/* Sidebar Header / Logo */}
        <div className="sidebar-header">
          <div className="logo-icon">✏️</div>
          <span className="logo-text">Shiva Canvas</span>
          <button 
            className="btn-secondary" 
            style={{ width: "calc(30px * var(--ui-scale))", height: "calc(30px * var(--ui-scale))", minWidth: "auto", position: "absolute", top: "calc(1.5rem * var(--ui-scale))", right: "calc(1.5rem * var(--ui-scale))", padding: "0", display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "calc(8px * var(--ui-scale))", fontSize: "calc(12px * var(--ui-scale))" }}
            onClick={() => setSidebarOpen(false)}
            title="Collapse Sidebar (Ctrl + \)"
          >
            ◀
          </button>
        </div>

        {/* Quick Actions */}
        <button className="btn-primary" onClick={() => createNewBoard("New Board 🎨", [])}>
          <span>➕</span> New Board
        </button>

        {/* Settings / Preferences Section */}
        <div className="settings-section" style={{ borderBottom: "1px solid var(--border-color)", paddingBottom: "calc(1.25rem * var(--ui-scale))", marginBottom: "calc(1.25rem * var(--ui-scale))" }}>
          <h4 className="section-title">Settings</h4>
          

          
          {/* Brush Smoothing Slider */}
          <div style={{ display: "flex", flexDirection: "column", gap: "calc(0.25rem * var(--ui-scale))", marginTop: "calc(0.25rem * var(--ui-scale))", padding: "calc(0.25rem * var(--ui-scale)) 0" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: "calc(0.75rem * var(--ui-scale))" }}>
              <span style={{ color: "var(--text-secondary)" }}>Brush Smoothing</span>
              <span style={{ fontWeight: "bold", color: "#6366f1" }}>{brushSmoothing === 0 ? "Off" : brushSmoothing}</span>
            </div>
            <input 
              type="range" 
              min="0" 
              max="5" 
              value={brushSmoothing} 
              onChange={(e) => {
                const val = parseInt(e.target.value, 10);
                setBrushSmoothing(val);
                localStorage.setItem("shivadraw_brush_smoothing", val);
              }}
              style={{ width: "100%", cursor: "pointer", accentColor: "#6366f1", height: "calc(6px * var(--ui-scale))" }}
            />
          </div>

          {/* Workspace Scale Dropdown */}
          <div style={{ display: "flex", flexDirection: "column", gap: "calc(0.25rem * var(--ui-scale))", padding: "calc(0.25rem * var(--ui-scale)) 0" }}>
            <span style={{ fontSize: "calc(0.75rem * var(--ui-scale))", color: "var(--text-secondary)" }}>Workspace Scale</span>
            <select 
              value={uiScale} 
              onChange={(e) => {
                const val = parseFloat(e.target.value);
                setUiScale(val);
                localStorage.setItem("shivadraw_ui_scale", val);
              }}
              style={{
                width: "100%",
                padding: "calc(0.35rem * var(--ui-scale)) calc(0.5rem * var(--ui-scale))",
                borderRadius: "calc(6px * var(--ui-scale))",
                border: "1px solid var(--border-color)",
                background: "var(--bg-card)",
                color: "var(--text-primary)",
                fontSize: "calc(0.8rem * var(--ui-scale))",
                cursor: "pointer",
                outline: "none"
              }}
            >
              <option value="0.5">50% (Tiny)</option>
              <option value="0.6">60% (Very Small)</option>
              <option value="0.65">65% (Compact Small)</option>
              <option value="0.7">70% (Medium Small)</option>
              <option value="0.75">75% (Small)</option>
              <option value="0.9">90% (Compact)</option>
              <option value="1.0">100% (Default)</option>
              <option value="1.1">110% (Large)</option>
              <option value="1.2">120% (Huge)</option>
            </select>
          </div>

          {/* Right Brand Watermark Size Dropdown */}
          <div style={{ display: "flex", flexDirection: "column", gap: "calc(0.25rem * var(--ui-scale))", padding: "calc(0.25rem * var(--ui-scale)) 0" }}>
            <span style={{ fontSize: "calc(0.75rem * var(--ui-scale))", color: "var(--text-secondary)" }}>Right Logo Size</span>
            <select 
              value={watermarkSize} 
              onChange={(e) => {
                const val = e.target.value;
                setWatermarkSize(val);
                localStorage.setItem("shivadraw_watermark_size", val);
              }}
              style={{
                width: "100%",
                padding: "calc(0.35rem * var(--ui-scale)) calc(0.5rem * var(--ui-scale))",
                borderRadius: "calc(6px * var(--ui-scale))",
                border: "1px solid var(--border-color)",
                background: "var(--bg-card)",
                color: "var(--text-primary)",
                fontSize: "calc(0.8rem * var(--ui-scale))",
                cursor: "pointer",
                outline: "none"
              }}
            >
              <option value="0">Hidden</option>
              <option value="0.5">Tiny</option>
              <option value="0.6">Very Small</option>
              <option value="0.75">Small</option>
              <option value="0.9">Medium (Default)</option>
              <option value="1.1">Medium Large</option>
              <option value="1.3">Large</option>
              <option value="1.6">Extra Large</option>
              <option value="2.0">Huge</option>
              <option value="2.5">Very Huge</option>
              <option value="3.0">Super Huge</option>
              <option value="4.0">Gigantic</option>
              <option value="5.0">Colossal</option>
            </select>
          </div>



          {/* Workspace Background Style Dropdown */}
          <div style={{ display: "flex", flexDirection: "column", gap: "calc(0.25rem * var(--ui-scale))", padding: "calc(0.25rem * var(--ui-scale)) 0" }}>
            <span style={{ fontSize: "calc(0.75rem * var(--ui-scale))", color: "var(--text-secondary)" }}>Workspace Background</span>
            <select 
              value={isPresetBackground(activeDoc?.backgroundStyle) ? activeDoc.backgroundStyle : "pure-white"} 
              onChange={(e) => handleBackgroundChange(e.target.value)}
              style={{
                width: "100%",
                padding: "calc(0.35rem * var(--ui-scale)) calc(0.5rem * var(--ui-scale))",
                borderRadius: "calc(6px * var(--ui-scale))",
                border: "1px solid var(--border-color)",
                background: "var(--bg-card)",
                color: "var(--text-primary)",
                fontSize: "calc(0.8rem * var(--ui-scale))",
                cursor: "pointer",
                outline: "none"
              }}
            >
              <option value="pure-white">Pure White (Default)</option>
              <option value="solid-classic">Solid Classic</option>
              <option value="blueprint">Blueprint Grid</option>
              <option value="dot-grid">Dot Grid</option>
              <option value="graph-grid">Graph Grid</option>
              <option value="schoolboard">School Board</option>
              <option value="sunset">Sunset Glow (Gradient)</option>
              <option value="aurora">Aurora Green (Gradient)</option>
              <option value="midnight">Midnight Indigo (Gradient)</option>
            </select>
          </div>



          <div className="settings-row" style={{ marginTop: "calc(0.5rem * var(--ui-scale))" }}>
            <span style={{ fontSize: "calc(0.75rem * var(--ui-scale))" }}>Theme Mode</span>
            <button className="theme-toggle-btn" onClick={toggleTheme} title="Toggle Theme Mode">
              {theme === "light" ? "🌙" : "☀️"}
            </button>
          </div>

          <div className="settings-row properties-panel-row" style={{ marginTop: "calc(0.5rem * var(--ui-scale))" }}>
            <span style={{ fontSize: "calc(0.75rem * var(--ui-scale))" }}>Show Properties Panel</span>
            <input 
              type="checkbox" 
              checked={propertiesPanelVisible} 
              onChange={(e) => setPropertiesPanelVisible(e.target.checked)} 
              style={{
                cursor: "pointer",
                accentColor: "#6366f1",
                width: "calc(16px * var(--ui-scale))",
                height: "calc(16px * var(--ui-scale))"
              }}
            />
          </div>

          <div className="settings-row" style={{ marginTop: "calc(0.5rem * var(--ui-scale))" }}>
            <span style={{ fontSize: "calc(0.75rem * var(--ui-scale))" }}>Show Canvas Controls</span>
            <input 
              type="checkbox" 
              checked={showCanvasControls} 
              onChange={handleToggleCanvasControls} 
              style={{
                cursor: "pointer",
                accentColor: "#6366f1",
                width: "calc(16px * var(--ui-scale))",
                height: "calc(16px * var(--ui-scale))"
              }}
            />
          </div>

          <div className="settings-row" style={{ marginTop: "calc(0.5rem * var(--ui-scale))" }}>
            <span style={{ fontSize: "calc(0.75rem * var(--ui-scale))" }}>Show Toast Notifications</span>
            <input 
              type="checkbox" 
              checked={showNotifications} 
              onChange={(e) => {
                const val = e.target.checked;
                setShowNotifications(val);
                localStorage.setItem("shivadraw_show_notifications", val);
              }}
              style={{
                cursor: "pointer",
                accentColor: "#6366f1",
                width: "calc(16px * var(--ui-scale))",
                height: "calc(16px * var(--ui-scale))"
              }}
            />
          </div>

          {/* ── Auto-Save to Disk ───────────────────── */}
          <div style={{ borderTop: "1px solid var(--border-color)", marginTop: "calc(0.5rem * var(--ui-scale))", paddingTop: "calc(0.6rem * var(--ui-scale))" }}>
            <div className="settings-row">
              <div style={{ display: "flex", flexDirection: "column", gap: "calc(0.1rem * var(--ui-scale))" }}>
                <span style={{ fontSize: "calc(0.75rem * var(--ui-scale))", fontWeight: "600" }}>
                  💾 Auto-save to Disk
                </span>
                {autoSaveFileName && (
                  <span style={{
                    fontSize: "calc(0.65rem * var(--ui-scale))",
                    color: filePermissionState !== "granted" ? "#f59e0b" : autoSaveDiskStatus === "error" ? "#ef4444" : autoSaveDiskStatus === "saving" ? "#f59e0b" : "#10b981",
                    maxWidth: "calc(130px * var(--ui-scale))",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap"
                  }} title={autoSaveFileName}>
                    {filePermissionState !== "granted" ? "⚠️ Needs Permission" : autoSaveDiskStatus === "saving" ? "⏳ Saving..." : autoSaveDiskStatus === "saved" ? "✅ Saved!" : autoSaveDiskStatus === "error" ? "❌ Failed" : `→ ${autoSaveFileName}`}
                  </span>
                )}
              </div>
              <input
                type="checkbox"
                checked={autoSaveEnabled}
                onChange={(e) => handleToggleAutoSave(e.target.checked)}
                style={{
                  cursor: "pointer",
                  accentColor: "#10b981",
                  width: "calc(16px * var(--ui-scale))",
                  height: "calc(16px * var(--ui-scale))",
                  flexShrink: 0
                }}
              />
            </div>
            {autoSaveFileName && filePermissionState !== "granted" && (
              <div style={{ 
                marginTop: "calc(0.35rem * var(--ui-scale))",
                padding: "calc(0.4rem * var(--ui-scale))",
                borderRadius: "calc(4px * var(--ui-scale))",
                background: "rgba(245, 158, 11, 0.1)",
                border: "1px solid rgba(245, 158, 11, 0.3)",
                display: "flex",
                flexDirection: "column",
                gap: "calc(0.3rem * var(--ui-scale))"
              }}>
                <span style={{ fontSize: "calc(0.65rem * var(--ui-scale))", color: "#f59e0b", lineHeight: 1.2 }}>
                  ⚠️ File connection paused. Authorize to resume auto-save.
                </span>
                <button
                  className="btn-secondary"
                  onClick={() => {
                    const activeDoc = documents.find(d => d.id === activeDocId);
                    const handle = fileHandlesRef.current[activeDocId] || activeDoc?.fileHandle;
                    if (handle) {
                      requestFilePermission(handle);
                    }
                  }}
                  style={{ 
                    fontSize: "calc(0.7rem * var(--ui-scale))",
                    padding: "calc(0.25rem * var(--ui-scale)) calc(0.35rem * var(--ui-scale))",
                    color: "#f59e0b",
                    borderColor: "#f59e0b",
                    background: "transparent",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    gap: "calc(0.2rem * var(--ui-scale))"
                  }}
                >
                  🔗 Reconnect File
                </button>
              </div>
            )}
            {autoSaveEnabled && filePermissionState === "granted" && (
              <div style={{ display: "flex", gap: "calc(0.3rem * var(--ui-scale))", marginTop: "calc(0.35rem * var(--ui-scale))" }}>
                <button
                  className="btn-secondary"
                  onClick={saveNowToDisk}
                  title="Save to disk right now"
                  style={{ flex: 1, fontSize: "calc(0.72rem * var(--ui-scale))", padding: "calc(0.3rem * var(--ui-scale)) calc(0.4rem * var(--ui-scale))" }}
                >
                  💾 Save Now
                </button>
                <button
                  className="btn-secondary"
                  onClick={async () => {
                    const activeDoc = documents.find(d => d.id === activeDocId);
                    await pickSaveFile(activeDoc?.title || "drawing");
                  }}
                  title="Change the save file location"
                  style={{ flex: 1, fontSize: "calc(0.72rem * var(--ui-scale))", padding: "calc(0.3rem * var(--ui-scale)) calc(0.4rem * var(--ui-scale))" }}
                >
                  📁 Change File
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Drawings Selector */}
        <div className="documents-section">
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "calc(0.5rem * var(--ui-scale))" }}>
            <h4 className="section-title" style={{ margin: 0 }}>My Drawings</h4>
            <span style={{ fontSize: "calc(0.7rem * var(--ui-scale))", color: saveStatus === "saving" ? "var(--accent-color)" : "var(--success-color)", display: "flex", alignItems: "center", gap: "calc(0.25rem * var(--ui-scale))", userSelect: "none" }}>
              <span className={`status-dot ${saveStatus}`} style={{ width: "calc(6px * var(--ui-scale))", height: "calc(6px * var(--ui-scale))", borderRadius: "50%", background: saveStatus === "saving" ? "var(--accent-color)" : "var(--success-color)", display: "inline-block" }}></span>
              {saveStatus === "saving" ? "Saving..." : "Saved"}
            </span>
          </div>
          <input
            type="text"
            placeholder="🔍 Search drawings..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              padding: "calc(0.35rem * var(--ui-scale)) calc(0.5rem * var(--ui-scale))",
              borderRadius: "calc(6px * var(--ui-scale))",
              border: "1px solid var(--border-color)",
              background: "var(--bg-input, var(--bg-card))",
              color: "var(--text-primary)",
              fontSize: "calc(0.8rem * var(--ui-scale))",
              marginBottom: "calc(0.5rem * var(--ui-scale))",
              outline: "none"
            }}
          />
          <ul className="doc-list">
            {documents
              .filter(doc => doc.title.toLowerCase().includes(searchQuery.toLowerCase()))
              .map((doc) => (
                <li
                  key={doc.id}
                  className={`doc-item ${doc.id === activeDocId ? "active" : ""}`}
                  onClick={() => setActiveDocId(doc.id)}
                >
                  <div className="doc-details">
                    <div className="doc-title-wrapper">
                      {editingDocId === doc.id ? (
                        <input
                          type="text"
                          className="doc-title-input"
                          defaultValue={doc.title}
                          autoFocus
                          onBlur={(e) => renameBoard(doc.id, e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") renameBoard(doc.id, e.target.value);
                            if (e.key === "Escape") setEditingDocId(null);
                          }}
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <span className="doc-title" onDoubleClick={() => setEditingDocId(doc.id)}>
                          {doc.title}
                        </span>
                      )}
                    </div>
                    <span className="doc-meta">{formatTime(doc.updatedAt)}</span>
                  </div>

                  <div className="doc-actions" onClick={(e) => e.stopPropagation()}>
                    <button className="doc-btn edit" onClick={() => setEditingDocId(doc.id)} title="Rename">✏️</button>
                    <button className="doc-btn duplicate" onClick={(e) => duplicateBoard(doc, e)} title="Duplicate">📑</button>
                    <button className="doc-btn delete" onClick={(e) => deleteBoard(doc.id, e)} title="Delete">🗑️</button>
                  </div>
                </li>
              ))}
          </ul>
        </div>

        {/* Templates Selector */}
        <div className="templates-section">
          <h4 className="section-title">Templates</h4>
          <div className="templates-grid">
            <div className="template-card" onClick={() => createNewBoard("Flowchart Diagram", FLOWCHART_ELEMENTS)}>
              <span className="template-icon">🌿</span>
              <span className="template-name">Flowchart</span>
            </div>
            <div className="template-card" onClick={() => createNewBoard("Mind Map", MINDMAP_ELEMENTS)}>
              <span className="template-icon">🧠</span>
              <span className="template-name">Mind Map</span>
            </div>
            <div className="template-card" onClick={() => createNewBoard("App Wireframe", WIREFRAME_ELEMENTS)}>
              <span className="template-icon">📱</span>
              <span className="template-name">Wireframe</span>
            </div>
            <div className="template-card" onClick={() => createNewBoard("Blank Board", [])}>
              <span className="template-icon">📄</span>
              <span className="template-name">Blank Page</span>
            </div>
          </div>
        </div>



        {/* Controls / Settings */}
        <div className="settings-section">
          <h4 className="section-title">Controls</h4>
          <button className="btn-secondary" onClick={exportBoard} title="Export board as Shiva Canvas .shiva file">
            <span>📤</span> Export .shiva
          </button>
          <button className="btn-secondary" onClick={() => exportAsImage("png")} title="Export drawing as PNG image">
            <span>🖼️</span> Export PNG
          </button>
          <button className="btn-secondary" onClick={exportAsPdf} title="Export drawing as PDF via print dialog">
            <span>📄</span> Export PDF
          </button>
          <button className="btn-secondary" onClick={copyToClipboard} title="Copy drawing as PNG image to clipboard">
            <span>📋</span> Copy to Clipboard
          </button>
          <button className="btn-secondary" onClick={() => exportAsImage("svg")} title="Export drawing as SVG vector file">
            <span>🌐</span> Export SVG
          </button>
          <button className="btn-secondary" onClick={openFileFromDisk} title="Import a Shiva Canvas .shiva file">
            <span>📥</span> Import .shiva
          </button>
          <button className="btn-secondary" onClick={resetBoard} title="Clear the entire canvas">
            <span>🗑️</span> Reset Canvas
          </button>

          {/* Backup / Restore Controls */}
          <div style={{ display: "flex", flexDirection: "column", gap: "calc(0.25rem * var(--ui-scale))", borderTop: "1px solid var(--border-color)", marginTop: "calc(0.5rem * var(--ui-scale))", paddingTop: "calc(0.5rem * var(--ui-scale))" }}>
            <span style={{ fontSize: "calc(0.7rem * var(--ui-scale))", color: "var(--text-muted)", fontWeight: "bold", textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "calc(0.2rem * var(--ui-scale))" }}>System Backup</span>
            <button className="btn-secondary" onClick={backupAllDrawings} title="Backup all Shiva Canvas drawings to a single file" style={{ display: "flex", justifyContent: "flex-start", gap: "calc(0.4rem * var(--ui-scale))", width: "100%" }}>
              <span>💾</span> Backup All Drawings
            </button>
            <button className="btn-secondary" onClick={() => backupInputRef.current.click()} title="Restore all Shiva Canvas drawings from a backup file" style={{ display: "flex", justifyContent: "flex-start", gap: "calc(0.4rem * var(--ui-scale))", width: "100%" }}>
              <span>📂</span> Restore from Backup
            </button>
          </div>
        </div>



        <input
          type="file"
          ref={fileInputRef}
          style={{ display: "none" }}
          accept=".shiva,.json"
          onChange={handleImport}
        />
        <input
          type="file"
          ref={backupInputRef}
          style={{ display: "none" }}
          accept=".json"
          onChange={restoreBackup}
        />
      </aside>

      {/* Main Canvas Component Area */}
      <main 
        className={`canvas-wrapper ${isPresetBackground(activeDoc?.backgroundStyle) ? `bg-preset-${activeDoc.backgroundStyle}` : "bg-preset-pure-white"}`}
        style={{
          background: activeDoc?.backgroundStyle && !isPresetBackground(activeDoc.backgroundStyle) ? activeDoc.backgroundStyle : undefined
        }}
      >


        <div style={{ width: "100%", height: "100%", position: "relative" }}>
          {/* Excalidraw container */}
          {!loading && (
            <Excalidraw
              excalidrawAPI={(api) => {
                setExcalidrawAPI(api);
                // Keep switching blocked initially to prevent Excalidraw from writing empty canvas
                // during mount loading phase
                setTimeout(() => {
                  isSwitchingRef.current = false;
                }, 1000);
              }}
              theme={theme}
              initialData={initialDataRef.current}
              onChange={handleCanvasChange}
              onPointerUp={handlePointerUp}
            >
              <MainMenu>
                <MainMenu.DefaultItems.Help />
                <MainMenu.DefaultItems.ClearCanvas />
                <MainMenu.Separator />
                <MainMenu.DefaultItems.ToggleTheme />
                <MainMenu.DefaultItems.ChangeCanvasBackground />
              </MainMenu>
            </Excalidraw>
          )}


        </div>
      </main>

      {/* Pop up message alert */}
      {showNotifications && notification && (
        <div className={`notification-toast ${notification.type}`}>
          <span>🔔</span>
          <span>{notification.message}</span>
        </div>
      )}

      {/* Floating Vertical Brand Watermark — color pre-computed by watermarkColor useMemo */}
      <div
        className="vertical-brand-watermark"
        style={{
          fontSize: watermarkSize !== "0" ? `${watermarkSize}rem` : undefined,
          right: watermarkSize !== "0" ? `calc(15px + ${watermarkSize}rem / 2)` : undefined,
          display: watermarkSize === "0" ? "none" : "block",
          color: watermarkColor
        }}
      >
        SHIVA
      </div>

      {/* PDF Export Mode Dialog */}
      {pdfDialogOpen && (
        <div className="pdf-dialog-overlay" onClick={() => setPdfDialogOpen(false)}>
          <div className="pdf-dialog" onClick={e => e.stopPropagation()}>
            <div className="pdf-dialog-header">
              <span className="pdf-dialog-icon">📄</span>
              <div>
                <h2 className="pdf-dialog-title">Export as PDF</h2>
                <p className="pdf-dialog-subtitle">Choose how your drawing fits on the page</p>
              </div>
              <button className="pdf-dialog-close" onClick={() => setPdfDialogOpen(false)}>✕</button>
            </div>

            <div className="pdf-dialog-cards">
              {/* Single Page option */}
              <button
                className="pdf-mode-card"
                onClick={() => { setPdfDialogOpen(false); buildAndOpenPrintWindow("single"); }}
              >
                <div className="pdf-mode-preview pdf-mode-preview--single">
                  <div className="pdf-page-mock">
                    <div className="pdf-page-content" />
                  </div>
                </div>
                <div className="pdf-mode-info">
                  <span className="pdf-mode-name">Single Page</span>
                  <span className="pdf-mode-desc">Entire drawing scaled to fit one page. Landscape or portrait auto-selected.</span>
                </div>
                <span className="pdf-mode-arrow">→</span>
              </button>

              {/* A4 Multi-page option */}
              <button
                className="pdf-mode-card"
                onClick={() => { setPdfDialogOpen(false); buildAndOpenPrintWindow("a4"); }}
              >
                <div className="pdf-mode-preview pdf-mode-preview--a4">
                  <div className="pdf-page-mock pdf-page-mock--sm" style={{ transform: "translateY(-4px) translateX(-6px)" }} />
                  <div className="pdf-page-mock pdf-page-mock--sm" style={{ transform: "translateY(4px) translateX(6px)" }} />
                </div>
                <div className="pdf-mode-info">
                  <span className="pdf-mode-name">A4 Multi-page</span>
                  <span className="pdf-mode-desc">Large drawings flow across multiple A4 portrait sheets with page numbers.</span>
                </div>
                <span className="pdf-mode-arrow">→</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

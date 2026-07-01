import React, { useState, useEffect, useRef } from "react";
import { Excalidraw, MainMenu, exportToBlob, exportToSvg } from "@excalidraw/excalidraw";
import "@excalidraw/excalidraw/index.css";
import { getItem, setItem, isIndexedDBSupported } from "./db";

// Helper function to create basic Excalidraw elements
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

const measureTextDimensions = (text, fontSize, fontFamilyName, lineHeight = 1.25) => {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
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
    currentItemFontFamily: appState.currentItemFontFamily,
    currentItemFontSize: appState.currentItemFontSize,
    currentItemTextAlign: appState.currentItemTextAlign,
    currentItemStartArrowhead: appState.currentItemStartArrowhead,
    currentItemEndArrowhead: appState.currentItemEndArrowhead,
    currentItemRoundnessType: appState.currentItemRoundnessType,
    currentItemRoundness: appState.currentItemRoundness,
    viewBackgroundColor: appState.viewBackgroundColor,
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
      currentItemRoundness: "sharp"
    }
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
  const isSwitchingRef = useRef(false);
  const saveTimeoutRef = useRef(null);
  const latestDataRef = useRef({ elements: [] });
  const fileInputRef = useRef(null);
  const isInitialMountRef = useRef(true);
  const initialDataRef = useRef(null);
  const [activeDropdown, setActiveDropdown] = useState(null);
  const [brushSmoothing, setBrushSmoothing] = useState(() => {
    return parseInt(localStorage.getItem("shivadraw_brush_smoothing") || "3", 10);
  });
  const [activeCustomFont, setActiveCustomFont] = useState(() => {
    return localStorage.getItem("shivadraw_active_custom_font") || "Roboto";
  });
  const [saveStatus, setSaveStatus] = useState("saved"); // "saved" | "saving"
  const [searchQuery, setSearchQuery] = useState("");
  const [showNotifications, setShowNotifications] = useState(() => {
    const saved = localStorage.getItem("shivadraw_show_notifications");
    return saved ? saved === "true" : true;
  });
  const [showCanvasControls, setShowCanvasControls] = useState(() => {
    const saved = localStorage.getItem("shivadraw_show_canvas_controls");
    return saved ? saved === "true" : true;
  });

  const handleToggleCanvasControls = (e) => {
    const checked = e.target.checked;
    setShowCanvasControls(checked);
    localStorage.setItem("shivadraw_show_canvas_controls", checked);
  };
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

  const toggleDropdown = (name, e) => {
    e.stopPropagation();
    setActiveDropdown(activeDropdown === name ? null : name);
  };

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

      // Update React states and initial refs
      setDocuments(loadedDocs);
      if (initialActiveId) {
        setActiveDocId(initialActiveId);
        const activeDoc = loadedDocs.find(d => d.id === initialActiveId);
        if (activeDoc) {
          initialDataRef.current = {
            elements: Array.isArray(activeDoc.elements) ? activeDoc.elements : [],
            appState: activeDoc.appState && typeof activeDoc.appState === "object" ? activeDoc.appState : {},
            files: activeDoc.files && typeof activeDoc.files === "object" ? activeDoc.files : {}
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
        if (isCurrent) {
          setSaveStatus("saved");
        }
      } catch (err) {
        console.error("Failed to auto-save documents to IndexedDB:", err);
        showToast("Failed to save changes! Storage issue.", "error");
        if (isCurrent) {
          setSaveStatus("saved");
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
    fetch("/colors.json")
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
              // Apply the solid color to the canvas wrapper
              const wrapper = document.querySelector(".canvas-wrapper");
              if (wrapper) {
                wrapper.style.background = displayColor;
              }
              
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

    const observer = new MutationObserver(() => {
      injectCustomColors();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
    };
  }, [loading, predefinedColors, excalidrawAPI]);

  // Apply custom font CSS override on mount/change
  useEffect(() => {
    if (loading) return;

    let isCurrent = true;

    const applyFont = async () => {
      // Clear any programmatically registered Excalifont faces from document.fonts
      // to let stylesheet @font-face rules take effect.
      try {
        Array.from(document.fonts).forEach(font => {
          const cleanFamily = font.family.replace(/['"]/g, "");
          if (cleanFamily === "Excalifont") {
            document.fonts.delete(font);
          }
        });
      } catch (err) {
        console.error("Error clearing document.fonts:", err);
      }

      let cssContent = "";

      if (activeCustomFont !== "Excalifont") {
        const cleanName = activeCustomFont.replace(/\s+/g, '-');
        const baseUrl = import.meta.env.BASE_URL;
        cssContent = `
          @font-face {
            font-family: "Excalifont";
            src: url("${baseUrl}fonts/${cleanName}-Regular.woff2") format("woff2"),
                 local("${activeCustomFont}"), 
                 local("${activeCustomFont} Regular"), 
                 local("${activeCustomFont}-Regular");
            font-weight: 400;
            font-style: normal;
            font-display: swap;
          }
          @font-face {
            font-family: "Excalifont";
            src: url("${baseUrl}fonts/${cleanName}-Bold.woff2") format("woff2"),
                 local("${activeCustomFont} Bold"), 
                 local("${activeCustomFont}-Bold");
            font-weight: 700;
            font-style: normal;
            font-display: swap;
          }
        `;

        try {
          const fontFaceReg = new FontFace("Excalifont", `url("${baseUrl}fonts/${cleanName}-Regular.woff2"), local("${activeCustomFont}"), local("${activeCustomFont}-Regular")`, { weight: '400' });
          const fontFaceBold = new FontFace("Excalifont", `url("${baseUrl}fonts/${cleanName}-Bold.woff2"), local("${activeCustomFont} Bold"), local("${activeCustomFont}-Bold")`, { weight: '700' });
          
          await Promise.all([
            fontFaceReg.load().then(() => document.fonts.add(fontFaceReg)).catch(() => {}),
            fontFaceBold.load().then(() => document.fonts.add(fontFaceBold)).catch(() => {})
          ]);
        } catch (err) {
          console.error("Error creating local FontFace:", err);
        }
      }

      if (!isCurrent) return;

      let styleEl = document.getElementById("excalifont-override-style");
      if (cssContent) {
        if (!styleEl) {
          styleEl = document.createElement("style");
          styleEl.id = "excalifont-override-style";
          document.head.appendChild(styleEl);
        }
        styleEl.textContent = cssContent;
      } else {
        if (styleEl) styleEl.remove();
      }

      localStorage.setItem("shivadraw_active_custom_font", activeCustomFont);

      // Refresh canvas immediately to recalculate dimensions and redraw text
      const refreshScene = () => {
        if (excalidrawAPI && isCurrent) {
          const elements = excalidrawAPI.getSceneElements().map(el => {
            if (el.type === "text" && (el.fontFamily === 4 || el.fontFamily === 5)) {
              const { width, height } = measureTextDimensions(
                el.text, 
                el.fontSize, 
                activeCustomFont === "Excalifont" ? "Excalifont" : activeCustomFont,
                el.lineHeight ? Number(el.lineHeight) : 1.25
              );
              return {
                ...el,
                width,
                height,
                version: el.version + 1,
                versionNonce: Math.floor(Math.random() * 100000),
                updated: Date.now()
              };
            }
            return el;
          });
          excalidrawAPI.updateScene({ elements });
        }
      };

      // Run immediately for instant local font swap
      refreshScene();

      // Also run after a short delay to ensure browser has processed the local font load
      setTimeout(() => {
        if (isCurrent) {
          refreshScene();
        }
      }, 50);
    };

    applyFont();

    return () => {
      isCurrent = false;
    };
  }, [loading, activeCustomFont, excalidrawAPI]);

  // Intercept Excalidraw's built-in font menu to append our "More fonts" section
  useEffect(() => {
    if (loading) return;

    let observer = null;

    const CUSTOM_FONTS = [
      "Inter",
      "Roboto",
      "Montserrat",
      "Playfair Display",
      "Caveat",
      "Pacifico",
      "Fira Code"
    ];

    const interceptFontMenu = () => {
      const dropdown = document.querySelector(".dropdown-menu.fonts");
      if (!dropdown) return;

      const listWrapper = dropdown.querySelector(".ScrollableList__wrapper") || dropdown.querySelector(".dropdown-menu-container") || dropdown;
      if (!listWrapper) return;

      // Temporarily disconnect observer to prevent infinite loops from our own mutations
      if (observer) {
        observer.disconnect();
      }

      try {
        // Find original Excalifont button in the list to trigger click on it and style it
        const buttons = Array.from(listWrapper.querySelectorAll(".dropdown-menu-item, button"));
        let excalifontButton = buttons.find(btn => btn.hasAttribute("data-excalifont-button"));
        
        if (!excalifontButton) {
          excalifontButton = buttons.find(btn => {
            const testId = btn.getAttribute("data-testid");
            const val = btn.getAttribute("value");
            const textEl = btn.querySelector(".dropdown-menu-item__text") || btn;
            const text = textEl.textContent.trim();
            
            return (
              testId === "font-family-hand-drawn" ||
              val === "4" ||
              val === "5" ||
              text.includes("Excalifont") ||
              text.includes("Hand-drawn") ||
              text.includes("Hand-Drawn")
            );
          });
          if (excalifontButton) {
            excalifontButton.setAttribute("data-excalifont-button", "true");
            const textEl = excalifontButton.querySelector(".dropdown-menu-item__text") || excalifontButton;
            excalifontButton.setAttribute("data-original-text", textEl.textContent.trim());
          }
        }

        // Update the Excalifont button text if a custom font is active
        if (excalifontButton) {
          const textEl = excalifontButton.querySelector(".dropdown-menu-item__text") || excalifontButton;
          if (activeCustomFont !== "Excalifont") {
            if (textEl.textContent !== activeCustomFont) {
              textEl.textContent = activeCustomFont;
            }
          } else {
            const originalText = excalifontButton.getAttribute("data-original-text") || "Hand-drawn";
            if (textEl.textContent !== originalText) {
              textEl.textContent = originalText;
            }
          }
        }

        // Add click listeners to other original font buttons to reset activeCustomFont state
        buttons.forEach(btn => {
          if (btn === excalifontButton) return;
          if (btn.classList.contains("dropdown-menu-item-base")) return; // skip custom buttons
          if (!btn.hasAttribute("data-custom-reset-listener")) {
            btn.setAttribute("data-custom-reset-listener", "true");
            btn.addEventListener("click", () => {
              setActiveCustomFont("Excalifont");
            }, true);
          }
        });

        // Check if we already injected our section
        if (dropdown.querySelector(".shivadraw-more-fonts-title")) {
          // Just update selected highlight styles for our custom buttons
          const customButtons = Array.from(dropdown.querySelectorAll(".dropdown-menu-item-base"));
          customButtons.forEach(btn => {
            const btnFont = btn.style.fontFamily.replace(/['"]/g, "").split(",")[0].trim();
            const isActive = activeCustomFont === btnFont;
            if (isActive) {
              if (!btn.classList.contains("dropdown-menu-item--selected")) {
                btn.classList.add("dropdown-menu-item--selected");
              }
              if (excalifontButton && excalifontButton.classList.contains("dropdown-menu-item--selected")) {
                excalifontButton.classList.remove("dropdown-menu-item--selected");
              }
            } else {
              if (btn.classList.contains("dropdown-menu-item--selected")) {
                btn.classList.remove("dropdown-menu-item--selected");
              }
            }
          });
          return;
        }

        // Create "More fonts" title header
        const title = document.createElement("div");
        title.className = "dropdown-menu-group-title shivadraw-more-fonts-title";
        title.textContent = "More fonts";
        title.style.marginTop = "0.75rem";
        listWrapper.appendChild(title);

        // Append custom font buttons
        CUSTOM_FONTS.forEach(fontName => {
          const btn = document.createElement("button");
          btn.className = "dropdown-menu-item dropdown-menu-item-base";
          btn.type = "button";
          btn.style.fontFamily = `"${fontName}", sans-serif`;
          
          // Highlight active status
          const isActive = activeCustomFont === fontName;
          if (isActive) {
            btn.classList.add("dropdown-menu-item--selected");
            // If our custom font is active, Excalifont button shouldn't show active background
            if (excalifontButton) {
              excalifontButton.classList.remove("dropdown-menu-item--selected");
            }
          }

          const textSpan = document.createElement("span");
          textSpan.className = "dropdown-menu-item__text";
          textSpan.textContent = fontName;
          btn.appendChild(textSpan);

          btn.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();

            // Set active custom font
            setActiveCustomFont(fontName);

            // Trigger Excalifont click asynchronously to let React finish current event cycle
            setTimeout(() => {
              if (excalifontButton) {
                excalifontButton.click();
              }
            }, 0);
          });

          listWrapper.appendChild(btn);
        });
      } finally {
        // Reconnect observer
        if (observer) {
          observer.observe(document.body, {
            childList: true,
            subtree: true
          });
        }
      }
    };

    interceptFontMenu();

    observer = new MutationObserver(() => {
      interceptFontMenu();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    return () => {
      observer.disconnect();
    };
  }, [loading, activeCustomFont]);

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

    const observer = new MutationObserver(() => {
      injectCustomShortcuts();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
    };
  }, [loading]);

  // Update canvas scene when active document changes
  useEffect(() => {
    if (!excalidrawAPI || !activeDocId || loading) return;

    if (isInitialMountRef.current) {
      isInitialMountRef.current = false;
      return;
    }

    const activeDoc = documents.find((d) => d.id === activeDocId);
    if (activeDoc) {
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

      // Apply custom background style (solid color) to canvas wrapper
      const finalBg = activeDoc.backgroundStyle || (theme === "dark" ? "#121212" : "#ffffff");
      const wrapper = document.querySelector(".canvas-wrapper");
      if (wrapper) {
        wrapper.style.background = finalBg;
      }

      excalidrawAPI.updateScene({
        elements: activeDoc.elements || [],
        appState: {
          viewBackgroundColor: "transparent",
          currentItemStrokeWidth: 1,
          currentItemRoughness: 0,
          currentItemRoundness: "sharp",
          ...(activeDoc.appState || {}),
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
  }, [activeDocId, excalidrawAPI, loading, documents, theme]);

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

    // Use MutationObserver to ensure the logo is re-injected if Excalidraw re-renders its toolbar
    const observer = new MutationObserver(() => {
      injectLogo();
    });

    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });

    return () => {
      observer.disconnect();
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
  }, [excalidrawAPI]);

  const showToast = (message, type = "success") => {
    setNotification({ message, type });
  };

  // Auto-dismiss notifications
  useEffect(() => {
    if (notification) {
      const timer = setTimeout(() => {
        setNotification(null);
      }, 3000);
      return () => clearTimeout(timer);
    }
  }, [notification]);

  // Toggle application themes
  const toggleTheme = () => {
    const nextTheme = theme === "light" ? "dark" : "light";
    setTheme(nextTheme);
    localStorage.setItem("shivadraw_theme", nextTheme);
    document.documentElement.className = nextTheme === "dark" ? "theme-dark" : "theme-light";
    
    // Update wrapper background style if it's not custom
    const activeDoc = documents.find(d => d.id === activeDocIdRef.current);
    if (!activeDoc || !activeDoc.backgroundStyle) {
      const wrapper = document.querySelector(".canvas-wrapper");
      if (wrapper) {
        wrapper.style.background = nextTheme === "dark" ? "#121212" : "#ffffff";
      }
    }
    
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
      ...appState
    };
    const newDoc = {
      id: `doc-${Date.now()}`,
      title,
      updatedAt: Date.now(),
      elements: clonedElements,
      appState: mergedAppState,
      files
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
  const handleCanvasChange = (elements, appState, files) => {
    // If switching documents or Excalidraw is loading, skip saving to prevent overwrites
    if (isSwitchingRef.current) return;

    setSaveStatus("saving");

    // Filter out deleted elements to save memory
    const activeElements = elements.filter(el => !el.isDeleted);
    latestDataRef.current = { elements: activeElements, appState: sanitizeAppState(appState), files };

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    saveTimeoutRef.current = setTimeout(() => {
      const currentActiveId = activeDocIdRef.current;
      if (!currentActiveId) {
        setSaveStatus("saved");
        return;
      }

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
        const activeFiles = (excalidrawAPI && excalidrawAPI.getFiles) ? excalidrawAPI.getFiles() : {};
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

        return updatedDocs;
      });
    }, 1000); // 1-second debounce
  };

  // Handle smoothing on pointer up (when drawing ends)
  const handlePointerUp = (activeTool) => {
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
  };




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

  // Copy canvas drawing as PNG to clipboard
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

  // Export board to a local .json file
  const exportBoard = () => {
    const activeDoc = documents.find(d => d.id === activeDocId);
    if (!activeDoc) return;

    const dataStr = JSON.stringify({
      version: 1,
      title: activeDoc.title,
      elements: activeDoc.elements,
      appState: activeDoc.appState || {},
      files: activeDoc.files || {}
    }, null, 2);

    const dataUri = 'data:application/json;charset=utf-8,'+ encodeURIComponent(dataStr);
    const exportFileDefaultName = `${activeDoc.title.replace(/\s+/g, "_")}.json`;

    const linkElement = document.createElement('a');
    linkElement.setAttribute('href', dataUri);
    linkElement.setAttribute('download', exportFileDefaultName);
    linkElement.click();
    showToast("Drawing JSON exported");
  };

  // Import board from a .json file
  const handleImport = (e) => {
    const fileReader = new FileReader();
    const file = e.target.files[0];
    if (!file) return;

    fileReader.onload = (event) => {
      try {
        const parsed = JSON.parse(event.target.result);
        if (parsed && Array.isArray(parsed.elements)) {
          createNewBoard(parsed.title || "Imported Board", parsed.elements, parsed.appState || {}, parsed.files || {});
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

  // Formatting date for document lists
  const formatTime = (timestamp) => {
    const d = new Date(timestamp);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' ' + d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  };

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
          
          {/* Default Font Selector */}
          <div style={{ display: "flex", flexDirection: "column", gap: "calc(0.25rem * var(--ui-scale))", padding: "calc(0.25rem * var(--ui-scale)) 0" }}>
            <span style={{ fontSize: "calc(0.75rem * var(--ui-scale))", color: "var(--text-secondary)" }}>Default Font</span>
            <select 
              value={activeCustomFont} 
              onChange={(e) => setActiveCustomFont(e.target.value)}
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
              <option value="Excalifont">Excalifont (Default)</option>
              <option value="Inter">Inter</option>
              <option value="Roboto">Roboto</option>
              <option value="Montserrat">Montserrat</option>
              <option value="Playfair Display">Playfair Display</option>
              <option value="Caveat">Caveat</option>
              <option value="Pacifico">Pacifico</option>
              <option value="Fira Code">Fira Code</option>
            </select>
          </div>
          
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

          <div className="settings-row" style={{ marginTop: "calc(0.5rem * var(--ui-scale))" }}>
            <span style={{ fontSize: "calc(0.75rem * var(--ui-scale))" }}>Theme Mode</span>
            <button className="theme-toggle-btn" onClick={toggleTheme} title="Toggle Theme Mode">
              {theme === "light" ? "🌙" : "☀️"}
            </button>
          </div>

          <div className="settings-row" style={{ marginTop: "calc(0.5rem * var(--ui-scale))" }}>
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
          <button className="btn-secondary" onClick={exportBoard} title="Export board as Shiva Canvas JSON file">
            <span>📤</span> Export JSON
          </button>
          <button className="btn-secondary" onClick={() => exportAsImage("png")} title="Export drawing as PNG image">
            <span>🖼️</span> Export PNG
          </button>
          <button className="btn-secondary" onClick={copyToClipboard} title="Copy drawing as PNG image to clipboard">
            <span>📋</span> Copy to Clipboard
          </button>
          <button className="btn-secondary" onClick={() => exportAsImage("svg")} title="Export drawing as SVG vector file">
            <span>🌐</span> Export SVG
          </button>
          <button className="btn-secondary" onClick={() => fileInputRef.current.click()} title="Import a Shiva Canvas JSON file">
            <span>📥</span> Import JSON
          </button>
          <button className="btn-secondary" onClick={resetBoard} title="Clear the entire canvas">
            <span>🗑️</span> Reset Canvas
          </button>
        </div>



        <input
          type="file"
          ref={fileInputRef}
          style={{ display: "none" }}
          accept=".json"
          onChange={handleImport}
        />
      </aside>

      {/* Main Canvas Component Area */}
      <main className="canvas-wrapper">


        <div style={{ width: "100%", height: "100%", position: "relative" }}>
          {/* Excalidraw container */}
          {!loading && (
            <Excalidraw
              excalidrawAPI={(api) => setExcalidrawAPI(api)}
              theme={theme}
              initialData={initialDataRef.current}
              onChange={handleCanvasChange}
              onPointerUp={handlePointerUp}
            >
              <MainMenu>
                <MainMenu.DefaultItems.LoadScene />
                <MainMenu.DefaultItems.SaveToActiveFile />
                <MainMenu.DefaultItems.Export />
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

      {/* Floating Vertical Brand Watermark */}
      <div 
        className="vertical-brand-watermark"
        style={{
          fontSize: watermarkSize !== "0" ? `${watermarkSize}rem` : undefined,
          right: watermarkSize !== "0" ? `calc(15px + ${watermarkSize}rem / 2)` : undefined,
          display: watermarkSize === "0" ? "none" : "block"
        }}
      >
        SHIVA
      </div>
    </div>
  );
}

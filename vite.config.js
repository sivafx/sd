import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => ({
  base: "./",
  plugins: [react()],
  define: {
    // Let Vite set NODE_ENV correctly per mode (production build = production React)
    // Only define IS_PREACT which Excalidraw requires
    "process.env.IS_PREACT": JSON.stringify("false"),
    // Polyfill process.env.NODE_ENV for Excalidraw internals that reference it directly
    "process.env.NODE_ENV": JSON.stringify(mode === "production" ? "production" : "development"),
  },
  build: {
    target: "esnext",
    minify: "esbuild",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules")) {
            if (id.includes("@excalidraw/excalidraw")) {
              return "vendor-excalidraw";
            }
            if (id.includes("react") || id.includes("react-dom")) {
              return "vendor-react";
            }
            return "vendor-libs";
          }
        },
      },
    },
  },
}));

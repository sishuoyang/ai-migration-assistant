import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Served behind `/dashboard/` on the main playground hostname so it
// can coexist with LibreChat at `/` until Phase 4 rewires nginx.
export default defineConfig({
  plugins: [react()],
  base: "/dashboard/",
  server: {
    port: 5173,
    proxy: {
      // For local `npm run dev`, route API calls to the host-exposed
      // migration-runner port. In the container build this proxy isn't
      // used — the main nginx handles the same routing.
      "/api/mk": {
        target: "http://localhost:8006",
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api\/mk/, "/api"),
      },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: false,
  },
});

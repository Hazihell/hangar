import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"

// In development /api goes to the Dashboard server (or `npm run mock`).
const apiPort = process.env.HANGAR_DASHBOARD_PORT ?? "4318"
const apiOrigin = `http://127.0.0.1:${apiPort}`

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": resolve(import.meta.dirname, "./src"),
    },
  },
  server: {
    proxy: {
      // The server takes commands only from its own origin (API.md): present them
      // as coming from it, Host and Origin both, as the built page does.
      "/api": {
        target: apiOrigin,
        changeOrigin: true,
        configure: (proxy) => {
          proxy.on("proxyReq", (req) => {
            if (req.getHeader("origin")) req.setHeader("origin", apiOrigin)
          })
        },
      },
    },
  },
  build: {
    outDir: "dist",
  },
})

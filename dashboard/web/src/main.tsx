import { StrictMode } from "react"
import { createRoot } from "react-dom/client"

import "./index.css"
import App from "./App.tsx"

// The service worker shows Alerts and, when the server can't be reached at all
// (Stormtrooper asleep or off), a page that says so. Registered on every load
// so an updated sw.js is picked up; it never caches the Dashboard itself.
if ("serviceWorker" in navigator && window.isSecureContext) {
  navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" }).catch(() => {})
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
)

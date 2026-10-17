// The Dashboard's service worker. It shows Alerts the server pushes
// (dashboard/API.md, "## Alerts") and, when one is clicked, brings the
// Dashboard up at that Machine. Its only cache is one page, offline.html,
// shown when a page load can't reach the server at all: the Dashboard runs on
// Stormtrooper, so while it's asleep or off there is nothing else to load.
// Everything else, /api/* above all, always goes to the network, uncached.
//
// Change VERSION whenever this file or offline.html changes: a new sw.js
// installs, skips waiting and takes over open pages at once.

const VERSION = 2
const CACHE = `hangar-offline-v${VERSION}`
const OFFLINE = "/offline.html"

/** Puts offline.html in this version's cache; rejects if it can't be fetched. */
async function cacheOffline() {
  const cache = await caches.open(CACHE)
  await cache.add(new Request(OFFLINE, { cache: "reload" }))
}

self.addEventListener("install", (event) => {
  // No fallback page, no install: the browser tries again on a later load,
  // and the previous worker (if any) keeps serving, its fallback included.
  event.waitUntil(cacheOffline().then(() => self.skipWaiting()))
})

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      // Older fallbacks go only once this version's is in place.
      if (await caches.match(OFFLINE, { cacheName: CACHE })) {
        for (const name of await caches.keys()) if (name !== CACHE && name.startsWith("hangar-")) await caches.delete(name)
      }
      // Page loads start while the worker wakes up, so the fetch handler costs nothing.
      await self.registration.navigationPreload?.enable().catch(() => {})
      await self.clients.claim()
    })()
  )
})

/** Answers from the server can't come: no network path, or the proxy in front says the server is gone. */
const GONE = new Set([502, 503, 504])

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET" || request.mode !== "navigate") return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return
  event.respondWith(
    (async () => {
      try {
        const response = (await event.preloadResponse) ?? (await fetch(request))
        if (!GONE.has(response.status)) {
          // The server is there: if the fallback went missing (storage cleared), put it back.
          if (response.ok) event.waitUntil(ensureOffline())
          return response
        }
        return (await fallback()) ?? response
      } catch {
        return (await fallback()) ?? Response.error()
      }
    })()
  )
})

/** This version's fallback, else any older one still kept. */
async function fallback() {
  return (await caches.match(OFFLINE, { cacheName: CACHE })) ?? (await caches.match(OFFLINE))
}

async function ensureOffline() {
  if (await caches.match(OFFLINE, { cacheName: CACHE })) return
  await cacheOffline().catch(() => {})
}

/** The payload as the server sends it; anything else still shows something. */
function readPayload(data) {
  if (!data) return {}
  try {
    const value = data.json()
    return value && typeof value === "object" ? value : { body: String(value) }
  } catch {
    return { body: data.text() }
  }
}

self.addEventListener("push", (event) => {
  const payload = readPayload(event.data)
  const quiet = payload.quiet === true
  const tag = typeof payload.tag === "string" && payload.tag ? payload.tag : undefined
  const options = {
    body: typeof payload.body === "string" ? payload.body : "",
    icon: "/icon-192.png",
    badge: "/badge-96.png",
    silent: quiet,
    data: { machine: typeof payload.machine === "string" ? payload.machine : null },
  }
  if (tag) {
    options.tag = tag
    // A new Alert with the tag of an old one alerts again; its quiet "back to normal" replacement doesn't.
    options.renotify = !quiet
  }
  const title = typeof payload.title === "string" && payload.title ? payload.title : "Hangar"
  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const machine = event.notification.data?.machine
  const url = new URL(machine ? `/#${encodeURIComponent(machine)}` : "/", self.location.origin).href
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true })
      const open = windows.find((c) => new URL(c.url).origin === self.location.origin)
      if (open) {
        await open.focus().catch(() => {})
        // The page scrolls to the Machine and rings it briefly.
        open.postMessage({ type: "show-machine", machine })
        return
      }
      await self.clients.openWindow(url)
    })()
  )
})

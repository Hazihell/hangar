// The Dashboard's service worker: push-only. It shows Alerts the server pushes
// (dashboard/API.md, "## Alerts") and, when one is clicked, brings the
// Dashboard up at that Machine. No caching, no fetch handler: the page always
// loads from the network.

self.addEventListener("install", () => {
  self.skipWaiting()
})

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim())
})

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

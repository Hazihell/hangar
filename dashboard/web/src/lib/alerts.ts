import { JSON_HEADERS, readMessage } from "@/lib/http"

/**
 * Alerts for this browser (API.md `## Alerts`): a push subscription the server
 * sends Alerts to, through the push-only service worker at `/sw.js`.
 */

export type Support = "ok" | "insecure" | "unsupported"

/** Push needs a secure context (https, or localhost) and a browser that does it. */
export function pushSupport(): Support {
  if (typeof window === "undefined") return "unsupported"
  if (!window.isSecureContext) return "insecure"
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) return "unsupported"
  return "ok"
}

/** Something the page can say about why Alerts couldn't be changed. */
export class AlertsError extends Error {}

const FETCH_MS = 10_000

async function call(path: string, init: RequestInit & { json?: unknown } = {}): Promise<Response> {
  const { json, ...rest } = init
  try {
    return await fetch(path, {
      ...rest,
      ...(json !== undefined ? { headers: JSON_HEADERS, body: JSON.stringify(json) } : {}),
      signal: AbortSignal.timeout(FETCH_MS),
    })
  } catch {
    throw new AlertsError("Couldn’t reach the server.")
  }
}

async function refusal(res: Response, fallback: string): Promise<AlertsError> {
  if (res.status === 403) return new AlertsError("The server only takes this from the Dashboard’s own address.")
  const said = await res.text().then(readMessage, () => null)
  return new AlertsError(said ? `${fallback} ${said}` : `${fallback} (HTTP ${res.status})`)
}

async function serverKey(): Promise<Uint8Array<ArrayBuffer>> {
  const res = await call("/api/alerts/key", { cache: "no-store" })
  if (!res.ok) throw await refusal(res, "The server has no key for Alerts.")
  const body = (await res.json().catch(() => null)) as { publicKey?: string } | null
  if (typeof body?.publicKey !== "string") throw new AlertsError("The server’s key for Alerts couldn’t be read.")
  return fromBase64Url(body.publicKey)
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=")
  const raw = atob(base64)
  const bytes = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i)
  return bytes
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a || a.byteLength !== b.byteLength) return false
  const view = new Uint8Array(a)
  return view.every((v, i) => v === b[i])
}

async function register(subscription: PushSubscription): Promise<void> {
  const res = await call("/api/alerts/subscriptions", { method: "POST", json: subscription.toJSON() })
  // The server only pushes to the known push services (FCM, Mozilla, Apple, WNS).
  if (res.status === 400) throw new AlertsError("This browser’s push service isn’t one the Dashboard supports.")
  if (res.status === 503) throw new AlertsError("Alerts are turned off on the server.")
  if (!res.ok) throw await refusal(res, "The server didn’t take the subscription.")
}

async function existing(): Promise<PushSubscription | null> {
  const registration = await navigator.serviceWorker.getRegistration("/")
  return (await registration?.pushManager.getSubscription()) ?? null
}

/**
 * Set when Alerts were turned off but the browser kept its subscription (only
 * the server forgot it), so the next load doesn't hand it back to the server.
 */
const TURNED_OFF = "hangar:alerts-off"

function remember(off: boolean) {
  try {
    if (off) localStorage.setItem(TURNED_OFF, "1")
    else localStorage.removeItem(TURNED_OFF)
  } catch {
    // Storage unavailable: nothing to remember with.
  }
}

const turnedOff = () => {
  try {
    return localStorage.getItem(TURNED_OFF) === "1"
  } catch {
    return false
  }
}

/** On: subscribed and allowed. Off: not subscribed. Blocked: notifications denied for this site. */
export type AlertsStatus = "on" | "off" | "blocked"

async function subscribe(registration: ServiceWorkerRegistration, key: Uint8Array<ArrayBuffer>): Promise<PushSubscription> {
  try {
    return await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  } catch (error) {
    const name = error instanceof DOMException ? error.name : ""
    throw new AlertsError(
      name === "NotAllowedError"
        ? "The browser refused to subscribe to push messages."
        : name === "AbortError"
          ? "The browser’s push service couldn’t be reached. Try again in a moment."
          : "The browser couldn’t subscribe to push messages."
    )
  }
}

/**
 * Where this browser stands. A subscription found on load is sent to the
 * server again (it replaces itself), and renewed if the server's key changed,
 * so the server knows it even after losing its list. "on" only once the server
 * has taken it; if that fails, throws an AlertsError saying why (Alerts may
 * not arrive, and turning them on again is the retry).
 */
export async function currentStatus(): Promise<AlertsStatus> {
  if (Notification.permission === "denied") return "blocked"
  const subscription = await existing()
  if (!subscription || Notification.permission !== "granted" || turnedOff()) return "off"
  try {
    const key = await serverKey()
    if (sameKey(subscription.options.applicationServerKey, key)) {
      await register(subscription)
    } else {
      await subscription.unsubscribe().catch(() => false)
      const registration = await navigator.serviceWorker.ready
      await register(await subscribe(registration, key))
    }
  } catch (error) {
    const reason = error instanceof AlertsError ? ` ${error.message}` : ""
    throw new AlertsError(`Alerts couldn’t be renewed, so they may not arrive.${reason}`)
  }
  return "on"
}

/**
 * Turns Alerts on: asks for permission (call from a click), registers the
 * service worker, subscribes with the server's key and hands the subscription
 * to the server. Resolves to "blocked" if permission is refused.
 */
export async function turnOn(): Promise<AlertsStatus> {
  const permission = await Notification.requestPermission()
  if (permission === "denied") return "blocked"
  if (permission !== "granted") throw new AlertsError("Notifications weren’t allowed, so Alerts stay off.")

  const key = await serverKey()
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/", updateViaCache: "none" })
  } catch {
    throw new AlertsError("The browser couldn’t install the Dashboard’s service worker.")
  }
  const registration = await navigator.serviceWorker.ready

  let subscription = await registration.pushManager.getSubscription()
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await subscribe(registration, key)
  try {
    await register(subscription)
  } catch (error) {
    await subscription.unsubscribe().catch(() => {})
    throw error
  }
  remember(false)
  return "on"
}

/**
 * Turns Alerts off for this browser: tells the server, then unsubscribes.
 * Either one stops them (after an unsubscribe the push service answers the
 * server's next send with 410 and it forgets this browser); if both fail,
 * throws an AlertsError.
 */
export async function turnOff(): Promise<AlertsStatus> {
  const subscription = await existing()
  if (subscription) {
    const res = await call("/api/alerts/subscriptions", {
      method: "DELETE",
      json: { endpoint: subscription.endpoint },
    }).catch(() => null)
    const unsubscribed = await subscription.unsubscribe().catch(() => false)
    if (res?.status !== 204 && !unsubscribed) {
      throw new AlertsError("Alerts couldn’t be turned off: neither the server nor the browser took it. Try again.")
    }
    remember(!unsubscribed)
  }
  return Notification.permission === "denied" ? "blocked" : "off"
}

/** Asks the server to push a test Alert to this browser. */
export async function sendTest(): Promise<void> {
  const subscription = await existing()
  if (!subscription) throw new AlertsError("This browser isn’t subscribed any more. Turn Alerts on again.")
  let res = await call("/api/alerts/test", { method: "POST", json: { endpoint: subscription.endpoint } })
  if (res.status === 404) {
    // The server forgot this browser: hand it the subscription again and retry once.
    await register(subscription)
    res = await call("/api/alerts/test", { method: "POST", json: { endpoint: subscription.endpoint } })
  }
  if (res.status === 502) throw await refusal(res, "The push service refused the test.")
  if (!res.ok) throw await refusal(res, "The server couldn’t send the test.")
}

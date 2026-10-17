/** The JSON Content-Type the server requires on every command (a CSRF guard). */
export const JSON_HEADERS = { "content-type": "application/json" }

/** A short message from a response body: plain text, or JSON `error`/`message`. */
export function readMessage(body: string): string | null {
  let text = body.trim()
  if (!text) return null
  if (text.startsWith("{")) {
    try {
      const value = JSON.parse(text)
      text = typeof value?.message === "string" ? value.message : typeof value?.error === "string" ? value.error : ""
    } catch {
      return null
    }
  }
  if (!text || text.length > 200 || text.startsWith("<")) return null
  const sentence = text[0].toUpperCase() + text.slice(1)
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`
}

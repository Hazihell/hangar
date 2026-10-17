import { JSON_HEADERS, readMessage } from "@/lib/http"

export class MachineCommandError extends Error {}

/** Sends once; acceptance is not completion. Machine events carry the outcome. */
export async function postCommand(
  path: string,
  body: unknown,
  words: {
    refusals: Record<number, string>
    fallback: string
    timeout?: number
  }
): Promise<Response> {
  let response: Response
  try {
    response = await fetch(path, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(words.timeout ?? 10_000),
    })
  } catch {
    throw new MachineCommandError("Couldn’t reach the server.")
  }
  if (response.ok) return response
  const message = await response.text().then(readMessage, () => null)
  throw new MachineCommandError(
    message ??
      words.refusals[response.status] ??
      `${words.fallback} (HTTP ${response.status}).`
  )
}

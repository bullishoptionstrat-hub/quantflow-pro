import { apiFetch } from './apiFetch'

/**
 * The three ways a panel can have nothing to draw, kept apart.
 *
 * "No data" is not an answer — it collapses a signed-out session, a
 * deployment with no key for the source, and a backend that did not respond
 * into one message, and only one of the three is something the reader can act
 * on. The flow feed and the ticker tape already distinguish them; this is the
 * same distinction, factored out, because the news page has three independent
 * endpoints behind three panels and each can be in a different state.
 *
 * `ok` with an empty list is deliberately a fourth case rather than a variant
 * of the others: the backend answered, and what it said was that the source
 * is reporting nothing.
 */
export type Panel<T> =
  /** Nothing fetched yet. Draw nothing rather than guessing. */
  | { status: 'loading' }
  /** The backend refused us — no session, or demo mode is off. */
  | { status: 'unauthorized' }
  /** We reached the backend. `data` may still be empty. */
  | { status: 'ok'; data: T }
  /** We did not reach the backend. */
  | { status: 'unreachable' }

/**
 * Fetch one panel's endpoint and classify the outcome.
 *
 * `select` pulls the panel's list out of the response envelope. It is a
 * parameter rather than an assumption because these routes wrap their arrays
 * (`{ headlines }`, `{ earnings }`, `{ reddit }`) and the page that read them
 * tested `Array.isArray(body)` against the envelope — always false, so three
 * panels silently fell through to hardcoded content on every deployment,
 * including ones whose feeds were working.
 *
 * A 401 body is valid JSON and parses happily, which is why the status is
 * checked before the body: `Promise.allSettled` reports a refusal as
 * `fulfilled` and a bare `catch {}` erases the difference from an outage.
 */
export async function loadPanel<T>(path: string, select: (body: unknown) => T): Promise<Panel<T>> {
  try {
    const res = await apiFetch(path)
    if (res.status === 401 || res.status === 403) return { status: 'unauthorized' }
    if (!res.ok) return { status: 'unreachable' }
    return { status: 'ok', data: select(await res.json()) }
  } catch {
    // A network failure, or a body that was not JSON. Either way we did not
    // get an answer, and inventing one is what this file exists to prevent.
    return { status: 'unreachable' }
  }
}

/** Read `key` off a response envelope as an array, or an empty one. */
export function listAt<T>(body: unknown, key: string): T[] {
  const v = (body as Record<string, unknown> | null | undefined)?.[key]
  return Array.isArray(v) ? (v as T[]) : []
}

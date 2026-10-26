/**
 * A backend request that never answers is abandoned, so the panel waiting on
 * it says "unreachable" instead of "loading" forever.
 *
 * `apiFetch` called `fetch` with no limit. A request the network swallowed
 * never settled, and a page that loads once (rather than polling) stayed on
 * its loading state for good.
 */
import { expect, test, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}))

const hung = vi.fn((_input: unknown, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    const s = init?.signal
    if (s?.aborted) return reject(s.reason)
    s?.addEventListener('abort', () => reject(s.reason), { once: true })
  }),
)

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', hung)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  hung.mockClear()
})

test('a request that never answers rejects after the limit', async () => {
  const { apiFetch, API_TIMEOUT_MS } = await import('@/lib/apiFetch')
  const p = apiFetch('/api/health')
  const settled = expect(p).rejects.toThrow(/did not answer within 60s/)
  await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS + 1)
  await settled
})

test('a panel waiting on it reports unreachable, not loading', async () => {
  const { loadPanel } = await import('@/lib/panel')
  const { API_TIMEOUT_MS } = await import('@/lib/apiFetch')
  const p = loadPanel('/api/health', (b) => b)
  await vi.advanceTimersByTimeAsync(API_TIMEOUT_MS + 1)
  expect(await p).toEqual({ status: 'unreachable' })
})

test('the limit is longer than a cold start', async () => {
  // Render's free tier wakes in well under a minute; a shorter limit would
  // turn every first request after a sleep into "unreachable".
  const { API_TIMEOUT_MS } = await import('@/lib/apiFetch')
  expect(API_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
})

test("a caller's own abort still reaches the request", async () => {
  const { apiFetch } = await import('@/lib/apiFetch')
  const ctl = new AbortController()
  const p = apiFetch('/api/health', { signal: ctl.signal })
  const settled = expect(p).rejects.toThrow(/caller gave up/)
  ctl.abort(new Error('caller gave up'))
  await settled
})

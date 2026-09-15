/**
 * A source can be `connected` and wrong, and the board said `✓ LIVE` to it.
 *
 * The backend has had a "connected but degraded" channel since the FRED
 * partial-failure fix: `sourceNotes` carries Polygon's missing-NBBO case, the
 * unparsed-frame counters, and — since the entitlement probe — a line saying
 * the vendor refuses the key of a source that is otherwise contributing.
 *
 * Nothing in the browser had ever read it. `grep -rn sourceNotes frontend/`
 * returned nothing at all, so three states were rendered from a payload that
 * carried four, and the fourth was the one that says "this is arriving and it
 * is qualified". Polygon can stream trades with every NBBO lookup refused —
 * every print non-directional — and the settings page reported it in green.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

function mockApi(health: unknown) {
  vi.doMock('@/lib/apiFetch', () => ({
    apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => health })),
  }))
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.clearAllMocks())

const health = (ingestion: Record<string, unknown>) => ({ ingestion })

describe('a contributing source that carries a note is not plainly live', () => {
  test('an entitlement refusal on a connected source shows DEGRADED, not LIVE', async () => {
    // The exact shape this deployment produces: the poller owns `sources` and
    // reports what the request returned, while the entitlement probe answers a
    // question no poller asks. Both are true at once.
    mockApi(health({
      sources: { polygon: 'connected' },
      sourceErrors: {},
      sourceNotes: { polygon: 'entitlement refused: HTTP 403 — NOT_AUTHORIZED' },
    }))
    const Page = (await import('@/app/settings/page')).default
    render(<Page />)

    await waitFor(() => expect(screen.getByText('polygon')).toBeTruthy())
    const body = document.body.textContent ?? ''
    expect(body).toMatch(/DEGRADED/)
    expect(body).not.toMatch(/✓ LIVE/)
    // And the backend's own words reach the reader, not a paraphrase.
    expect(body).toMatch(/NOT_AUTHORIZED/)
  })

  test('a clean connected source is still plainly live', async () => {
    // The badge must not become permanently amber: a degraded marker that is
    // always on is a marker nobody reads.
    mockApi(health({
      sources: { fred: 'connected' }, sourceErrors: {}, sourceNotes: {},
    }))
    const Page = (await import('@/app/settings/page')).default
    render(<Page />)

    await waitFor(() => expect(screen.getByText('fred')).toBeTruthy())
    const body = document.body.textContent ?? ''
    expect(body).toMatch(/✓ LIVE/)
    expect(body).not.toMatch(/DEGRADED/)
  })

  test('a note is rendered even when the source is not connected', async () => {
    // `sourceNotes` and `sourceErrors` answer different questions — why
    // nothing is arriving, versus a qualification on what is — and a source
    // can carry both. Concatenating them would lose that.
    mockApi(health({
      sources: { polygon: 'error' },
      sourceErrors: { polygon: 'HTTP 403 — the trades feed is refused' },
      sourceNotes: { polygon: 'NBBO lookups unavailable; 4 stream frame(s) could not be parsed' },
    }))
    const Page = (await import('@/app/settings/page')).default
    render(<Page />)

    await waitFor(() => expect(screen.getByText('polygon')).toBeTruthy())
    const body = document.body.textContent ?? ''
    expect(body).toMatch(/the trades feed is refused/)
    expect(body).toMatch(/could not be parsed/)
    expect(body).toMatch(/ERROR/)
  })

  test('a missing sourceNotes block does not break the board', async () => {
    // An older backend, or one that has not finished its first sweep, sends no
    // such key. The page predates the field and must survive its absence.
    mockApi(health({ sources: { yahoo: 'refused' }, sourceErrors: {} }))
    const Page = (await import('@/app/settings/page')).default
    render(<Page />)

    await waitFor(() => expect(screen.getByText('yahoo')).toBeTruthy())
    expect(document.body.textContent).toMatch(/REFUSED/)
  })
})

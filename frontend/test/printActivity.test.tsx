/**
 * `connected` says a connector ran; the Settings page now also says whether
 * prints arrived, from the backend's `printActivity`, and only where the
 * backend reported some. A source absent from it is not shown as zero: FRED and
 * CoinGecko never send prints, and an older backend omits the key.
 */
import { expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'

function mockApi(health: unknown) {
  vi.doMock('@/lib/apiFetch', () => ({
    apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => health })),
  }))
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.clearAllMocks())

test('a source with accepted prints shows the count and the last receipt time', async () => {
  mockApi({ ingestion: {
    sources: { tradier: 'connected', fred: 'connected' }, sourceErrors: {}, sourceNotes: {},
    printActivity: { tradier: { accepted: 1234, lastAcceptedAt: '2026-10-26T14:30:05.000Z' } },
  } })
  const Page = (await import('@/app/settings/page')).default
  render(<Page />)
  await waitFor(() => expect(screen.getByText('tradier')).toBeTruthy())
  const body = document.body.textContent ?? ''
  expect(body).toMatch(/1,234 print\(s\) accepted · last 10:30:05 ET/)
  // FRED sends no prints: nothing about prints is said for it.
  expect(body.match(/print\(s\) accepted/g)?.length).toBe(1)
})

test('a backend without printActivity renders no activity line', async () => {
  mockApi({ ingestion: { sources: { tradier: 'connected' }, sourceErrors: {}, sourceNotes: {} } })
  const Page = (await import('@/app/settings/page')).default
  render(<Page />)
  await waitFor(() => expect(screen.getByText('tradier')).toBeTruthy())
  expect(document.body.textContent ?? '').not.toMatch(/accepted/)
})

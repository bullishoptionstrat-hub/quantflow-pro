/**
 * Replay → outcome → ticket, end to end on ENGINE output.
 *
 * `backend/test/fixtures/setupReplayEpisodes.json` is the CLI's report over the
 * planted-episode fixture (`backend/tools/fixtures/syntheticEpisodes.ts`): the
 * one recorded input on which ideas reach ACTIONABLE. Before it, the ticket
 * link had only run on a hand-built idea, and that is how the link's reading
 * of `target` as a bare number — the engine publishes `{ name, price }` —
 * refused every real idea without anyone seeing it.
 *
 * Synthetic data: nothing here is evidence about the rules or about markets.
 */
import { describe, expect, test, vi, afterEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseIdeaLink, type IdeaPrefill } from '@/lib/replayIdea'
import type { MarketSession } from '@/lib/marketSession'

const CLOCK = vi.hoisted(() => ({
  session: {
    state: 'OPEN', date: '2026-11-09', nowMinutesEt: 600, openMinutesEt: 570, closeMinutesEt: 960,
    basis: 'test', source: 'test', readAt: '2026-11-06', coverage: { from: '2026-01-01', to: '2027-12-31' },
  } as unknown,
}))
vi.mock('@/lib/marketSession', async (orig) => ({
  ...(await orig<typeof import('@/lib/marketSession')>()),
  useMarketSession: () => ({ panel: { status: 'ok', data: CLOCK.session as MarketSession }, sources: { status: 'loading' } }),
}))

const episodes = JSON.parse(readFileSync(join(__dirname, '..', '..', 'backend', 'test', 'fixtures', 'setupReplayEpisodes.json'), 'utf8'))
type Idea = { ideaId: string; history: { state: string }[]; target: { price: number } | null; entry: number | null; invalidation: number }
const ideas: Idea[] = episodes.report.runs.flatMap((r: { ideas: Idea[] }) => r.ideas)
const actionable = ideas.filter((i) => i.history.some((t) => t.state === 'ACTIONABLE'))

async function renderReplay() {
  vi.doMock('@/lib/apiFetch', () => ({ apiFetch: vi.fn(async () => ({ ok: true, status: 200, json: async () => episodes })) }))
  const { SetupReplay } = await import('@/components/setups/SetupReplay')
  render(<SetupReplay />)
  const set = (l: string, v: string) => fireEvent.change(screen.getByLabelText(l), { target: { value: v } })
  set('Symbol A', 'SPY'); set('Symbol B', 'QQQ'); set('Timestamp convention', 'OPEN'); set('Round-trip cost per unit', '0.02')
  for (const l of ['CSV for A', 'CSV for B']) fireEvent.change(screen.getByLabelText(l), { target: { files: [new File(['t\n'], 'b.csv')] } })
  await waitFor(() => expect((screen.getByText('REPLAY') as HTMLButtonElement).disabled).toBe(false))
  fireEvent.click(screen.getByText('REPLAY'))
}

describe('the episode replay reaches the ticket', () => {
  afterEach(() => { vi.doUnmock('@/lib/apiFetch'); vi.resetModules(); window.history.replaceState(null, '', '/') })

  test('the recorded report has ACTIONABLE ideas with an engine-shaped target', () => {
    expect(actionable.length).toBeGreaterThanOrEqual(5)
    for (const i of actionable) expect(typeof i.target?.price).toBe('number')
  })

  test('every ACTIONABLE engine idea gets a ticket link carrying its own numbers', async () => {
    await renderReplay()
    await waitFor(() => expect(screen.getAllByTestId('idea-ticket-link').length).toBe(actionable.length))
    const links = screen.getAllByTestId('idea-ticket-link').map((a) => parseIdeaLink(new URL(a.getAttribute('href')!, 'http://x').searchParams) as IdeaPrefill)
    for (const p of links) {
      const src = actionable.find((i) => i.ideaId === p.ideaId)!
      expect(src).toBeTruthy()
      expect(p.entry).toBe(src.entry)
      expect(p.stop).toBe(src.invalidation)
      expect(p.target).toBe(src.target!.price)
    }
  })

  test('the outcome summary is suppressed below the floor and says why', async () => {
    await renderReplay()
    await waitFor(() => expect(screen.getByText(/INSUFFICIENT_SAMPLE/)).toBeTruthy())
    expect(screen.queryByText(/target first \d/)).toBeNull()
  })

  test('opening one fills the ticket and answers no gate', async () => {
    await renderReplay()
    await waitFor(() => expect(screen.getAllByTestId('idea-ticket-link').length).toBeGreaterThan(0))
    const href = screen.getAllByTestId('idea-ticket-link')[0]!.getAttribute('href')!
    const { cleanup } = await import('@testing-library/react')
    cleanup()
    window.localStorage.clear()
    window.history.replaceState(null, '', href)
    const { default: TicketPage } = await import('@/app/ticket/page')
    render(<TicketPage />)
    const p = parseIdeaLink(new URL(href, 'http://x').searchParams) as IdeaPrefill
    await waitFor(() => expect((screen.getByLabelText('SETUP / IDEA ID') as HTMLInputElement).value).toBe(p.ideaId))
    expect((screen.getByLabelText('TP1 PRICE') as HTMLInputElement).value).toBe(String(p.target))
    expect(screen.queryAllByRole('button', { name: /: pass$/ }).every((b) => b.getAttribute('aria-pressed') !== 'true')).toBe(true)
    expect(screen.getByTestId('ticket-state').textContent).not.toMatch(/APPROVED/)
  })
})

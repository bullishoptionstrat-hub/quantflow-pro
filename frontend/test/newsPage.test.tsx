/**
 * The news page, which invented its own newsroom.
 *
 * All three panels fell back to hardcoded content, and two of them fell back
 * on every deployment: the fetch tested `Array.isArray(body)` against
 * `{ headlines: [...] }` and `{ earnings: [...] }`, so the live arrays were
 * never populated even with keys configured. What filled the gap was six
 * headlines attributed by name to Reuters, Bloomberg, CNBC, MarketWatch, the
 * WSJ and Barron's, six quoted Reddit posts, and five earnings dates with EPS
 * estimates to the cent — all in the same markup as live rows.
 *
 * The backend suite can assert the route now sends one normalized shape
 * (`newsWire.test.ts`) and that no `FALLBACK` const survives a source scan.
 * Neither can assert that a real Reddit record renders as anything but
 * "undefined% bull" and a gauge at `width: NaN%`, which is what the previous
 * interface would have produced the first time a key existed. That is the gap
 * this file closes.
 *
 * The empty-state cases render against the responses recorded from a running
 * keyless backend in `backend/test/fixtures/` — which is what every deployment
 * without a NewsAPI, Reddit or FMP key actually receives. Populated cases use
 * literals typed as the wire interfaces in `lib/types.ts`, because a capture
 * from a keyless box cannot record a populated one and hand-writing a fixture
 * would be inventing the recording.
 */
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { NewsItem, RedditSentiment, EarningsEvent } from '@/lib/types'

const FIX = join(__dirname, '..', '..', 'backend', 'test', 'fixtures')
const fixture = (n: string) => JSON.parse(readFileSync(join(FIX, `${n}.json`), 'utf8'))

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body })
const refused = () => ({ ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) })
const down = () => { throw new Error('ECONNREFUSED') }

/** Route each of the page's three endpoints to its own response. */
function mockApi(routes: Record<string, () => unknown>) {
  vi.doMock('@/lib/apiFetch', () => ({
    apiFetch: vi.fn(async (path: string) => {
      const key = path.includes('news/headlines') ? 'news'
        : path.includes('earnings') ? 'earnings'
        : 'sentiment'
      return routes[key]()
    }),
  }))
}

/** What a keyless backend answers on all three — recorded, not written here. */
const keyless = {
  news: () => ok(fixture('news')),
  sentiment: () => ok(fixture('sentiment')),
  earnings: () => ok(fixture('earnings')),
}

beforeEach(() => vi.resetModules())
afterEach(() => vi.doUnmock('@/lib/apiFetch'))

async function renderPage() {
  const Page = (await import('@/app/news/page')).default
  return render(<Page />)
}

const newsItem = (over: Partial<NewsItem> = {}): NewsItem => ({
  id: 'n1',
  title: 'Chipmaker guides above consensus',
  url: 'https://example.test/a',
  publisher: 'Reuters',
  provider: 'newsapi',
  publishedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
  symbols: ['NVDA'],
  sentiment: 'bullish',
  ...over,
})

const redditRow = (over: Partial<RedditSentiment> = {}): RedditSentiment => ({
  symbol: 'NVDA',
  mentions: 184,
  bullishMentions: 96,
  bearishMentions: 31,
  sentimentScore: 51,
  topPosts: [{ title: 'Earnings thread', score: 420, url: 'https://reddit.test/1' }],
  updatedAt: new Date().toISOString(),
  source: 'reddit',
  ...over,
})

const earningsRow = (over: Partial<EarningsEvent> = {}): EarningsEvent => ({
  symbol: 'NVDA',
  date: '2026-09-05',
  eps: null,
  revenue: null,
  epsEstimated: 5.58,
  revenueEstimated: 24.6e9,
  source: 'fmp',
  ...over,
})

describe('the fabricated content is gone', () => {
  test('a keyless backend gets no headlines, no quotes, no earnings dates', async () => {
    mockApi(keyless)
    await renderPage()

    // Each panel says which source is silent, rather than filling itself in.
    await waitFor(() => expect(screen.getByText(/NO NEWS FEED REPORTING/i)).toBeDefined())
    expect(screen.getByText(/NO REDDIT SENTIMENT REPORTING/i)).toBeDefined()
    expect(screen.getByText(/NO EARNINGS CALENDAR REPORTING/i)).toBeDefined()

    // The headlines that used to fill the gap, with real newsrooms' names on
    // them. None of these was ever reported by anyone.
    for (const invented of [/Fed holds rates steady/i, /crush estimates/i, /deliveries miss/i, /\$110B buyback/i]) {
      expect(screen.queryByText(invented)).toBeNull()
    }
    for (const outlet of [/Bloomberg/i, /CNBC/i, /MarketWatch/i, /Barron/i]) {
      expect(screen.queryByText(outlet)).toBeNull()
    }
    // And the invented Reddit posts and tickers behind them.
    expect(screen.queryByText(/infinite money glitch/i)).toBeNull()
    expect(screen.queryByText('MSTR')).toBeNull()
  })

  test('no aggregate sentiment is published with nothing to aggregate', async () => {
    // The pill defaulted to a score of 0.1 and rendered "🟡 NEUTRAL" — a
    // market read computed from no data, in a bordered pill, beside a clock.
    mockApi(keyless)
    await renderPage()
    await waitFor(() => expect(screen.getByText(/NO NEWS FEED REPORTING/i)).toBeDefined())
    expect(screen.queryByText(/NEUTRAL/i)).toBeNull()
    expect(screen.queryByText(/REDDIT SENTIMENT ·/i)).toBeNull()
  })

  test('no clock ticks over three dead panels', async () => {
    mockApi({ news: down, sentiment: down, earnings: down })
    await renderPage()
    await waitFor(() => expect(screen.getAllByText(/UNREACHABLE/i).length).toBe(3))
    expect(screen.queryByText(/Updated/i)).toBeNull()
  })
})

describe('the three empty states are told apart', () => {
  test('a refused panel, an empty one and a dead one read differently', async () => {
    // All three used to arrive as `fulfilled` through `Promise.allSettled` — a
    // 401 body is valid JSON — and read as an empty feed, so a refusal, an
    // outage and a keyless source produced the same screen.
    mockApi({ news: refused, sentiment: () => ok(fixture('sentiment')), earnings: down })
    await renderPage()

    await waitFor(() => expect(screen.getByText(/NEWS FEED REFUSED/i)).toBeDefined())
    expect(screen.getByText(/EARNINGS CALENDAR UNREACHABLE/i)).toBeDefined()
    expect(screen.getByText(/NO REDDIT SENTIMENT REPORTING/i)).toBeDefined()
  })

  test('a refusal does not tell a signed-in reader to sign in', async () => {
    // `middleware.ts` gates `/news` behind a session or the demo cookie, so a
    // reader seeing this page has one. A 401 here is an expired token or a
    // backend missing its Supabase client or its `DEMO_MODE` — two of the
    // three are deployment faults, and "sign in" sends the reader after the
    // wrong one. Same defect as answering "no data" to a quiet feed and a
    // disconnected one.
    mockApi({ news: refused, sentiment: refused, earnings: refused })
    const { container } = await renderPage()

    await waitFor(() => expect(screen.getAllByText(/REFUSED/i).length).toBe(3))
    expect(container.textContent).not.toMatch(/sign in|signed out/i)
  })

  test('no empty state names an environment variable', async () => {
    // The per-source status and the variable that enables each connector live
    // on the settings page. A second copy is a second copy to keep correct.
    mockApi(keyless)
    const { container } = await renderPage()
    await waitFor(() => expect(screen.getByText(/NO NEWS FEED REPORTING/i)).toBeDefined())
    expect(container.textContent).not.toMatch(/_API_KEY|_CLIENT_ID|NEWSAPI_KEY/)
    expect(container.textContent).toMatch(/see Settings/i)
  })
})

describe('live records render as themselves', () => {
  test('an FMP item does not crash the page and is not bylined "fmp"', async () => {
    // FMP's records carry `symbol`, not `symbols[]`, and the literal 'fmp' in
    // `source`. Against the old interface `h.symbols.length` was a TypeError
    // that unmounts the page, and the byline read "fmp".
    mockApi({
      news: () => ok({ headlines: [
        newsItem({ id: 'fmp:https://example.test/b', publisher: null, provider: 'fmp', symbols: ['TSLA'], title: 'Deliveries under the street', sentiment: 'bearish' }),
      ], total: 1 }),
      sentiment: () => ok(fixture('sentiment')),
      earnings: () => ok(fixture('earnings')),
    })
    await renderPage()

    await waitFor(() => expect(screen.getByText(/Deliveries under the street/i)).toBeDefined())
    expect(screen.getByText('TSLA')).toBeDefined()
    expect(screen.getByText(/via FMP/i)).toBeDefined()
    expect(screen.queryByText(/^fmp$/)).toBeNull()
  })

  test('an unparseable publish time says nothing rather than "NaNd ago"', async () => {
    mockApi({
      news: () => ok({ headlines: [newsItem({ publishedAt: undefined as unknown as string })], total: 1 }),
      sentiment: () => ok(fixture('sentiment')),
      earnings: () => ok(fixture('earnings')),
    })
    await renderPage()
    await waitFor(() => expect(screen.getByText(/Chipmaker guides/i)).toBeDefined())
    expect(screen.queryByText(/NaN/)).toBeNull()
  })

  test('a Reddit score is read on the scale the wire uses, not a tenth of it', async () => {
    // `sentimentScore` runs -100…+100. The gauge computed `((s + 1) / 2) * 100`
    // and the labels thresholded at ±0.2 — calibrated for -1…+1. Bound to the
    // real field without rescaling, a mild 30 renders "VERY BULLISH" at
    // `width: 1550%`: a confident colour, typechecked, and wrong.
    mockApi({
      news: () => ok(fixture('news')),
      sentiment: () => ok({ reddit: [redditRow({ sentimentScore: 30 })] }),
      earnings: () => ok(fixture('earnings')),
    })
    const { container } = await renderPage()

    await waitFor(() => expect(screen.getAllByText(/BULLISH/i).length).toBeGreaterThan(0))
    expect(screen.queryByText(/VERY BULLISH/i)).toBeNull()

    const widths = Array.from(container.querySelectorAll<HTMLElement>('[style*="width"]'))
      .map(el => el.style.width)
      .filter(w => w.endsWith('%'))
    for (const w of widths) {
      const pct = parseFloat(w)
      expect(Number.isFinite(pct)).toBe(true)
      expect(pct).toBeGreaterThanOrEqual(0)
      expect(pct).toBeLessThanOrEqual(100)
    }
  })

  test('keyword tallies are shown as tallies, never as a share of mentions', async () => {
    // The connector adds a whole post's term hits to both counters, so these
    // can exceed `mentions` — the "78% bull / 12% bear / 10% neutral" split the
    // fallback array implied is not derivable from anything the wire sends.
    mockApi({
      news: () => ok(fixture('news')),
      sentiment: () => ok({ reddit: [redditRow({ mentions: 12, bullishMentions: 96, bearishMentions: 31 })] }),
      earnings: () => ok(fixture('earnings')),
    })
    const { container } = await renderPage()

    await waitFor(() => expect(screen.getByText(/🟢 96$/)).toBeDefined())
    expect(screen.getByText(/🔴 31$/)).toBeDefined()
    expect(screen.getByText(/bullish \/ bearish keyword hits/i)).toBeDefined()
    expect(container.textContent).not.toMatch(/%\s*bull|bull\s*%|undefined/i)
    // Case-sensitive: "Financial" contains a case-insensitive "nan".
    expect(container.textContent).not.toMatch(/NaN/)
  })

  test('an earnings row shows only fields FMP sends', async () => {
    mockApi({
      news: () => ok(fixture('news')),
      sentiment: () => ok(fixture('sentiment')),
      earnings: () => ok({ earnings: [earningsRow()] }),
    })
    const { container } = await renderPage()

    await waitFor(() => expect(screen.getByText('NVDA')).toBeDefined())
    expect(screen.getByText(/EPS est \$5\.58/)).toBeDefined()
    // No company name and no BMO/AMC session marker: the calendar carries
    // neither, and the badge used to pick its colour from an `undefined`.
    expect(container.textContent).not.toMatch(/\bAMC\b|\bBMO\b|\bTNS\b|NVIDIA Corp/)
  })

  test('a date-only earnings date is not counted a day early', async () => {
    // `new Date('2026-09-05')` is UTC midnight — the evening of the 4th in New
    // York — so a naive subtraction reads a day short through the whole US
    // session.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' })
    mockApi({
      news: () => ok(fixture('news')),
      sentiment: () => ok(fixture('sentiment')),
      earnings: () => ok({ earnings: [earningsRow({ date: today })] }),
    })
    await renderPage()
    await waitFor(() => expect(screen.getByText('TODAY')).toBeDefined())
  })
})

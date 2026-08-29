/**
 * Demo mode — a read-only, unauthenticated look at the terminal.
 *
 * Off unless the deployment opts in with `NEXT_PUBLIC_DEMO_MODE=1`. When off,
 * the sign-in button is not rendered, `/demo/enter` 404s, and `middleware.ts`
 * ignores the cookie entirely, so production behaviour is unchanged by default.
 *
 * What a demo session can reach is decided by the backend, not here: it sends
 * `X-QuantFlow-Demo: 1` instead of a Bearer token, and the backend admits that
 * only for routes that neither cost money per call nor return entitled vendor
 * data. `/api/chain` and the Firecrawl enrichment endpoints still 401.
 */
export const DEMO_COOKIE = 'qf_demo'
export const DEMO_HEADER = 'X-QuantFlow-Demo'

export function isDemoModeEnabled(): boolean {
  return process.env.NEXT_PUBLIC_DEMO_MODE === '1'
}

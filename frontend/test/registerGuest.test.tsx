/**
 * The register page's guest button matches the login page's: rendered only
 * when demo mode is on, and a form POST that sets the demo cookie.
 *
 * It was `router.push('/flow')` on every deployment, which the middleware
 * redirected straight back to /login: a button that did nothing.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { render } from '@testing-library/react'

vi.mock('@/lib/supabase', () => ({ supabase: { auth: { signUp: vi.fn() } } }))

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetModules()
})

async function renderRegister() {
  const { default: RegisterPage } = await import('@/app/(auth)/register/page')
  return render(<RegisterPage />).container
}

test('without demo mode there is no guest button', async () => {
  vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '')
  const c = await renderRegister()
  expect(c.textContent).not.toContain('Continue as Guest')
})

test('with demo mode the guest button posts to /demo/enter/', async () => {
  vi.stubEnv('NEXT_PUBLIC_DEMO_MODE', '1')
  const c = await renderRegister()
  const form = c.querySelector('form[action="/demo/enter/"]')
  expect(form).not.toBeNull()
  expect(form!.getAttribute('method')?.toUpperCase()).toBe('POST')
  expect(form!.textContent).toContain('Continue as Guest')
})

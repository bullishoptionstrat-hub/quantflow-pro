/**
 * After a successful sign-in the login page must do a full page load.
 *
 * The sidebar's links are prefetched while signed out, so the client router
 * caches each one as a redirect to /login. router.push('/flow') reused that
 * cache and landed back on the login page, which looked like the button did
 * nothing. A full load asks the server, which now sees the session cookie.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'

const push = vi.fn()
vi.mock('next/navigation', () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))
vi.mock('@/lib/supabase', () => ({
  supabase: { auth: { signInWithPassword: vi.fn(async () => ({ data: {}, error: null })) } },
}))

afterEach(() => vi.unstubAllGlobals())

test('a successful sign-in loads /flow/ as a full page, not a client-side push', async () => {
  const assign = vi.fn()
  vi.stubGlobal('location', { ...window.location, assign })
  const { default: LoginPage } = await import('@/app/(auth)/login/page')
  const { container } = render(<LoginPage />)
  fireEvent.change(container.querySelector('input[type=email]')!, { target: { value: 'a@b.co' } })
  fireEvent.change(container.querySelector('input[type=password]')!, { target: { value: 'x' } })
  fireEvent.click(screen.getByRole('button', { name: /sign in/i }))
  await waitFor(() => expect(assign).toHaveBeenCalledWith('/flow/'))
  expect(push).not.toHaveBeenCalled()
})

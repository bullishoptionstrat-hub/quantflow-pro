/**
 * The sign-out control appears only with a session, and shows a failure
 * instead of hiding it.
 */
import { afterEach, expect, test, vi } from 'vitest'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'

const auth = vi.hoisted(() => ({
  session: null as null | { access_token: string },
  signOutResult: { error: null as string | null },
}))

vi.mock('@/lib/supabase', () => ({
  supabase: {
    auth: {
      getSession: async () => ({ data: { session: auth.session } }),
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe: () => {} } } }),
    },
  },
}))
vi.mock('@/lib/signOut', () => ({ signOut: vi.fn(async () => auth.signOutResult) }))

afterEach(() => {
  auth.session = null
  auth.signOutResult = { error: null }
})

async function renderButton() {
  const { SignOutButton } = await import('@/components/layout/SignOutButton')
  let view!: ReturnType<typeof render>
  await act(async () => {
    view = render(<SignOutButton />)
  })
  return view
}

test('nothing is rendered without a session', async () => {
  const { container } = await renderButton()
  expect(container.innerHTML).toBe('')
})

test('with a session the button signs out', async () => {
  auth.session = { access_token: 't' }
  await renderButton()
  const button = await screen.findByRole('button', { name: /sign out/i })
  fireEvent.click(button)
  const { signOut } = await import('@/lib/signOut')
  await waitFor(() => expect(signOut).toHaveBeenCalled())
})

test('a failed sign-out is shown to the reader', async () => {
  auth.session = { access_token: 't' }
  auth.signOutResult = { error: 'Sign-out did not reach the server.' }
  await renderButton()
  fireEvent.click(await screen.findByRole('button', { name: /sign out/i }))
  expect((await screen.findByRole('alert')).textContent).toBe('Sign-out did not reach the server.')
})

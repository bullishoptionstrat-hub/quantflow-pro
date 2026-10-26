/**
 * The Settings page names each half's commit, or says it does not know.
 */
import { expect, test } from 'vitest'
import { render } from '@testing-library/react'
import { BuildIdentity, backendBuild, frontendCommit } from '@/components/settings/BuildIdentity'

const SHA = 'a9fe7e78ba0d584cb37b10248e73bf099335ffec'
const OTHER = '98432938951ae79c4e7cb49b7fa0ccdc8d20faf6'

test('frontend commit: a full SHA is kept, anything else is unknown', () => {
  expect(frontendCommit(SHA)).toBe(SHA)
  expect(frontendCommit(` ${SHA.toUpperCase()} `)).toBe(SHA)
  for (const bad of [undefined, '', 'main', 'a9fe7e7']) expect(frontendCommit(bad)).toBeNull()
})

test('backend build: reported, unknown, absent and malformed are told apart', () => {
  expect(backendBuild({ build: { state: 'reported', commit: SHA, shortCommit: 'a9fe7e7', source: 'RENDER_GIT_COMMIT' } })?.state).toBe('reported')
  expect(backendBuild({ build: { state: 'unknown', commit: null, reason: 'not set' } })).toMatchObject({ state: 'unknown', reason: 'not set' })
  // An older backend publishes `version` and no `build`.
  expect(backendBuild({ version: '1.0.0' })).toBeNull()
  expect(backendBuild(null)).toBeNull()
  // A claimed commit that is not a SHA is not shown as one.
  expect(backendBuild({ build: { state: 'reported', commit: 'main' } })).toBeNull()
})

test('both halves are shown independently, and a match is not called healthy', () => {
  const { container } = render(
    <BuildIdentity frontend={SHA} health={{ build: { state: 'reported', commit: OTHER, shortCommit: '9843293', source: 'RENDER_GIT_COMMIT' } }} />,
  )
  const text = container.textContent ?? ''
  expect(text).toContain('a9fe7e7')
  expect(text).toContain('9843293')
  expect(text).toContain('not that either is healthy')
})

test('unknowns render as UNKNOWN with the reason, never as a commit', () => {
  const { container } = render(
    <BuildIdentity frontend={null} health={{ build: { state: 'unknown', commit: null, reason: 'RENDER_GIT_COMMIT is not set' } }} />,
  )
  const text = container.textContent ?? ''
  expect(text.match(/UNKNOWN/g)?.length).toBe(2)
  expect(text).toContain('RENDER_GIT_COMMIT is not set')
  expect(container.querySelectorAll('a').length).toBe(0)
})

test('a backend that did not answer is not confused with one that has no build block', () => {
  expect(render(<BuildIdentity frontend={SHA} health={null} />).container.textContent).toContain('did not answer')
  expect(render(<BuildIdentity frontend={SHA} health={{ version: '1.0.0' }} />).container.textContent).toContain('does not report its build')
})

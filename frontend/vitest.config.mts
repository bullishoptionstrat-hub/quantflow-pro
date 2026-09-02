import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [react()],
  // Without this, esbuild transforms .tsx with the classic runtime and every
  // render fails on "React is not defined" — tsconfig.json says `jsx:
  // preserve` because Next does its own transform, and Vitest has no Next.
  esbuild: { jsx: 'automatic' },
  resolve: {
    // Mirrors the `@/*` path alias in tsconfig.json.
    alias: { '@': resolve(__dirname, '.') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.{ts,tsx}'],
    // A single forked process. The default worker pool runs a jsdom instance
    // per thread, which does not fit alongside a Next build on a small box —
    // and a suite that cannot be run is worth nothing.
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
  },
})

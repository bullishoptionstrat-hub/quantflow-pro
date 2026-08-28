/** @type {import('next').NextConfig} */

// Where the Express backend lives. Server-side only (not NEXT_PUBLIC_) because
// rewrites are resolved on the server, never in the browser bundle.
const BACKEND_URL =
  process.env.BACKEND_URL ||
  (process.env.NODE_ENV === 'development'
    ? 'http://localhost:3001'
    : 'https://quantflow-pro-backend.onrender.com')

// Every router mounted in backend/src/server.ts. Both the bare path and the
// sub-path form are listed: pages call `/api/macro` as well as `/api/macro/vix`.
const API_SEGMENTS = ['flow', 'darkpool', 'gex', 'chain', 'macro', 'sentiment', 'health']

const apiRewrites = API_SEGMENTS.flatMap((seg) => [
  { source: `/api/${seg}`, destination: `${BACKEND_URL}/api/${seg}` },
  { source: `/api/${seg}/:path*`, destination: `${BACKEND_URL}/api/${seg}/:path*` },
])

const nextConfig = {
  reactStrictMode: true,
  trailingSlash: true,
  experimental: { typedRoutes: false },
  images: { unoptimized: true },
  async rewrites() {
    return {
      // beforeFiles runs ahead of the trailingSlash redirect, so `/api/macro`
      // proxies straight through instead of bouncing to `/api/macro/` first.
      beforeFiles: apiRewrites,
    }
  },
}

module.exports = nextConfig

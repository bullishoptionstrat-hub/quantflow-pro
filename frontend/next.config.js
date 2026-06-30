/** @type {import('next').NextConfig} */
const isStaticExport = process.env.STATIC_EXPORT === 'true'

const nextConfig = {
  reactStrictMode: true,
  ...(isStaticExport ? { output: 'export', trailingSlash: true, distDir: 'out' } : {}),
  experimental: { typedRoutes: false },
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_WS_URL: process.env.NEXT_PUBLIC_WS_URL || 'http://localhost:3001',
  },
}

module.exports = nextConfig

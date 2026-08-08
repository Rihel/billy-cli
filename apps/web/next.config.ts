import type { NextConfig } from 'next'
import path from 'path'
const isDev = process.env.NODE_ENV === 'development'

const nextConfig: NextConfig = {
  transpilePackages: ['@repo/ui'],
  typescript: {
    ignoreBuildErrors: true,
  },
  output: !isDev ? 'standalone' : undefined,
  outputFileTracingRoot: !isDev ? path.join(__dirname, '../../') : undefined,
  reactCompiler: true,
}

export default nextConfig

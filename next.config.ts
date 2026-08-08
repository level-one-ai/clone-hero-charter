import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // 'standalone' emits .next/standalone/server.js with only the node_modules the app
  // actually imports. The Docker runtime stage copies that instead of the full
  // node_modules tree, which keeps the deployed image small.
  output: 'standalone',
  reactStrictMode: true,
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;

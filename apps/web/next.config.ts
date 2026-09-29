import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@job-tracker/shared-types'],
};

export default nextConfig;

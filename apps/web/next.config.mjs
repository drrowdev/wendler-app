import { execSync } from 'node:child_process';

function gitShortSha() {
  try {
    return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString()
      .trim();
  } catch {
    return 'dev';
  }
}

const BUILD_SHA = process.env.GITHUB_SHA?.slice(0, 7) ?? gitShortSha();
const BUILD_TIME = new Date().toISOString();

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  output: 'export',
  images: { unoptimized: true },
  env: {
    NEXT_PUBLIC_BUILD_SHA: BUILD_SHA,
    NEXT_PUBLIC_BUILD_TIME: BUILD_TIME,
  },
};

export default nextConfig;

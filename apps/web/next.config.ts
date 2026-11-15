import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  transpilePackages: [
    "@live-competition-engine/auth",
    "@live-competition-engine/config",
    "@live-competition-engine/db",
    "@live-competition-engine/engine"
  ]
};

export default nextConfig;

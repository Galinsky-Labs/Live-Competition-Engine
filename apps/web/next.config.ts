import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  transpilePackages: [
    "@live-competition-engine/config",
    "@live-competition-engine/db",
    "@live-competition-engine/auth",
    "@live-competition-engine/domain",
    "@live-competition-engine/profiles"
  ]
};

export default nextConfig;

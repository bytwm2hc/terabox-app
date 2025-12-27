const nextConfig = {
  reactStrictMode: true,
  images: {
    unoptimized: true,
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**",
      },
    ],
  },
  trailingSlash: false,
  serverExternalPackages: ["@cloudflare/next-on-pages"],
};

export default nextConfig;
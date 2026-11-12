import type { NextConfig } from "next";

// Host of NEXT_PUBLIC_APP_URL (e.g. 192.168.100.5, set in .env.local). The dev server only serves its
// dev assets and HMR to localhost by default, so this host must be allowed to open the app by LAN IP.
function hostnameOf(url: string | undefined): string | null {
  try {
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

const appUrlHost = hostnameOf(process.env.NEXT_PUBLIC_APP_URL);

const nextConfig: NextConfig = {
  /* config options here */
  allowedDevOrigins: appUrlHost ? [appUrlHost] : [],
  cacheComponents: true,
  partialPrefetching: true,
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;

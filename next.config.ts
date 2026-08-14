import type { NextConfig } from "next";

/**
 * Security headers apply to everything.
 *
 * `noindex` matters more than usual here: the corpus is minors, and an internal
 * tool behind a shared passphrase should never appear in a search index even if a
 * URL leaks. The CSP is deliberately narrow — this app loads no third-party
 * scripts, fonts or images, so there is nothing to allowlist. `unsafe-inline` for
 * styles is required by Next's own injected style tags.
 */
const securityHeaders = [
  { key: "X-Robots-Tag", value: "noindex, nofollow, noarchive" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      // Next injects inline bootstrap scripts; eval is needed by the dev overlay
      // only, and stripping it in production keeps that door shut.
      process.env.NODE_ENV === "production"
        ? "script-src 'self' 'unsafe-inline'"
        : "script-src 'self' 'unsafe-inline' 'unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self'",
      // Every outbound call is server-side, so the browser needs nothing but us.
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
];

const nextConfig: NextConfig = {
  // `next build` and `next dev` both write to .next, so building while the dev
  // server is running corrupts its chunks ("Cannot find module './586.js'").
  // `npm run build:check` sets this to an alternate directory so a local type
  // check can never clobber a running dev server. Unset on Vercel, so the
  // production build still emits to .next as normal.
  distDir: process.env.NEXT_DIST_DIR || ".next",

  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;

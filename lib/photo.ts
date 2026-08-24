import { get, set } from "./store";
import { log, timed } from "./log";

/**
 * Keeping a profile photo, once.
 *
 * ── Why the bytes and not the link ────────────────────────────────────────
 * The vendor hands back a `media.licdn.com` URL that is signed and carries an
 * expiry. Rendering from it works for a while and then quietly stops: the queue
 * degrades to initials, and a digest email opened a month later shows broken images
 * in somebody's inbox. Sampling twenty-four real payloads, every photo URL had an
 * expiry parameter. So the link is treated as a one-time coupon and the bytes are
 * what we keep.
 *
 * ── Why it is proxied and not hotlinked ───────────────────────────────────
 * `next.config.ts` sets `img-src 'self' data:`. Widening that to LinkedIn's CDN would
 * work and would also mean the team's browsers announce to LinkedIn, on every render
 * of the queue, exactly which profiles this tool is looking at. The population is
 * minors and the whole app runs `noindex` behind a passphrase to avoid precisely that
 * kind of leak. Serving from our own origin keeps the CSP as it is and keeps the
 * browser from ever talking to LinkedIn.
 *
 * ── The cache is the feature ──────────────────────────────────────────────
 * A 200px square is a few kilobytes, so the whole roster is well under a megabyte.
 * Stored under the image's *path* rather than its full URL, because the query string
 * is the signature and changes on every scrape while the picture does not — keying on
 * the whole URL would refetch on every enrichment for no reason.
 */

/** Nothing legitimate is close to this. A 200px square is single-digit kilobytes. */
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 8_000;

/** The only host we will fetch from. The URL comes from the vendor, not a user. */
const ALLOWED_HOST = /(^|\.)licdn\.com$/;

export type StoredPhoto = {
  /** base64, because the store is JSON over HTTP. */
  data: string;
  contentType: string;
  /** The source path, so a re-scrape of the same picture is not refetched. */
  path: string;
  at: string;
};

export function photoKey(slug: string): string {
  return `zscore:photo:${slug}`;
}

/** The part of the URL that identifies the image rather than the signature. */
function pathOf(url: string): string | null {
  try {
    const u = new URL(url);
    return ALLOWED_HOST.test(u.hostname) ? u.pathname : null;
  } catch {
    return null;
  }
}

/**
 * The photo for a slug, fetching and storing it the first time.
 *
 * Returns null rather than throwing on every failure — an expired link, a profile
 * with no picture, a network blip. The caller answers 404 and the avatar falls back
 * to initials, which is a complete answer rather than a broken one.
 */
export async function photoFor(slug: string, sourceUrl: string | undefined): Promise<StoredPhoto | null> {
  const key = photoKey(slug);
  const cached = await get<StoredPhoto>(key);
  const path = sourceUrl ? pathOf(sourceUrl) : null;

  // Same picture as the one already stored, or no fresh link to try.
  if (cached && (!path || cached.path === path)) return cached;
  if (!sourceUrl || !path) return cached;

  const fetched = await download(sourceUrl);
  if (!fetched) return cached;

  const stored: StoredPhoto = { ...fetched, path, at: new Date().toISOString() };
  await set(key, stored);
  // The slug is not candidate PII in the sense `lib/log.ts` bans, and it is what
  // makes a failure traceable. The URL is never logged.
  log.info("photo.stored", { slug, bytes: fetched.data.length });
  return stored;
}

async function download(url: string): Promise<{ data: string; contentType: string } | null> {
  return timed("photo.fetch", {}, async () => {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
        cache: "no-store",
      });
      if (!res.ok) return null;

      const contentType = (res.headers.get("content-type") ?? "").split(";")[0].trim();
      // An expired signature comes back as an HTML error page, not an image, so the
      // content type is the check that catches it rather than storing a page of XML.
      if (!contentType.startsWith("image/")) return null;

      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length === 0 || buf.length > MAX_BYTES) return null;

      return { data: Buffer.from(buf).toString("base64"), contentType };
    } catch {
      return null;
    }
  });
}

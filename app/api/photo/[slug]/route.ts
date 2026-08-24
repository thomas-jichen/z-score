import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { readRoster, migrateIfNeeded } from "@/lib/serverState";
import { photoFor, photoTokenValid } from "@/lib/photo";
import { toSlug } from "@/lib/enrichment";

/**
 * A profile photo, from our own origin.
 *
 * Behind the same passphrase as every other route, because a photo of a minor is not
 * a public asset and this app's whole posture is that none of its data is.
 *
 * Answers 404 for anything missing — no picture on the profile, an expired link that
 * cannot be refetched, a slug nobody has. The avatar falls back to initials, so a
 * miss looks like a design and not like a failure.
 */

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const slug = toSlug((await ctx.params).slug);
  if (!slug) return new NextResponse(null, { status: 404 });

  /**
   * Either a session or a token for this one image.
   *
   * A mail client sends no cookies, so the digest cannot rely on the passphrase the
   * rest of the app runs behind. The token is an HMAC of the slug — see `lib/photo.ts`
   * for why it does not expire — and it is checked *before* the session so a valid
   * token costs no cookie parsing. It grants exactly this photo: another slug needs
   * another signature, and nothing else in the app accepts it.
   */
  const token = new URL(req.url).searchParams.get("t");
  if (!photoTokenValid(slug, token)) {
    const r = await resolveProfile();
    if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  }

  await migrateIfNeeded();
  const roster = await readRoster();
  const person = roster[slug];
  if (!person) return new NextResponse(null, { status: 404 });

  const photo = await photoFor(slug, person.enriched?.photoUrl);
  if (!photo) return new NextResponse(null, { status: 404 });

  return new NextResponse(Buffer.from(photo.data, "base64"), {
    headers: {
      "Content-Type": photo.contentType,
      /**
       * Immutable for a day at the browser and a year at the edge. The bytes for a
       * slug only change when somebody changes their LinkedIn photo and we re-enrich
       * them, and a day is a short enough leash for that while still meaning the
       * queue does not refetch forty images on every navigation.
       */
      "Cache-Control": "private, max-age=86400, stale-while-revalidate=604800",
      /** Never indexed, never a public asset. */
      "X-Robots-Tag": "noindex, noimageindex",
      "Content-Disposition": "inline",
    },
  });
}

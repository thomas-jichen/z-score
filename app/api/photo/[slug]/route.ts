import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { readRoster, migrateIfNeeded, writePeople } from "@/lib/serverState";
import { photoFor, photoTokenValid, storePhoto } from "@/lib/photo";
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

  /**
   * Revalidated rather than held, with an ETag doing the work.
   *
   * This was `max-age=86400`, on the theory that a photo never changes. It does: a
   * re-enrichment can bring a new one, and somebody can replace one by hand. The
   * first time that happened the browser kept serving the previous image for a day
   * and the page looked broken in the one way that is impossible to debug from the
   * outside — the bytes in the store were right and the screen was wrong.
   *
   * `no-cache` means revalidate before use, not "do not store". Unchanged bytes cost
   * a 304 with no body, which for a page of thirty-odd avatars is cheaper than it
   * sounds and always correct. An email is fetched once on open, so it loses nothing.
   */
  const tag = `"${photo.at}-${photo.data.length}"`;
  if (req.headers.get("if-none-match") === tag) {
    return new NextResponse(null, {
      status: 304,
      headers: { ETag: tag, "Cache-Control": "private, no-cache" },
    });
  }

  return new NextResponse(Buffer.from(photo.data, "base64"), {
    headers: {
      "Content-Type": photo.contentType,
      "Cache-Control": "private, no-cache",
      ETag: tag,
      /** Never indexed, never a public asset. */
      "X-Robots-Tag": "noindex, noimageindex",
      "Content-Disposition": "inline",
    },
  });
}

/**
 * Supply a picture by hand.
 *
 * Cookie-only, deliberately: the read side accepts a signed token so a mail client
 * can fetch an image, and a capability that lets anybody *write* one is a different
 * thing entirely. Nothing about a photo token grants this.
 *
 * The body is the image itself rather than JSON — no base64 round trip, and the
 * content type is the header the browser already sets. The client downscales to a
 * 200px square first, matching what the vendor gives us, so the cap below is a
 * backstop rather than something a real drop will meet.
 */
export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const slug = toSlug((await ctx.params).slug);
  if (!slug) return NextResponse.json({ ok: false, error: "No profile." }, { status: 400 });

  await migrateIfNeeded();
  const roster = await readRoster();
  const person = roster[slug];
  if (!person) return NextResponse.json({ ok: false, error: "Nobody by that slug." }, { status: 404 });

  const contentType = (req.headers.get("content-type") ?? "").split(";")[0].trim();
  const bytes = new Uint8Array(await req.arrayBuffer());
  const stored = await storePhoto(slug, bytes, contentType);
  if (!stored) {
    return NextResponse.json(
      { ok: false, error: "That is not an image, or it is too large." },
      { status: 400 }
    );
  }

  /**
   * Recorded on the person as well as in the cache, because `has_photo` is computed
   * by `scoreOne`, which is synchronous and has no way to ask the store. Without this
   * the bytes would sit there and no surface would ask for them.
   */
  await writePeople([{ ...person, photoManual: true, updatedAt: new Date().toISOString() }]);
  return NextResponse.json({ ok: true });
}

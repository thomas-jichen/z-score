import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { scoreOne } from "@/lib/candidates";
import { emailFrom, hasEmail, sendEmail, emailOrigin } from "@/lib/email";
import { renderQueueDigest } from "@/lib/emailDigest";
import { migrateIfNeeded, readRoster, readTeam } from "@/lib/serverState";
import { hydrate, stateKey, type ProfileState } from "@/lib/state";
import { get } from "@/lib/store";
import { readJson, isBad } from "@/lib/validate";
import { log } from "@/lib/log";

/**
 * Send yourself the digest, now.
 *
 * The only way to see the real thing without waiting for a cron or finishing a
 * campaign, which matters because an email is the one surface nobody looks at before
 * it reaches somebody else.
 *
 * Deliberately narrow: it sends the *caller's own* digest to the *caller's own*
 * stored address. There is no recipient parameter, so this route cannot be turned
 * into a way to mail an arbitrary address from a verified domain — which is what an
 * open send endpoint behind a shared passphrase would be.
 */

export const maxDuration = 60;

type Body = { op?: unknown };

export async function GET() {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });
  return NextResponse.json({ ok: true, configured: hasEmail(), from: hasEmail() ? emailFrom() : null });
}

export async function POST(req: Request) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const body = await readJson<Body>(req);
  if (isBad(body)) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });
  if (body.op !== "test") {
    return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 400 });
  }

  if (!hasEmail()) {
    return NextResponse.json(
      {
        ok: false,
        error: "RESEND_API_KEY is not set, so nothing can be sent yet.",
      },
      { status: 503 }
    );
  }

  try {
    await migrateIfNeeded();
    const state = hydrate(await get<Partial<ProfileState>>(stateKey(r.profile)));
    if (!state.email) {
      return NextResponse.json(
        { ok: false, error: "Add your address first, then try again." },
        { status: 400 }
      );
    }

    const [roster, team] = await Promise.all([readRoster(), readTeam()]);
    const queue = Object.values(roster)
      .map((p) => scoreOne(p, team.taxonomy))
      .filter((c) => (state.marks[c.slug]?.status ?? "queued") === "queued")
      .sort((a, b) => {
        const pa = state.marks[a.slug]?.pinned ? 1 : 0;
        const pb = state.marks[b.slug]?.pinned ? 1 : 0;
        return pa !== pb ? pb - pa : b.score - a.score;
      });

    const mail = renderQueueDigest({
      candidates: queue.slice(0, 10),
      queueTotal: queue.length,
      knownCount: Object.values(state.marks).filter((m) => m.status === "known").length,
      newSince: state.lastDigestAt,
      origin: emailOrigin(),
      cadence: state.digest === "weekly" ? "weekly" : "daily",
    });

    const sent = await sendEmail({ to: state.email, ...mail });
    if (!sent.ok) {
      /**
       * Reported rather than swallowed, unlike every scheduled send. A person who
       * has just pressed a button is owed the reason, and the commonest reason is
       * the one worth reading in full: an unverified domain refusing a recipient.
       */
      log.warn("email.test.failed", { who: r.profile, error: sent.error });
      return NextResponse.json({ ok: false, error: sent.error }, { status: 502 });
    }

    /**
     * `lastDigestAt` is deliberately not stamped. A test is a look at the thing, not
     * a delivery of it, and stamping would silently cancel tomorrow's real one.
     */
    log.info("email.test", { who: r.profile });
    return NextResponse.json({ ok: true, subject: mail.subject });
  } catch (e) {
    log.error("email.test.failed", { error: e instanceof Error ? e.message : "unknown" });
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Could not send." },
      { status: 500 }
    );
  }
}

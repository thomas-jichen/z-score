import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { summarise } from "@/lib/campaign";
import { listCampaigns, tickCampaign } from "@/lib/campaignRun";
import { migrateIfNeeded } from "@/lib/serverState";
import { log } from "@/lib/log";

/**
 * The daily advance.
 *
 * Vercel sends `Authorization: Bearer <CRON_SECRET>` whenever that variable is
 * set, so the secret is the whole gate. Hobby allows one cron a day, fired
 * anywhere inside the hour — which the engine is built for: the day counter moves
 * on the UTC date, never on when this actually ran, so jitter is irrelevant and a
 * missed day is one fewer advance rather than a corrupted schedule.
 *
 * Every running campaign shares this one invocation and its budget, which is why
 * only one campaign runs at a time and why the tick is re-entrant. Whatever does
 * not fit is picked up by the Advance button or by Claude.
 */

export const maxDuration = 300;

/** Leaves a little of the 300s to write the response. */
const BUDGET_MS = 250_000;

function authorised(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  /**
   * No secret, no entry.
   *
   * The tempting shortcut is to allow the call when the variable is unset, "for
   * local development". That leaves a public URL in production that starts paid
   * work, and the string it would have compared against is the literal
   * "Bearer undefined".
   */
  if (!secret) return false;

  const given = req.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(req: Request) {
  if (!process.env.CRON_SECRET) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "CRON_SECRET is not set, so the scheduled advance is disabled. Set it in the environment and redeploy.",
      },
      { status: 503 }
    );
  }
  if (!authorised(req)) {
    return NextResponse.json({ ok: false, error: "Not authorised." }, { status: 401 });
  }

  const deadline = Date.now() + BUDGET_MS;

  try {
    await migrateIfNeeded();
    const running = (await listCampaigns())
      .filter((c) => c.status === "running")
      // Longest untouched first, so nothing starves if several are somehow live.
      .sort((a, b) => (a.lastTickAt ?? "").localeCompare(b.lastTickAt ?? ""));

    const advanced: unknown[] = [];
    for (const c of running) {
      if (Date.now() > deadline) {
        log.warn("cron.campaigns.truncated", { remaining: running.length - advanced.length });
        break;
      }
      const res = await tickCampaign(c.id, deadline - Date.now());
      advanced.push({ campaign: summarise(res.campaign), tick: res.tick, note: res.note });
    }

    log.info("cron.campaigns", { running: running.length, advanced: advanced.length });
    return NextResponse.json({ ok: true, running: running.length, advanced });
  } catch (e) {
    log.error("cron.campaigns.failed", { error: e instanceof Error ? e.message : "unknown" });
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "The advance failed." },
      { status: 500 }
    );
  }
}

import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { MAX_PROFILES_PER_RUN, hasToken, isMock } from "@/lib/apify";
import { COST_PER_PROFILE } from "@/lib/enrichment";
import { COST_PER_QUERY } from "@/lib/query";
import { LIMITS, estimateUsd, summarise } from "@/lib/campaign";
import { planQueries } from "@/lib/campaignQueries";
import {
  buildReport,
  createCampaign,
  deleteCampaign,
  listCampaigns,
  readCampaign,
  readDefaults,
  stopCampaign,
  tickCampaign,
  updateCampaign,
  writeDefaults,
} from "@/lib/campaignRun";
import { DAILY_PROFILE_CAP, HOURLY_SEARCH_CAP, HOURLY_TAG_CAP } from "@/lib/ratelimit";
import { migrateIfNeeded } from "@/lib/serverState";
import { storeIsEphemeral } from "@/lib/store";
import { bounded, isBad, readJson, str } from "@/lib/validate";
import { log } from "@/lib/log";

/**
 * Campaigns, for the browser.
 *
 * The MCP server calls the same functions in lib/campaignRun.ts directly, so this
 * route is only the cookie-authenticated door for the Agent screen. Everything it
 * can do, Claude can do, and the reverse — a setting that could only be changed
 * from one side would be exactly the black box this feature is meant not to be.
 */

export const maxDuration = 300;

type Body =
  | { op: "create"; name?: unknown; selection?: unknown; queries?: unknown; settings?: unknown }
  | { op: "tick"; id?: unknown }
  | { op: "stop"; id?: unknown; reason?: unknown }
  | { op: "delete"; id?: unknown }
  | { op: "update"; id?: unknown; settings?: unknown }
  | { op: "defaults"; settings?: unknown }
  | { op: "report"; id?: unknown; limit?: unknown };

/**
 * Everything the Agent screen needs to render, in one read.
 *
 * `limits` and `facts` are here so the page can show the real bound beside every
 * field and the real ceiling beside every stop reason. A number the loop obeys
 * that the screen cannot show is a number nobody can reason about.
 */
export async function GET() {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  try {
    await migrateIfNeeded();
    const [campaigns, defaults] = await Promise.all([listCampaigns(), readDefaults()]);

    return NextResponse.json({
      ok: true,
      profile: r.profile,
      campaigns: campaigns.map(summarise),
      defaults,
      limits: LIMITS,
      facts: {
        costPerQuery: COST_PER_QUERY,
        costPerProfile: COST_PER_PROFILE,
        apifyMaxPerRun: MAX_PROFILES_PER_RUN,
        dailyProfileCap: DAILY_PROFILE_CAP,
        hourlySearchCap: HOURLY_SEARCH_CAP,
        hourlyTagCap: HOURLY_TAG_CAP,
        enrichConfigured: hasToken() || isMock(),
        mock: isMock(),
        ephemeral: storeIsEphemeral(),
      },
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Store read failed." },
      { status: 500 }
    );
  }
}

export async function POST(req: Request) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const body = await readJson<Body>(req);
  if (isBad(body)) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });

  try {
    await migrateIfNeeded();

    switch (body.op) {
      case "create": {
        const result = await createCampaign(r.profile, {
          name: str(body.name, 80),
          selection: (body.selection ?? {}) as never,
          queries: Array.isArray(body.queries) ? (body.queries as string[]) : [],
          settings: (body.settings ?? {}) as never,
        });
        if (!result.ok) return NextResponse.json({ ok: false, error: result.error }, { status: 400 });
        return NextResponse.json({
          ok: true,
          campaign: summarise(result.campaign),
          plannedQueries: result.plannedQueries,
          estimateUsd: result.estimateUsd,
          warnings: result.warnings,
        });
      }

      case "tick": {
        const id = str(body.id, 60);
        const c = await readCampaign(id);
        if (!c) return NextResponse.json({ ok: false, error: "No campaign with that id." }, { status: 404 });
        // Anyone may advance a campaign: the roster it fills is shared, and a
        // stalled loop helping nobody is worse than a teammate nudging it along.
        const res = await tickCampaign(id);
        return NextResponse.json({
          ok: true,
          campaign: summarise(res.campaign),
          tick: res.tick,
          note: res.note,
          report: await buildReport(res.campaign, 10),
        });
      }

      case "stop": {
        const res = await stopCampaign(str(body.id, 60), r.profile, str(body.reason, 200));
        if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
        return NextResponse.json({ ok: true, campaign: summarise(res.campaign) });
      }

      case "delete": {
        const res = await deleteCampaign(str(body.id, 60), r.profile);
        if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
        return NextResponse.json({ ok: true, deleted: res.name });
      }

      case "update": {
        const res = await updateCampaign(str(body.id, 60), r.profile, (body.settings ?? {}) as never);
        if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
        const plan = planQueries(res.campaign.selection, res.campaign.queries);
        return NextResponse.json({
          ok: true,
          campaign: summarise(res.campaign),
          settings: res.campaign.settings,
          plannedQueries: plan.length,
          estimateUsd: estimateUsd(res.campaign.settings),
        });
      }

      case "report": {
        const c = await readCampaign(str(body.id, 60));
        if (!c) return NextResponse.json({ ok: false, error: "No campaign with that id." }, { status: 404 });
        const limit = bounded(body.limit, 1, 50) ?? 10;
        return NextResponse.json({
          ok: true,
          campaign: summarise(c),
          settings: c.settings,
          selection: c.selection,
          queries: c.queries,
          ticks: c.ticks.slice(0, 10),
          plannedQueries: planQueries(c.selection, c.queries).length,
          report: await buildReport(c, limit),
        });
      }

      case "defaults": {
        const defaults = await writeDefaults((body.settings ?? {}) as never);
        return NextResponse.json({ ok: true, defaults });
      }

      default:
        return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 400 });
    }
  } catch (e) {
    log.error("campaigns.failed", { error: e instanceof Error ? e.message : "unknown" });
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Something went wrong." },
      { status: 500 }
    );
  }
}

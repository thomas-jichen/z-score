import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { MAX_PROFILES_PER_RUN, hasToken, isMock, startProfileRun } from "@/lib/apify";
import { COST_PER_PROFILE, toSlug, type Provenance } from "@/lib/enrichment";
import { applyEnrichJob } from "@/lib/enrichApply";
import { migrateIfNeeded, readTeam } from "@/lib/serverState";
import { newJobId, readJob, writeJob, type EnrichJob } from "@/lib/jobs";
import { reserveProfiles } from "@/lib/ratelimit";
import { cleanSlugs, isBad, readJson, str } from "@/lib/validate";
import { log } from "@/lib/log";

/**
 * POST starts an enrichment run and returns a job id.
 * GET  polls that job, and on success folds the profiles into the roster.
 *
 * The split exists because Apify's synchronous endpoint 408s at 300 seconds and
 * a Vercel function caps there too, so nothing here ever waits on a long run. A
 * run therefore survives a page reload, and the job id is what reattaches to it.
 *
 * Unlike before, the **server** writes the results. The roster is shared, so
 * having each client write its own copy would mean several writers racing over
 * one hash. The client gets the people back so it can offer the next hop.
 */

export const maxDuration = 300;

type StartBody = {
  slugs?: unknown;
  kind?: unknown;
  /** SERP mode: the query that surfaced these people. */
  query?: unknown;
  /** Seed mode: which seed each slug came from. Absent for the seeds themselves. */
  via?: unknown;
  hop?: unknown;
};

export async function POST(req: Request) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  if (!hasToken() && !isMock()) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "ZSCORE_APIFY_TOKEN is not set. Add your Apify API token to .env.local, or set ZSCORE_APIFY_MOCK=1 to try the flow without spending.",
      },
      { status: 400 }
    );
  }

  const body = await readJson<StartBody>(req);
  if (isBad(body)) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });

  const requested = cleanSlugs(body.slugs, MAX_PROFILES_PER_RUN);
  if (isBad(requested))
    return NextResponse.json({ ok: false, error: requested.error }, { status: requested.status });

  /**
   * Never pay for someone deleted for good.
   *
   * The enrich path takes slugs from the caller, so it is a way into the roster that
   * does not go through /api/people — and this is the one that costs money. Checked
   * before the spend is reserved, not after.
   */
  await migrateIfNeeded();
  const erased = new Set((await readTeam()).deleted);
  const slugs = requested.filter((s) => !erased.has(s));
  if (slugs.length === 0) {
    return NextResponse.json(
      { ok: false, error: "Those profiles were deleted permanently. Restore them first." },
      { status: 400 }
    );
  }

  const kind = body.kind === "seed" ? "seed" : "serp";
  const hop = Number.isFinite(Number(body.hop)) ? Math.max(0, Math.min(Number(body.hop), 5)) : 0;

  // Reserve the spend before starting the run. Charged per profile, because
  // that is what Apify bills, and reserved up front so a crash mid-run cannot
  // hand the quota back. Mock mode costs nothing, so it is not counted.
  if (!isMock()) {
    const gate = await reserveProfiles(r.profile, slugs.length);
    if (!gate.ok) return NextResponse.json({ ok: false, error: gate.error }, { status: gate.status });
  }

  // No `via` entry means this person was not discovered from someone else: in
  // seed mode they are a hand-supplied starting point, in keyword mode the query
  // found them. Labelling a seed as a keyword hit would be a lie in the one
  // place that has to stay trustworthy, the discovery trace.
  const via = (body.via ?? {}) as Record<string, { seedSlug?: unknown; seedName?: unknown }>;
  const provenance: Record<string, Provenance> = {};
  for (const slug of slugs) {
    const entry = via?.[slug];
    const seedSlug = entry ? toSlug(str(entry.seedSlug, 200)) : null;
    if (seedSlug) {
      provenance[slug] = {
        kind: "pav",
        seedSlug,
        seedName: str(entry?.seedName, 200) || seedSlug,
        hop,
      };
    } else {
      provenance[slug] =
        kind === "seed" ? { kind: "seed" } : { kind: "serp", query: str(body.query, 500) };
    }
  }

  const started = await startProfileRun(slugs);
  if (!started.ok) {
    log.error("enrich.start.failed", { count: slugs.length });
    return NextResponse.json({ ok: false, error: started.error }, { status: 502 });
  }

  const job: EnrichJob = {
    id: newJobId(),
    profile: r.profile,
    kind,
    runId: started.run.runId,
    datasetId: started.run.datasetId,
    slugs,
    provenance,
    hop,
    status: "running",
    startedAt: new Date().toISOString(),
  };

  try {
    await writeJob(job);
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Could not save the job." },
      { status: 500 }
    );
  }

  log.info("enrich.started", {
    count: slugs.length,
    kind,
    hop,
    mock: isMock(),
    estUsd: isMock() ? 0 : Number((slugs.length * COST_PER_PROFILE).toFixed(4)),
  });

  return NextResponse.json({ ok: true, jobId: job.id, count: slugs.length, mock: isMock() });
}

export async function GET(req: Request) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const jobId = new URL(req.url).searchParams.get("jobId");
  if (!jobId) return NextResponse.json({ ok: false, error: "No jobId." }, { status: 400 });

  /**
   * Reading the job is the first thing that can fail, and failing it must not end
   * the run.
   *
   * This used to sit outside any try, so a transient store error threw an
   * unhandled 500 with no JSON body. The client then reported a bare "Enrichment
   * failed (500)" and stopped polling — while Apify carried on and finished a run
   * that had already been paid for. A store hiccup says nothing about the run, so
   * it is reported as a note and the next poll tries again.
   */
  let job;
  try {
    job = await readJob(r.profile, jobId);
  } catch (e) {
    return NextResponse.json({
      ok: true,
      status: "running",
      note: e instanceof Error ? e.message : "Could not read the run just now.",
    });
  }
  if (!job) return NextResponse.json({ ok: false, error: "Job not found." }, { status: 404 });

  /**
   * The apply step lives in lib/enrichApply.ts, because the campaign loop needs
   * exactly it and a second copy of the one step that turns money into data is
   * the last place two implementations should be allowed to drift. This handler
   * is now the HTTP shape around that call, and nothing about the shape changed.
   */
  const result = await applyEnrichJob(job);

  if (result.status === "running") {
    return NextResponse.json({
      ok: true,
      status: "running",
      ...(result.runStatus ? { runStatus: result.runStatus } : {}),
      ...(result.note ? { note: result.note } : {}),
      job,
    });
  }

  if (result.status === "error") {
    return NextResponse.json({ ok: true, status: "error", error: result.error, job });
  }

  if (result.alreadyApplied) {
    return NextResponse.json({ ok: true, status: "done", people: [], job, alreadyApplied: true });
  }

  return NextResponse.json({
    ok: true,
    status: "done",
    people: result.people,
    marks: result.marks,
    newSlugs: result.newSlugs,
    requested: result.requested,
    job,
  });
}

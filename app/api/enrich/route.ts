import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import {
  MAX_PROFILES_PER_RUN,
  getDatasetItems,
  getRunStatus,
  hasToken,
  isMock,
  isTerminal,
  parseProfile,
  startProfileRun,
} from "@/lib/apify";
import { COST_PER_PROFILE, toSlug, type EnrichedProfile, type Provenance } from "@/lib/enrichment";
import { withEnriched, type Marks, type Person, type PersonStatus } from "@/lib/people";
import {
  hydrate,
  mergeState,
  rawKey,
  stateKey,
  type ProfileState,
} from "@/lib/state";
import { migrateIfNeeded, readRoster, readTeam, writePeople } from "@/lib/serverState";
import { newJobId, readJob, writeJob, type EnrichJob } from "@/lib/jobs";
import { reserveProfiles } from "@/lib/ratelimit";
import { get, set } from "@/lib/store";
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

  if (job.status === "error") {
    return NextResponse.json({ ok: true, status: "error", error: job.error, job });
  }
  // Already resolved and already written on an earlier poll.
  if (job.status === "done") {
    return NextResponse.json({ ok: true, status: "done", people: [], job, alreadyApplied: true });
  }

  // `getRunStatus` and `getDatasetItems` already report their own failures rather
  // than throwing, so from here the only unguarded step is the write below, which
  // has its own try.
  const run = await getRunStatus(job.runId);
  if (!run.ok) {
    // A transient poll failure is reported without ending the run.
    return NextResponse.json({ ok: true, status: "running", note: run.error, job });
  }
  if (!isTerminal(run.status)) {
    return NextResponse.json({ ok: true, status: "running", runStatus: run.status, job });
  }

  if (run.status !== "SUCCEEDED") {
    return await fail(job, `Apify run ${run.status.toLowerCase()}.`);
  }

  const data = await getDatasetItems(job.datasetId, job.slugs);
  if (!data.ok) return await fail(job, data.error);

  const profiles: EnrichedProfile[] = [];
  const raw: { slug: string; item: unknown }[] = [];
  for (const item of data.items) {
    // Provenance is keyed by the slug we asked for. The actor echoes it back,
    // but fall through to the first requested slug's provenance if it does not.
    const guess = toSlug(String((item as Record<string, unknown>)?.publicIdentifier ?? ""));
    const attribution = (guess && job.provenance[guess]) || job.provenance[job.slugs[0]];
    const parsed = parseProfile(item, attribution);
    if (parsed) {
      profiles.push(parsed);
      raw.push({ slug: parsed.slug, item });
    }
  }

  try {
    await migrateIfNeeded();
    const roster = await readRoster();

    // Upgrade in place. Someone queued from search keeps their marks, their
    // discovery trace and their addedAt, and simply gains the profile data.
    const people: Person[] = profiles.map((p) => withEnriched(roster[p.slug], p));
    await writePeople(people);

    /**
     * Archive the vendor's own payload, one key per person.
     *
     * Deliberately not on the roster: it is large and never needed to render a
     * screen, and the roster hash is read on every page load. Kept because
     * without it every field we did not think to parse costs a paid re-enrich of
     * the whole roster to recover. A write failure here must not lose the
     * enrichment that was already paid for, so it is best-effort.
     */
    await Promise.all(
      raw.map((r) =>
        set(rawKey(r.slug), r.item).catch((e) =>
          log.warn("enrich.raw.failed", {
            slug: r.slug,
            error: e instanceof Error ? e.message : "unknown",
          })
        )
      )
    );

    // Enriching is an implicit "I want this person", so anyone not already
    // triaged joins the queue. An existing known or rejected mark is left alone.
    const key = stateKey(r.profile);
    const current = hydrate(await get<Partial<ProfileState>>(key));
    const marks: Marks = { ...current.marks };
    const at = new Date().toISOString();
    for (const p of people) {
      if (!marks[p.slug]) marks[p.slug] = { status: "queued" as PersonStatus, at };
    }
    await set(key, mergeState(current, { marks }));

    job.status = "done";
    job.resultCount = people.length;
    job.finishedAt = at;
    await writeJob(job);

    log.info("enrich.done", {
      requested: job.slugs.length,
      returned: people.length,
      mock: isMock(),
      usd: isMock() ? 0 : Number((job.slugs.length * COST_PER_PROFILE).toFixed(4)),
    });

    return NextResponse.json({
      ok: true,
      status: "done",
      people,
      marks,
      // The client tags these next, so extraction is retryable on its own rather
      // than making the last poll of a long run carry the whole LLM batch.
      newSlugs: people.map((p) => p.slug),
      requested: job.slugs.length,
      job,
    });
  } catch (e) {
    return await fail(job, e instanceof Error ? e.message : "Could not save the results.");
  }
}

async function fail(job: EnrichJob, error: string) {
  job.status = "error";
  job.error = error;
  job.finishedAt = new Date().toISOString();
  await writeJob(job);
  log.error("enrich.failed", { requested: job.slugs.length, error });
  return NextResponse.json({ ok: true, status: "error", error, job });
}

import { getDatasetItems, getRunStatus, isMock, isTerminal, parseProfile } from "./apify";
import { COST_PER_PROFILE, toSlug, type EnrichedProfile } from "./enrichment";
import { writeJob, type EnrichJob } from "./jobs";
import { withEnriched, type Marks, type Person, type PersonStatus } from "./people";
import { addPeopleCapped, migrateIfNeeded, readRoster } from "./serverState";
import { hydrate, mergeState, rawKey, stateKey, type ProfileState } from "./state";
import { get, set } from "./store";
import { log } from "./log";

/**
 * Collect a paid enrichment run and fold it into the roster.
 *
 * ── Why this is its own file ──────────────────────────────────────────────
 * This used to live inside the `GET` handler of app/api/enrich/route.ts, which
 * made polling the *apply* step rather than a status probe: if nobody polled, the
 * Apify run still completed, the money was still spent, and the roster never
 * changed. That was survivable while a browser tab was the only caller and one
 * was always open.
 *
 * The campaign loop breaks that assumption. It starts runs from a cron with no
 * tab anywhere, so it needs exactly this logic — and a second copy of the one
 * step that turns money into data is the last place two implementations should be
 * allowed to drift. The route and the loop now call the same function.
 *
 * Idempotent by design. A job already `done` returns `alreadyApplied` without
 * rewriting anything, so calling this twice costs a store read and nothing else.
 */

export type ApplyResult =
  | { status: "running"; runStatus?: string; note?: string }
  | {
      status: "done";
      people: Person[];
      marks: Marks;
      newSlugs: string[];
      requested: number;
      alreadyApplied: boolean;
    }
  | { status: "error"; error: string };

export async function applyEnrichJob(job: EnrichJob): Promise<ApplyResult> {
  if (job.status === "error") {
    return { status: "error", error: job.error ?? "The run failed." };
  }
  // Already resolved and already written on an earlier call.
  if (job.status === "done") {
    return {
      status: "done",
      people: [],
      marks: {},
      newSlugs: [],
      requested: job.slugs.length,
      alreadyApplied: true,
    };
  }

  // `getRunStatus` and `getDatasetItems` report their own failures rather than
  // throwing, so from here the only unguarded step is the write below.
  const run = await getRunStatus(job.runId);
  // A transient poll failure is reported without ending the run.
  if (!run.ok) return { status: "running", note: run.error };
  if (!isTerminal(run.status)) return { status: "running", runStatus: run.status };

  if (run.status !== "SUCCEEDED") {
    return await failJob(job, `Apify run ${run.status.toLowerCase()}.`);
  }

  const data = await getDatasetItems(job.datasetId, job.slugs);
  if (!data.ok) return await failJob(job, data.error);

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

    /**
     * Enriching is an implicit "I want this person", so anyone not already
     * triaged joins the queue. An existing known or rejected mark is left alone.
     *
     * Written against `job.profile`, not the caller. The route reached for the
     * requesting profile, which was only ever correct because `readJob` is
     * namespaced per profile so the two could not differ — and inside a library
     * there is no request to ask. The job knows who paid for it.
     */
    const key = stateKey(job.profile);
    const current = hydrate(await get<Partial<ProfileState>>(key));
    const marks: Marks = { ...current.marks };
    const at = new Date().toISOString();
    for (const p of people) {
      if (!marks[p.slug]) marks[p.slug] = { status: "queued" as PersonStatus, at };
    }

    // Capped, unlike the bare `writePeople` this replaces. Enrichment could push
    // the roster past MAX_PEOPLE indefinitely, which is what capRoster exists to
    // stop; the campaign loop would have made that routine.
    const evicted = await addPeopleCapped(people, marks);
    if (evicted.length > 0) log.warn("enrich.evicted", { count: evicted.length });

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

    return {
      status: "done",
      people,
      marks,
      // Tagging is a separate retryable step rather than something the last poll
      // of a long run has to carry.
      newSlugs: people.map((p) => p.slug),
      requested: job.slugs.length,
      alreadyApplied: false,
    };
  } catch (e) {
    return await failJob(job, e instanceof Error ? e.message : "Could not save the results.");
  }
}

async function failJob(job: EnrichJob, error: string): Promise<ApplyResult> {
  job.status = "error";
  job.error = error;
  job.finishedAt = new Date().toISOString();
  await writeJob(job);
  log.error("enrich.failed", { requested: job.slugs.length, error });
  return { status: "error", error };
}

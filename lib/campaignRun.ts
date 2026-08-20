import { MAX_PROFILES_PER_RUN, isMock, startProfileRun } from "./apify";
import {
  AGENT_KEY,
  CAMPAIGNS_KEY,
  KEEP_FOUND,
  KEEP_TICKS,
  MAX_CAMPAIGNS,
  budgetLeft,
  cleanSettings,
  defaultSettings,
  estimateUsd,
  hydrateCampaign,
  mergeTop,
  newCampaignId,
  terminalReason,
  utcDay,
  type Campaign,
  type CampaignSettings,
  type ReportRow,
  type Tick,
} from "./campaign";
import { planQueries, queriesFrom } from "./campaignQueries";
import { buildSearchLabels } from "./tags";
import { tagFresh } from "./campaignTag";
import { scoreOne } from "./candidates";
import { COST_PER_PROFILE, type Provenance } from "./enrichment";
import { applyEnrichJob } from "./enrichApply";
import { newJobId, readJob, writeJob, type EnrichJob } from "./jobs";
import { isSuppressed, personFromHit } from "./people";
import type { ProfileId } from "./profiles";
import { COST_PER_QUERY, EMPTY_SELECTION, type Selection } from "./query";
import { reserveProfiles, reserveSearch } from "./ratelimit";
import { runShards } from "./search";
import {
  migrateIfNeeded,
  queueHits,
  readRoster,
  readTeam,
  rosterSlugs,
  addPeopleCapped,
} from "./serverState";
import { hydrate, mergeState, stateKey, type ProfileState } from "./state";
import { del, get, hdel, hgetall, hset, set, setNx, storeIsEphemeral } from "./store";
import type { Hit } from "./types";
import { log, timed } from "./log";

/**
 * The campaign engine.
 *
 * ── Re-entrant on purpose ─────────────────────────────────────────────────
 * `tickCampaign` does as much as fits in a time budget and returns. It is called
 * by the daily cron, by the button on the Agent screen, and by Claude through
 * MCP — all three the same function, so a tick that ran out of time is simply
 * continued by whoever calls next. That matters because Vercel's Hobby plan
 * allows one cron a day: without re-entrancy a campaign that needed 400 seconds
 * would lose the remainder until tomorrow.
 *
 * There is no stored `phase`. The counters already say where the work got to —
 * `pendingJobId` means finish the enrichment, `searchedToday < searchesPerDay`
 * means keep searching, `lastTickDay !== today` means a new day has begun — and a
 * separate phase field is a second source of truth you can crash between writing
 * and honouring.
 *
 * ── The reservations are not optional ─────────────────────────────────────
 * `reserveSearch` and `reserveProfiles` are called by the API routes, not by the
 * functions they guard. Reaching for `runShards` and `startProfileRun` directly —
 * which this file does, deliberately, to avoid a second copy of the roster
 * policy — bypasses every spend control unless this file reserves for itself.
 * That is the single easiest way to build a runaway loop, so it is done here
 * against the campaign's owner, and the caps that already protect a human
 * protect the agent unchanged.
 */

/** Leaves a minute of the 300s function budget to persist what was done. */
const TICK_BUDGET_MS = 240_000;

/**
 * Queries per sweep request, matching what the sweep route sends.
 *
 * Also the blast radius of one rate-limit unit: `reserveSearch` charges per
 * request, not per query, so a hundred queries costs four units of a hundred and
 * twenty an hour rather than a hundred of them.
 */
const QUERIES_PER_REQUEST = 25;

/** Long enough that a crashed holder cannot block a campaign past its function timeout. */
const LOCK_SECONDS = 300;

const lockKey = (id: string) => `zscore:campaign:lock:${id}`;

/* ── Store ──────────────────────────────────────────────────────────────── */

export async function readCampaign(id: string): Promise<Campaign | null> {
  const raw = await hgetall<Partial<Campaign>>(CAMPAIGNS_KEY);
  return hydrateCampaign(raw[id] ?? null);
}

export async function listCampaigns(): Promise<Campaign[]> {
  const raw = await hgetall<Partial<Campaign>>(CAMPAIGNS_KEY);
  return Object.values(raw)
    .map(hydrateCampaign)
    .filter((c): c is Campaign => c !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

async function writeCampaign(c: Campaign): Promise<void> {
  await hset(CAMPAIGNS_KEY, { [c.id]: c });
}

/* ── Team defaults ──────────────────────────────────────────────────────── */

/**
 * The numbers a new campaign starts from.
 *
 * Stored rather than hardcoded so the team's own preference is the default, and
 * readable by both the Agent screen and Claude, so neither has to guess what the
 * other would have chosen.
 */
export async function readDefaults(): Promise<CampaignSettings> {
  const stored = await get<{ defaults?: Partial<CampaignSettings> }>(AGENT_KEY);
  return cleanSettings(stored?.defaults, defaultSettings());
}

export async function writeDefaults(next: Partial<CampaignSettings>): Promise<CampaignSettings> {
  const merged = cleanSettings(next, await readDefaults());
  await set(AGENT_KEY, {
    defaults: merged,
    updatedAt: new Date().toISOString(),
  });
  return merged;
}

/* ── Create, update, stop ───────────────────────────────────────────────── */

export type CreateInput = {
  name: string;
  selection?: Partial<Selection>;
  queries?: string[];
  settings?: Partial<Record<keyof CampaignSettings, unknown>>;
};

export type CreateResult =
  | { ok: true; campaign: Campaign; plannedQueries: number; estimateUsd: number; warnings: string[] }
  | { ok: false; error: string };

export async function createCampaign(owner: ProfileId, input: CreateInput): Promise<CreateResult> {
  /**
   * A week-long campaign on the file backend under Vercel vanishes on the next
   * cold start, having spent real money on the way. Refuse rather than discover.
   */
  if (storeIsEphemeral()) {
    return {
      ok: false,
      error:
        "No database is attached, so a campaign would not survive a restart. Add an Upstash Redis integration and redeploy first.",
    };
  }

  const name = (input.name ?? "").trim().slice(0, 80);
  if (!name) return { ok: false, error: "A campaign needs a name." };

  const selection: Selection = { ...EMPTY_SELECTION };
  for (const key of Object.keys(EMPTY_SELECTION) as (keyof Selection)[]) {
    const given = input.selection?.[key];
    if (Array.isArray(given)) {
      selection[key] = given
        .filter((v): v is string => typeof v === "string")
        .map((v) => v.trim().slice(0, 80))
        .filter(Boolean)
        .slice(0, 40);
    }
  }
  const queries = (input.queries ?? [])
    .filter((q): q is string => typeof q === "string")
    .map((q) => q.trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 50);

  const plan = planQueries(selection, queries);
  if (plan.length === 0) {
    return {
      ok: false,
      error:
        "Nothing to search. Give a selection drawn from the taxonomy, or at least one query of your own.",
    };
  }

  const all = await listCampaigns();
  /**
   * One at a time.
   *
   * Every running campaign shares the same single daily cron invocation and its
   * 240 second budget. Two at a hundred queries each plus enrichment do not fit,
   * so the second would quietly starve. Advancing by hand or through Claude is
   * the pressure valve.
   */
  const running = all.find((c) => c.status === "running");
  if (running) {
    return {
      ok: false,
      error: `"${running.name}" is still running, on day ${running.day} of ${running.settings.days}. Stop it first, or advance this one by hand. They share one daily run and would starve each other.`,
    };
  }

  const settings = cleanSettings(input.settings, await readDefaults());
  const warnings: string[] = [];
  const wanted = settings.days * settings.searchesPerDay;
  if (plan.length < wanted) {
    warnings.push(
      `The selection yields ${plan.length} distinct ${plan.length === 1 ? "query" : "queries"}, and the schedule asks for ${wanted}. It will finish early unless you widen the selection or add queries of your own.`
    );
  }
  if (settings.enrichPerDay > MAX_PROFILES_PER_RUN) {
    warnings.push(
      `Enrichment is capped at ${MAX_PROFILES_PER_RUN} a run by ZSCORE_APIFY_MAX_PER_RUN, so ${settings.enrichPerDay} a day will be chunked.`
    );
  }

  const now = new Date().toISOString();
  const campaign: Campaign = {
    id: newCampaignId(),
    owner,
    name,
    status: "running",
    selection,
    queries,
    settings,
    day: 0,
    lastTickDay: null,
    queryCursor: 0,
    searchedToday: 0,
    queuedToday: 0,
    enrichedToday: 0,
    pendingJobId: null,
    spentUsd: 0,
    top: [],
    found: [],
    foundCount: 0,
    ticks: [],
    createdAt: now,
  };

  await writeCampaign(campaign);
  await evictOldCampaigns(all);
  log.info("campaign.created", { id: campaign.id, owner, plan: plan.length });

  return { ok: true, campaign, plannedQueries: plan.length, estimateUsd: estimateUsd(settings), warnings };
}

/** Oldest finished ones go first, so the hash cannot grow without bound. */
async function evictOldCampaigns(all: Campaign[]): Promise<void> {
  if (all.length < MAX_CAMPAIGNS) return;
  const terminal = all.filter((c) => c.status !== "running").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const drop = terminal.slice(0, all.length - MAX_CAMPAIGNS + 1).map((c) => c.id);
  if (drop.length > 0) await hdel(CAMPAIGNS_KEY, drop);
}

/**
 * Forget a finished campaign.
 *
 * Only the record goes: the people it queued stay in the roster, because they
 * were found on their merits and the campaign was just what pointed at them.
 * A running campaign has to be stopped first — deleting one mid-tick would leave
 * its lock held and its pending Apify run uncollected, which is money already
 * spent going nowhere.
 */
export async function deleteCampaign(
  id: string,
  owner: ProfileId
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const c = await readCampaign(id);
  if (!c) return { ok: false, error: "No campaign with that id." };
  if (c.owner !== owner) return { ok: false, error: `That campaign belongs to ${c.owner}.` };
  if (c.status === "running") {
    return { ok: false, error: "Stop it first. A running campaign may have work in flight." };
  }
  await hdel(CAMPAIGNS_KEY, [id]);
  log.info("campaign.deleted", { id, found: c.foundCount });
  return { ok: true, name: c.name };
}

/** Any setting, at any time, including mid-run. Raising a ceiling on day four is one call. */
export async function updateCampaign(
  id: string,
  owner: ProfileId,
  settings: Partial<Record<keyof CampaignSettings, unknown>>
): Promise<{ ok: true; campaign: Campaign } | { ok: false; error: string }> {
  const c = await readCampaign(id);
  if (!c) return { ok: false, error: "No campaign with that id." };
  if (c.owner !== owner) return { ok: false, error: `That campaign belongs to ${c.owner}.` };

  const next: Campaign = { ...c, settings: cleanSettings(settings, c.settings) };
  /**
   * A campaign that finished goes back to running when the thing that finished it
   * is no longer true.
   *
   * `terminalReason` is already the single answer to "should this stop", so
   * asking it again against the new settings is the whole rule: raise a ceiling
   * it hit, or the day count it ran out of, and it carries on. Raising money on a
   * campaign whose query plan is used up still stands finished, because no
   * setting can refill the plan — only widening the selection does that, and that
   * is not what this call changes.
   *
   * `stopped` is excluded deliberately. Somebody stopped it on purpose, and a
   * settings edit is not the same as saying start again.
   */
  if (next.status === "done") {
    const stillOver = terminalReason(next, planQueries(next.selection, next.queries).length);
    if (stillOver === null) {
      next.status = "running";
      next.finishedReason = undefined;
      next.finishedAt = undefined;
    } else {
      // It stays finished, but not necessarily for the reason it first gave. Raise
      // the days on a campaign that ran out of both and the row would still read
      // "ran its full 1 day", which is no longer true and hides the real blocker.
      next.finishedReason = stillOver;
    }
  }
  await writeCampaign(next);
  return { ok: true, campaign: next };
}

export async function stopCampaign(
  id: string,
  owner: ProfileId,
  reason?: string
): Promise<{ ok: true; campaign: Campaign } | { ok: false; error: string }> {
  const c = await readCampaign(id);
  if (!c) return { ok: false, error: "No campaign with that id." };
  if (c.owner !== owner) return { ok: false, error: `That campaign belongs to ${c.owner}.` };
  if (c.status !== "running") return { ok: true, campaign: c };

  const next: Campaign = {
    ...c,
    status: "stopped",
    finishedReason: reason?.trim().slice(0, 200) || "stopped by hand",
    finishedAt: new Date().toISOString(),
  };
  await writeCampaign(next);
  return { ok: true, campaign: next };
}

/* ── The tick ───────────────────────────────────────────────────────────── */

export type TickResult = {
  campaign: Campaign;
  tick: Tick | null;
  /** Set when the tick did nothing, and why. */
  note?: string;
};

export async function tickCampaign(id: string, budgetMs = TICK_BUDGET_MS): Promise<TickResult> {
  const deadline = Date.now() + budgetMs;

  const existing = await readCampaign(id);
  if (!existing) throw new Error("No campaign with that id.");

  /**
   * A real lock, because the cron can fire while Claude is calling advance.
   * Without it both would search and both would start an enrichment run, and the
   * second is money spent twice for one day's work.
   */
  const won = await setNx(lockKey(id), new Date().toISOString(), LOCK_SECONDS);
  if (!won) {
    return { campaign: existing, tick: null, note: "Another advance is already running." };
  }

  try {
    return await runTick(existing, deadline);
  } finally {
    await del(lockKey(id));
  }
}

async function runTick(start: Campaign, deadline: number): Promise<TickResult> {
  await migrateIfNeeded();
  let c: Campaign = { ...start };
  const notes: string[] = [];
  let enrichedNow: string[] = [];
  let queuedNow = 0;
  let hitsNow = 0;
  let queriesNow = 0;
  let usdNow = 0;

  if (c.status !== "running") {
    return { campaign: c, tick: null, note: `This campaign is ${c.status}.` };
  }

  /**
   * 1. Drain first.
   *
   * An enrichment already paid for is collected before anything new is started.
   * With one cron a day, deferring this would mean the results of every day
   * landing a day late and the last day's never landing at all.
   */
  if (c.pendingJobId) {
    const job = await readJob(c.owner, c.pendingJobId).catch(() => null);
    if (!job) {
      notes.push("A pending enrichment run could not be read, so it was dropped.");
      c.pendingJobId = null;
    } else {
      const applied = await applyEnrichJob(job);
      if (applied.status === "done") {
        enrichedNow = applied.newSlugs;
        c.pendingJobId = null;
      } else if (applied.status === "error") {
        notes.push(`Enrichment failed: ${applied.error}`);
        c.pendingJobId = null;
      } else {
        // Still running. Leave it pending and let the next call collect it.
        notes.push("An enrichment run from the last advance has not landed yet.");
      }
    }
  }

  // 2. A new UTC day resets the per-day counters. The day counter never depends
  //    on when the cron actually fired, only on the date it fired on.
  const today = utcDay();
  if (c.lastTickDay !== today) {
    c.day += 1;
    c.lastTickDay = today;
    c.searchedToday = 0;
    c.queuedToday = 0;
    c.enrichedToday = 0;
  }

  const plan = planQueries(c.selection, c.queries);

  /**
   * Nothing left to do today.
   *
   * Said out loud rather than returned as a row of zeros, because `advance` is
   * safe to call repeatedly and somebody calling it twice deserves to be told the
   * day is already spent rather than left wondering whether it worked.
   */
  const dayDone =
    c.searchedToday >= c.settings.searchesPerDay &&
    c.queuedToday >= c.settings.queuePerDay &&
    !c.pendingJobId;

  // 3. Terminal?
  const reason = terminalReason(c, plan.length);
  if (reason) {
    c.status = "done";
    c.finishedReason = reason;
    c.finishedAt = new Date().toISOString();
    await writeCampaign(c);
    return { campaign: c, tick: null, note: `Finished: ${reason}` };
  }

  if (dayDone && enrichedNow.length === 0) {
    await writeCampaign(c);
    return {
      campaign: c,
      tick: null,
      note: `Day ${c.day} is already done: ${c.searchedToday} searches run and ${c.queuedToday} people queued. The next day begins after midnight UTC.`,
    };
  }

  const team = await readTeam();
  const marks = hydrate(await get<Partial<ProfileState>>(stateKey(c.owner))).marks;

  /* 4. Search. */
  const wantQueries = Math.min(
    c.settings.searchesPerDay - c.searchedToday,
    plan.length - c.queryCursor
  );
  const collected: Hit[] = [];
  const seenSlug = new Set<string>();
  const held = await rosterSlugs();

  if (wantQueries > 0) {
    const batch = queriesFrom(plan, c.queryCursor, wantQueries);
    for (let i = 0; i < batch.length; i += QUERIES_PER_REQUEST) {
      if (Date.now() > deadline) {
        notes.push("Ran out of time mid-search; the next advance picks up where this stopped.");
        break;
      }
      const chunk = batch.slice(i, i + QUERIES_PER_REQUEST);

      // The reservation the route would have done. Without this the loop has no
      // rate limit at all.
      const gate = await reserveSearch(c.owner);
      if (!gate.ok) {
        notes.push(`Search paused: ${gate.error}`);
        break;
      }

      const results = await timed("campaign.search", { id: c.id, queries: chunk.length }, () =>
        runShards(
          chunk.map((query, n) => ({ id: `c${i + n}`, query })),
          5
        )
      );

      c.queryCursor += chunk.length;
      c.searchedToday += chunk.length;
      queriesNow += chunk.length;
      usdNow += chunk.length * COST_PER_QUERY;

      for (const r of results) {
        if (r.error) {
          notes.push(`A query failed: ${r.error}`);
          continue;
        }
        for (const hit of r.hits) {
          if (!hit.slug || seenSlug.has(hit.slug)) continue;
          seenSlug.add(hit.slug);
          hitsNow += 1;
          // Already ours, already triaged, or erased for good: not a find.
          if (held.has(hit.slug)) continue;
          if (isSuppressed(marks[hit.slug])) continue;
          if (team.deleted.includes(hit.slug)) continue;
          collected.push(hit);
        }
      }
      // Persist the cursor as we go, so a crash costs at most one chunk.
      await writeCampaign({ ...c, spentUsd: c.spentUsd + usdNow });
    }
  }

  /* 5. Rank and take. */
  const room = Math.max(0, c.settings.queuePerDay - c.queuedToday);
  let queuedRows: ReportRow[] = [];
  if (collected.length > 0 && room > 0) {
    const ranked = rankHits(collected, c, team);
    const take = ranked.filter((r) => r.score >= c.settings.scoreBar).slice(0, room);

    if (take.length > 0) {
      const res = await queueHits(
        c.owner,
        take.map((r) => r.hit),
        { query: `campaign:${c.name}`, selection: c.selection, marks }
        // No `reviveRejected`. A campaign must never undo human triage.
      );
      if (res.slugs.length > 0) {
        const at = new Date().toISOString();
        const patched = await patchQueuedMarks(c.owner, res.slugs);
        await addPeopleCapped(res.people, patched);

        queuedNow = res.slugs.length;
        c.queuedToday += res.slugs.length;
        c.foundCount += res.slugs.length;
        c.found = [...res.slugs, ...c.found].slice(0, KEEP_FOUND);
        queuedRows = take
          .filter((r) => res.slugs.includes(r.hit.slug))
          .map((r) => ({ ...r.row, day: c.day, at }));
        c.top = mergeTop(c.top, queuedRows);
      }
      if (res.blocked > 0) {
        notes.push(`${res.blocked} were skipped as permanently deleted.`);
      }
    }
  }

  /* 6. Enrich. One run, chunked, with the job id persisted before any waiting. */
  const canSpend = budgetLeft(c);
  const enrichRoom = Math.min(
    c.settings.enrichPerDay - c.enrichedToday,
    MAX_PROFILES_PER_RUN,
    canSpend === Infinity ? Number.MAX_SAFE_INTEGER : Math.floor(canSpend / COST_PER_PROFILE)
  );

  if (enrichRoom > 0 && !c.pendingJobId && Date.now() < deadline) {
    const targets = await pickForEnrichment(c, enrichRoom);
    if (targets.length > 0) {
      const gate = isMock() ? { ok: true as const } : await reserveProfiles(c.owner, targets.length);
      if (!gate.ok) {
        notes.push(`Enrichment paused: ${gate.error}`);
      } else {
        const started = await timed("campaign.enrich", { id: c.id, count: targets.length }, () =>
          startProfileRun(targets)
        );
        if (!started.ok) {
          notes.push(`Enrichment could not start: ${started.error}`);
        } else {
          const job: EnrichJob = {
            id: newJobId(),
            profile: c.owner,
            kind: "serp",
            runId: started.run.runId,
            datasetId: started.run.datasetId,
            slugs: targets,
            provenance: Object.fromEntries(
              targets.map((s) => [s, { kind: "serp", query: `campaign:${c.name}` } as Provenance])
            ),
            hop: 0,
            status: "running",
            startedAt: new Date().toISOString(),
          };
          await writeJob(job);

          /**
           * Persisted before a single millisecond of waiting.
           *
           * A crash between starting the run and recording its id is a paid Apify
           * run nobody will ever collect. The money is already gone at this point,
           * so the id is the only thing standing between that and wasted spend.
           */
          c.pendingJobId = job.id;
          c.enrichedToday += targets.length;
          usdNow += targets.length * (isMock() ? 0 : COST_PER_PROFILE);
          await writeCampaign({ ...c, spentUsd: c.spentUsd + usdNow });

          const applied = await pollUntil(job, deadline);
          if (applied.status === "done") {
            enrichedNow = [...enrichedNow, ...applied.newSlugs];
            c.pendingJobId = null;
          } else if (applied.status === "error") {
            /**
             * Spent, not retryable. Apify bills a refused run, and
             * `reserveProfiles` has already burned the quota, so the campaign
             * records the loss and stops trying that size rather than paying the
             * same toll again tomorrow.
             */
            notes.push(`Enrichment failed: ${applied.error}`);
            c.pendingJobId = null;
            if (/limited to \d+ items|10 items/i.test(applied.error)) {
              c.settings = { ...c.settings, enrichPerDay: Math.min(c.settings.enrichPerDay, 10) };
              notes.push("Enrichment per day was reduced to 10, which is this Apify plan's limit.");
            }
          } else {
            notes.push("The enrichment run had not landed when time ran out; it stays pending.");
          }
        }
      }
    }
  }

  /* 7. Tag whatever just landed, while there is time. */
  let taggedNow = 0;
  if (enrichedNow.length > 0 && Date.now() < deadline) {
    const res = await tagFresh(c.owner, enrichedNow, deadline);
    taggedNow = res.tagged;
    if (res.note) notes.push(res.note);
  }

  /* 8. Record and persist. */
  const tick: Tick = {
    at: new Date().toISOString(),
    day: c.day,
    queries: queriesNow,
    hits: hitsNow,
    queued: queuedNow,
    enriched: enrichedNow.length,
    tagged: taggedNow,
    usd: Number(usdNow.toFixed(4)),
    note: notes.length > 0 ? notes.join(" ") : undefined,
  };

  c.spentUsd = Number((c.spentUsd + usdNow).toFixed(4));
  c.ticks = [tick, ...c.ticks].slice(0, KEEP_TICKS);
  c.lastTickAt = tick.at;

  // A campaign that has just spent its last dollar or run its last query should
  // say so now rather than on the next call.
  const after = terminalReason({ ...c, day: c.day + (c.day >= c.settings.days ? 1 : 0) }, plan.length);
  if (after && (c.spentUsd >= c.settings.budgetUsd || c.queryCursor >= plan.length)) {
    c.status = "done";
    c.finishedReason = after;
    c.finishedAt = tick.at;
  }

  await writeCampaign(c);
  log.info("campaign.tick", {
    id: c.id,
    day: c.day,
    queries: queriesNow,
    queued: queuedNow,
    enriched: enrichedNow.length,
    usd: tick.usd,
  });

  return { campaign: c, tick };
}

/* ── Report ─────────────────────────────────────────────────────────────── */

export type ReportPerson = ReportRow & {
  /** True when the roster no longer holds them, so the row is the snapshot. */
  evicted: boolean;
  /** The terms that actually produced the score, biggest first. Empty for a snapshot. */
  signals: { label: string; points: number }[];
};

/**
 * The top of what this campaign found.
 *
 * Re-scored from the live roster wherever the person is still there, because a
 * search-only find that got enriched on day five has a real score now and the
 * snapshot taken on day one does not know it. Anyone the roster has since evicted
 * falls back to the snapshot and is marked, so the report never silently shrinks.
 */
export async function buildReport(c: Campaign, limit = 10): Promise<ReportPerson[]> {
  const [roster, team] = await Promise.all([readRoster(), readTeam()]);
  const out: ReportPerson[] = c.top.map((row) => {
    const person = roster[row.slug];
    if (!person) return { ...row, evicted: true, signals: [] };
    const scored = scoreOne(person, team.taxonomy);
    return {
      ...row,
      name: person.name || row.name,
      headline: person.headline || row.headline,
      score: scored.score,
      archetype: scored.archetype,
      enriched: Boolean(person.enriched),
      evicted: false,
      signals: scored.signals
        .filter((sg) => sg.points > 0)
        .slice(0, 3)
        .map((sg) => ({ label: sg.label, points: sg.points })),
    };
  });
  return out.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, limit);
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

/**
 * Rank a day's hits.
 *
 * Confirmed search terms lead, and that is the whole point. `scoreOne` on a
 * search-only person reads almost nothing — no structured fields, no counts, only
 * programme and accelerator names text-matched against a headline and a snippet —
 * so it lands between zero and about one and a half, usually zero. Sorting by it
 * alone would be sorting noise.
 *
 * `buildSearchLabels` exists for exactly this decision: it cross-checks each of
 * the campaign's own search terms against the person's own text, so a term that
 * only appeared because an OR group matched something else is not counted. A hit
 * whose text confirms two of the terms you asked for is a better hit than one
 * that confirms none, whatever either of them scores before enrichment.
 */
function rankHits(
  hits: Hit[],
  c: Campaign,
  team: Awaited<ReturnType<typeof readTeam>>
): { hit: Hit; row: ReportRow; score: number; confirmed: number }[] {
  const rows = hits.map((hit) => {
    const person = personFromHit(hit, { query: `campaign:${c.name}`, labels: [] });
    const scored = scoreOne(person, team.taxonomy);
    const confirmed = confirmedTerms(hit, c.selection);
    return {
      hit,
      score: scored.score,
      confirmed: confirmed.length,
      row: {
        slug: hit.slug,
        name: hit.name || hit.slug,
        headline: hit.headline,
        url: hit.url,
        score: scored.score,
        archetype: scored.archetype,
        confirmed,
        enriched: false,
        day: c.day,
        at: new Date().toISOString(),
      } as ReportRow,
    };
  });

  return rows.sort(
    (a, b) =>
      b.confirmed - a.confirmed ||
      b.score - a.score ||
      Number(FOUNDER_WORD.test(b.hit.headline)) - Number(FOUNDER_WORD.test(a.hit.headline)) ||
      a.hit.slug.localeCompare(b.hit.slug)
  );
}

/** Which of the campaign's terms this person's own text backs up. */
function confirmedTerms(hit: Hit, selection: Selection): string[] {
  return buildSearchLabels(`${hit.name} ${hit.headline} ${hit.snippet}`, selection)
    .filter((l) => l.confirmed)
    .map((l) => l.label);
}

const FOUNDER_WORD = /\b(founder|co-?founder|founding|ceo|cto|building)\b/i;

/**
 * Who to pay for next: the campaign's own highest-ranked finds that are still
 * search-only. Enriching someone already enriched is money spent twice for
 * nothing, and enriching someone another campaign found is not this campaign's
 * job.
 */
async function pickForEnrichment(c: Campaign, room: number): Promise<string[]> {
  const roster = await readRoster();
  const mine = c.top.filter((r) => !roster[r.slug]?.enriched);
  const ordered = [...mine].sort((a, b) => b.confirmed.length - a.confirmed.length || b.score - a.score);
  return ordered.slice(0, room).map((r) => r.slug);
}

/** Poll an enrichment run until it lands or the clock runs out. */
async function pollUntil(job: EnrichJob, deadline: number) {
  let applied = await applyEnrichJob(job);
  while (applied.status === "running" && Date.now() < deadline - 5_000) {
    await new Promise((r) => setTimeout(r, 4_000));
    const fresh = (await readJob(job.profile, job.id).catch(() => null)) ?? job;
    applied = await applyEnrichJob(fresh);
  }
  return applied;
}

/** Mark the campaign's finds as queued for its owner, without reviving a rejection. */
async function patchQueuedMarks(owner: ProfileId, slugs: string[]) {
  const key = stateKey(owner);
  const current = hydrate(await get<Partial<ProfileState>>(key));
  const marks = { ...current.marks };
  const at = new Date().toISOString();
  for (const slug of slugs) {
    if (!marks[slug]) marks[slug] = { status: "queued", at };
  }
  await set(key, mergeState(current, { marks }));
  return marks;
}

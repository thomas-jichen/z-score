import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { AuthInfo } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MAX_PROFILES_PER_RUN, isMock, startProfileRun } from "@/lib/apify";
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
import { scoreOne } from "@/lib/candidates";
import { COST_PER_PROFILE, neighborsOf, toSlug } from "@/lib/enrichment";
import { applyEnrichJob } from "@/lib/enrichApply";
import { newJobId, readJob, writeJob, type EnrichJob } from "@/lib/jobs";
import { verifyMcpToken } from "@/lib/mcpTokens";
import { isSuppressed, neighborsFrom } from "@/lib/people";
import type { ProfileId } from "@/lib/profiles";
import { COST_PER_QUERY, EMPTY_SELECTION, type Selection } from "@/lib/query";
import { reserveProfiles, reserveSearch } from "@/lib/ratelimit";
import { runShards } from "@/lib/search";
import {
  migrateIfNeeded,
  queueHits,
  readRoster,
  readTeam,
  rosterSlugs,
  addPeopleCapped,
} from "@/lib/serverState";
import { hydrate, mergeState, stateKey, type ProfileState } from "@/lib/state";
import { get, set } from "@/lib/store";
import { dominantSignals } from "@/lib/zscore";
import { log } from "@/lib/log";

/**
 * The MCP server.
 *
 * ── In process, not over HTTP ─────────────────────────────────────────────
 * Every tool calls the same server-side functions the browser routes call —
 * `queueHits`, `tickCampaign`, `runShards`, `scoreOne`. It does not make
 * authenticated requests back to /api/*, which would mean minting cookies for
 * ourselves and keeping a second copy of the validation.
 *
 * The cost of that shortcut is that the rate limiters do not come along for the
 * ride: `reserveSearch` and `reserveProfiles` live in the routes, not in the
 * functions they guard. So every tool here that spends reserves first, against
 * the token owner, and the caps that already protect a human protect the agent.
 *
 * ── What it may not do ────────────────────────────────────────────────────
 * No tool deletes a person, resets the roster, edits a taxonomy weight, or marks
 * anyone known or rejected. Triage is a judgement about a person and it stays
 * with the people who have to make the call. `destructiveHint` is absent
 * throughout because there is nothing destructive to hint at.
 */

export const maxDuration = 300;

/* ── Identity ───────────────────────────────────────────────────────────── */

/**
 * Who is calling.
 *
 * One helper so the shape of the SDK's auth context appears once. In this major
 * it arrives at `ctx.http.authInfo`; keeping the reach in a single place means a
 * version bump is four lines rather than ten tool bodies.
 */
function identity(ctx: unknown): ProfileId {
  const info = (ctx as { http?: { authInfo?: AuthInfo } })?.http?.authInfo;
  const owner = (info?.extra as { owner?: string } | undefined)?.owner;
  if (!owner) throw new Error("This tool needs an authenticated token.");
  return owner as ProfileId;
}

const verifyToken = async (_req: Request, bearer?: string): Promise<AuthInfo | undefined> => {
  const record = await verifyMcpToken(bearer);
  if (!record) return undefined;
  return {
    token: bearer as string,
    scopes: ["zscore"],
    clientId: record.owner,
    extra: { owner: record.owner, label: record.label },
  };
};

/* ── Shapes shared by several tools ─────────────────────────────────────── */

const selectionSchema = z
  .object({
    programs: z.array(z.string().max(80)).max(40).optional(),
    titles: z.array(z.string().max(80)).max(40).optional(),
    colleges: z.array(z.string().max(80)).max(40).optional(),
    highSchools: z.array(z.string().max(80)).max(40).optional(),
    years: z.array(z.string().max(8)).max(20).optional(),
    states: z.array(z.string().max(40)).max(40).optional(),
    homeStates: z.array(z.string().max(40)).max(40).optional(),
  })
  .describe(
    "Categories from the taxonomy. Values must match list_taxonomy exactly: 'Stanford', not 'Stanford University'."
  );

/**
 * The six numbers, accepted two ways.
 *
 * Every one of these is reachable both nested under `settings` and flat beside
 * `name`, because both are a reasonable guess at the shape and zod quietly
 * discards keys it does not know. A caller that writes `days: 2, budgetUsd: 0.3`
 * at the top level and is handed a seven-day campaign with a $5 ceiling has been
 * failed in silence, and this is the one place in the server where silence costs
 * money. `.strict()` on the tools below is the other half: a misspelled key is
 * now a sentence the caller can read and correct.
 */
const SETTINGS_SHAPE = {
    days: z.number().int().min(LIMITS.days.min).max(LIMITS.days.max).optional(),
    searchesPerDay: z
      .number()
      .int()
      .min(LIMITS.searchesPerDay.min)
      .max(LIMITS.searchesPerDay.max)
      .optional(),
    queuePerDay: z
      .number()
      .int()
      .min(LIMITS.queuePerDay.min)
      .max(LIMITS.queuePerDay.max)
      .optional(),
    enrichPerDay: z
      .number()
      .int()
      .min(LIMITS.enrichPerDay.min)
      .max(LIMITS.enrichPerDay.max)
      .optional(),
    budgetUsd: z.number().min(LIMITS.budgetUsd.min).max(LIMITS.budgetUsd.max).optional(),
    scoreBar: z.number().min(LIMITS.scoreBar.min).max(LIMITS.scoreBar.max).optional(),
} as const;

const settingsSchema = z
  .object(SETTINGS_SHAPE)
  .describe("Any subset. Anything omitted keeps its current value, or the team default when new.");

type SettingsPatch = z.infer<typeof settingsSchema>;

/** Nested wins over flat, so sending both is not ambiguous. */
function asSettings(args: SettingsPatch & { settings?: SettingsPatch }): SettingsPatch {
  const flat: SettingsPatch = {};
  for (const key of Object.keys(SETTINGS_SHAPE) as (keyof SettingsPatch)[]) {
    const v = args[key];
    if (v !== undefined) flat[key] = v;
  }
  return { ...flat, ...(args.settings ?? {}) };
}

function asSelection(given?: Record<string, string[] | undefined>): Selection {
  const out: Selection = { ...EMPTY_SELECTION };
  for (const key of Object.keys(EMPTY_SELECTION) as (keyof Selection)[]) {
    const v = given?.[key];
    if (Array.isArray(v)) out[key] = v.filter(Boolean).map((s) => s.trim()).filter(Boolean);
  }
  return out;
}

/** Both shapes, every time: JSON for the client, prose for the model. */
function reply(text: string, data: unknown) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: data as Record<string, unknown>,
  };
}

function failed(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

/* ── The server ─────────────────────────────────────────────────────────── */

const handler = createMcpHandler(
  (server) => {
    /* 1 ─────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "list_taxonomy",
      {
        title: "The searchable vocabulary",
        description: `The exact vocabulary a campaign's selection accepts, grouped by category.

Call this before create_campaign. A value that is not on this list still searches — Google takes any words — but it will not be recognised when the results come back, so those people score zero and never reach the report. Names must match exactly: "Stanford", not "Stanford University".

Filter with facet or q; the whole registry is a few hundred entries.`,
        inputSchema: z.object({
          facet: z
            .enum(["program", "accelerator", "college", "highschool", "title", "company"])
            .optional(),
          q: z.string().max(60).optional().describe("Substring filter, case-insensitive."),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ facet, q }, ctx) => {
        identity(ctx);
        await migrateIfNeeded();
        const team = await readTeam();
        const needle = (q ?? "").trim().toLowerCase();

        const byFacet: Record<string, string[]> = {};
        for (const def of Object.values(team.taxonomy.tags)) {
          if (facet && def.facet !== facet) continue;
          if (needle && !def.label.toLowerCase().includes(needle)) continue;
          (byFacet[def.facet] ??= []).push(def.label);
        }
        for (const list of Object.values(byFacet)) list.sort();

        const data = {
          facets: byFacet,
          years: ["2026", "2027", "2028", "2029", "2030", "2031", "2032", "2033"],
          categoryForFacet: {
            program: "programs",
            accelerator: "programs",
            college: "colleges",
            highschool: "highSchools",
            title: "titles",
          },
          total: Object.values(byFacet).reduce((n, l) => n + l.length, 0),
        };
        return reply(
          `${data.total} names across ${Object.keys(byFacet).length} categories. Use the categoryForFacet map to put each into the right selection key.`,
          data
        );
      }
    );

    /* 2 ─────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "list_campaigns",
      {
        title: "Every campaign",
        description:
          "Every campaign the team has, newest first, one line each. Campaigns another teammate created are readable but not changeable. Use this to find an id.",
        inputSchema: z.object({
          status: z.enum(["running", "done", "stopped"]).optional(),
          mine: z.boolean().default(false).describe("Only the ones this token owns."),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ status, mine }, ctx) => {
        const owner = identity(ctx);
        await migrateIfNeeded();
        let all = await listCampaigns();
        if (status) all = all.filter((c) => c.status === status);
        if (mine) all = all.filter((c) => c.owner === owner);
        const data = { campaigns: all.map(summarise), defaults: await readDefaults() };
        return reply(
          all.length === 0
            ? "No campaigns yet."
            : all
                .map(
                  (c) =>
                    `${c.name} (${c.id}): ${c.status}, day ${c.day} of ${c.settings.days}, ${c.foundCount} found, $${c.spentUsd.toFixed(2)} of $${c.settings.budgetUsd.toFixed(2)}${c.finishedReason ? `, ${c.finishedReason}` : ""}`
                )
                .join("\n"),
          data
        );
      }
    );

    /* 3 ─────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "get_campaign",
      {
        title: "One campaign, in full",
        description: `Everything known about one campaign: its settings, where it has got to, its spend against its ceiling, its recent advances with any failures in plain words, and the best people it found. This is the report.

Each row carries the score, the archetype, and which of the campaign's own search terms the person's own profile actually confirmed — an unconfirmed term is a hypothesis, not a fact about them. Rows are re-scored from the live roster on read, so somebody enriched after they were found shows their real score rather than the two-line one they were found with.`,
        inputSchema: z.object({
          id: z.string().max(60),
          top: z.number().int().min(1).max(50).default(10),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ id, top }, ctx) => {
        identity(ctx);
        await migrateIfNeeded();
        const c = await readCampaign(id);
        if (!c) return failed(`No campaign with id ${id}. Try list_campaigns.`);

        const report = await buildReport(c, top);
        const plan = planQueries(c.selection, c.queries);
        const data = {
          campaign: summarise(c),
          settings: c.settings,
          selection: c.selection,
          queries: c.queries,
          plannedQueries: plan.length,
          queriesRun: c.queryCursor,
          ticks: c.ticks.slice(0, 10),
          report,
        };
        const lines = report.map(
          (p, i) =>
            `${i + 1}. ${p.name}: ${p.score.toFixed(1)}, ${p.archetype}${p.enriched ? "" : ", search only"}${p.confirmed.length ? `, confirmed: ${p.confirmed.join(", ")}` : ""}\n   ${p.headline}\n   ${p.url}`
        );
        return reply(
          `${c.name}: ${c.status}, day ${c.day} of ${c.settings.days}, ${c.queryCursor} of ${plan.length} ${plan.length === 1 ? "query" : "queries"} run, ${c.foundCount} found, $${c.spentUsd.toFixed(3)} spent of $${c.settings.budgetUsd.toFixed(2)}.${c.finishedReason ? ` Finished because it ${c.finishedReason}.` : ""}\n\n${lines.join("\n") || "Nothing found yet."}`,
          data
        );
      }
    );

    /* 4 ─────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "list_queue",
      {
        title: "The ranked queue",
        description:
          "The team's whole queue, ranked: everyone not yet marked known or rejected, across every campaign and everyone added by hand. The same list the Digest screen shows. `signals` is the score broken into the terms that produced it.",
        inputSchema: z.object({
          limit: z.number().int().min(1).max(50).default(10),
          enrichedOnly: z.boolean().default(false),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ limit, enrichedOnly }, ctx) => {
        const owner = identity(ctx);
        await migrateIfNeeded();
        const [roster, team] = await Promise.all([readRoster(), readTeam()]);
        const marks = hydrate(await get<Partial<ProfileState>>(stateKey(owner))).marks;

        const rows = Object.values(roster)
          .filter((p) => (marks[p.slug]?.status ?? "queued") === "queued")
          .filter((p) => !enrichedOnly || p.enriched)
          .map((p) => scoreOne(p, team.taxonomy))
          .sort((a, b) => b.score - a.score);

        const people = rows.slice(0, limit).map((c) => ({
          slug: c.slug,
          name: c.name,
          headline: c.headline,
          url: c.url,
          score: c.score,
          archetype: c.archetype,
          polymath: c.polymath,
          school: c.school,
          gradYear: c.graduation_year,
          enriched: c.enriched,
          signals: dominantSignals(c, 3).map((s) => ({ label: s.label, points: s.points })),
        }));

        return reply(
          `${rows.length} in the queue. Top ${people.length}:\n` +
            people
              .map((p, i) => `${i + 1}. ${p.name}: ${p.score.toFixed(1)}, ${p.archetype}\n   ${p.headline}`)
              .join("\n"),
          { total: rows.length, people }
        );
      }
    );

    /* 5 ─────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "create_campaign",
      {
        title: "Start an autonomous search",
        description: `Start a multi-day search that runs itself.

Nothing runs at creation. The campaign sits at day 0 until the daily cron, an advance_campaign call, or the Advance button on the site moves it. Each day it runs up to searchesPerDay Google queries built from the selection and queries, queues the most promising people it does not already have, and pays to enrich up to enrichPerDay of them.

It stops on whichever comes first: days elapsed, budgetUsd spent, or the queries running out.

Money. A search costs $${COST_PER_QUERY} and is not the concern. Enrichment costs $${COST_PER_PROFILE} a profile, is charged whether or not the profile comes back, and is the only real spend. budgetUsd is a hard ceiling, not a target.

Read plannedQueries in the response. If it is far below days x searchesPerDay the selection is too narrow to fill the schedule and the campaign will finish early — widen the selection or add queries of your own. warnings will say so.

Only one campaign runs at a time, because they share a single daily run and would starve each other.`,
        inputSchema: z.object({
          name: z.string().min(1).max(80),
          selection: selectionSchema.optional(),
          queries: z
            .array(z.string().max(300))
            .max(50)
            .optional()
            .describe(
              "Hand-written Google queries for anything the vocabulary cannot express, such as a minus term or a quoted phrase. site:linkedin.com/in is added if absent."
            ),
          settings: settingsSchema.optional(),
          ...SETTINGS_SHAPE,
        }).strict(),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      },
      async (args, ctx) => {
        const { name, selection, queries } = args;
        const owner = identity(ctx);
        await migrateIfNeeded();
        const result = await createCampaign(owner, {
          name,
          selection: asSelection(selection),
          queries: queries ?? [],
          settings: asSettings(args),
        });
        if (!result.ok) return failed(result.error);

        const { campaign, plannedQueries, warnings } = result;
        const s = campaign.settings;
        return reply(
          `Created "${campaign.name}" (${campaign.id}).\n` +
            `${s.days} days, up to ${s.searchesPerDay} searches and ${s.queuePerDay} queued a day, ${s.enrichPerDay} enriched a day, ceiling $${s.budgetUsd.toFixed(2)}.\n` +
            `${plannedQueries} distinct ${plannedQueries === 1 ? "query" : "queries"} planned. Estimated full run $${estimateUsd(s).toFixed(2)}.\n` +
            `Nothing has run yet — it advances once a day, or call advance_campaign to start now.` +
            (warnings.length ? `\n\nWorth knowing: ${warnings.join(" ")}` : ""),
          {
            id: campaign.id,
            campaign: summarise(campaign),
            settings: s,
            plannedQueries,
            estimateUsd: estimateUsd(s),
            warnings,
          }
        );
      }
    );

    /* 6 ─────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "advance_campaign",
      {
        title: "Do the next chunk now",
        description: `Do the next chunk of a campaign's work now and report what happened.

Safe to call repeatedly. It fills in whatever is left of the current day's budget and does nothing once that is spent, so it cannot be used to run through the schedule early: the day counter moves when the UTC date changes, not per call. Calling this ten times gets one day's work, not ten.

One call does what fits in about four minutes — finish any enrichment left pending, search, queue, start one enrichment run and wait for it. If a run has not landed in time it is left pending and the next call collects it.

Spends money. Read tick.note: that is where a refused enrichment, a rate limit or an exhausted query plan is reported in words.`,
        inputSchema: z.object({ id: z.string().max(60) }),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ id }, ctx) => {
        identity(ctx);
        await migrateIfNeeded();
        const before = await readCampaign(id);
        if (!before) return failed(`No campaign with id ${id}. Try list_campaigns.`);

        const res = await tickCampaign(id);
        const c = res.campaign;
        const report = await buildReport(c, 10);
        const t = res.tick;

        const summary = t
          ? `Day ${t.day}: ${t.queries} ${t.queries === 1 ? "query" : "queries"}, ${t.hits} hits, ${t.queued} queued, ${t.enriched} enriched, ${t.tagged} tagged, $${t.usd.toFixed(3)} spent.${t.note ? ` ${t.note}` : ""}`
          : (res.note ?? "Nothing to do.");

        return reply(
          `${c.name}: ${summary}\n` +
            `Now ${c.status}, day ${c.day} of ${c.settings.days}, ${c.foundCount} found, $${c.spentUsd.toFixed(3)} of $${c.settings.budgetUsd.toFixed(2)}.` +
            (c.finishedReason ? ` Finished because it ${c.finishedReason}.` : "") +
            (report.length
              ? `\n\nBest so far:\n${report
                  .slice(0, 5)
                  .map((p) => `  ${p.score.toFixed(1)}  ${p.name}, ${p.headline}`)
                  .join("\n")}`
              : ""),
          { campaign: summarise(c), tick: t, note: res.note, report }
        );
      }
    );

    /* 7 ─────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "update_campaign",
      {
        title: "Change a campaign's settings",
        description: `Change any setting on a campaign you own, at any time, including while it is running. Raising a ceiling on day four is one call.

Anything omitted keeps its current value. A campaign that finished goes back to running when the limit it finished on no longer applies: raise budgetUsd on one that hit its ceiling, or days on one that ran out of days, and it carries on. A used-up query plan is the exception, since no setting refills it — widen the selection instead. A campaign somebody stopped by hand stays stopped.`,
        inputSchema: z
          .object({ id: z.string().max(60), settings: settingsSchema.optional(), ...SETTINGS_SHAPE })
          .strict(),
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args, ctx) => {
        const { id } = args;
        const owner = identity(ctx);
        await migrateIfNeeded();
        const patch = asSettings(args);
        if (!Object.keys(patch).length)
          return failed(
            "Nothing to change. Send at least one of days, searchesPerDay, queuePerDay, enrichPerDay, budgetUsd or scoreBar."
          );
        const res = await updateCampaign(id, owner, patch);
        if (!res.ok) return failed(res.error);
        const c = res.campaign;
        const plan = planQueries(c.selection, c.queries);
        return reply(
          `${c.name} is now ${c.settings.days} days, ${c.settings.searchesPerDay} searches and ${c.settings.queuePerDay} queued a day, ${c.settings.enrichPerDay} enriched a day, ceiling $${c.settings.budgetUsd.toFixed(2)}, score bar ${c.settings.scoreBar}. Status ${c.status}. ${plan.length} ${plan.length === 1 ? "query" : "queries"} planned, ${c.queryCursor} run.`,
          { campaign: summarise(c), settings: c.settings, plannedQueries: plan.length }
        );
      }
    );

    /* 8 ─────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "stop_campaign",
      {
        title: "Stop a campaign",
        description:
          "Stop a campaign you own. Nothing is deleted: everyone it found stays in the queue and its report stays readable. A stopped campaign cannot be restarted, so create a new one instead. Calling this on an already-stopped campaign changes nothing.",
        inputSchema: z.object({ id: z.string().max(60), reason: z.string().max(200).optional() }),
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ id, reason }, ctx) => {
        const owner = identity(ctx);
        await migrateIfNeeded();
        const res = await stopCampaign(id, owner, reason);
        if (!res.ok) return failed(res.error);
        return reply(
          `${res.campaign.name} is ${res.campaign.status}. ${res.campaign.foundCount} people it found stay in the queue.`,
          { campaign: summarise(res.campaign) }
        );
      }
    );

    /* 9 ─────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "delete_campaign",
      {
        title: "Forget a campaign",
        description:
          "Delete the record of a campaign you own that has already stopped. The people it queued stay in the roster — they were found on their merits and the campaign was only what pointed at them — so what goes is the settings, the tick history and the report. Stop a running campaign before deleting it. Deleting is the one thing here you cannot undo, so say what you are about to delete before you do it.",
        inputSchema: z.object({ id: z.string().max(60) }),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
      },
      async ({ id }, ctx) => {
        const owner = identity(ctx);
        await migrateIfNeeded();
        const res = await deleteCampaign(id, owner);
        if (!res.ok) return failed(res.error);
        return reply(`Deleted "${res.name}". The people it found are still in the queue.`, {
          deleted: res.name,
        });
      }
    );

    /* 10 ────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "run_search",
      {
        title: "Search now, queue nothing",
        description: `Run up to 25 Google queries against LinkedIn profiles right now and return what they found, without queueing anybody.

Use this to check a query before committing seven hundred of them. A query with three AND-ed terms very often returns nothing, and learning that for a third of a cent beats learning it on day four of a campaign.

Nothing is stored. inRoster and triaged say which hits the team already holds or has already decided about. Costs $${COST_PER_QUERY} a query.`,
        inputSchema: z.object({
          queries: z.array(z.string().min(3).max(300)).min(1).max(25),
          num: z.number().int().min(10).max(100).default(100),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ queries, num }, ctx) => {
        const owner = identity(ctx);
        await migrateIfNeeded();

        // The reservation the sweep route would have done for us.
        const gate = await reserveSearch(owner);
        if (!gate.ok) return failed(gate.error);

        const results = await runShards(
          queries.map((query, i) => ({ id: `q${i}`, query })),
          5,
          num
        );
        const [held, marks] = await Promise.all([
          rosterSlugs(),
          hydrate(await get<Partial<ProfileState>>(stateKey(owner))).marks,
        ]);

        const out = results.map((r, i) => ({
          query: queries[i],
          count: r.count,
          error: r.error,
          hits: r.hits.map((h) => ({
            slug: h.slug,
            name: h.name,
            headline: h.headline,
            snippet: h.snippet,
            inferredYear: h.inferredYear,
            inRoster: held.has(h.slug),
            triaged: isSuppressed(marks[h.slug]),
          })),
        }));

        const total = out.reduce((n, r) => n + r.count, 0);
        return reply(
          `${queries.length} ${queries.length === 1 ? "query" : "queries"}, ${total} hits, $${(queries.length * COST_PER_QUERY).toFixed(3)} spent.\n` +
            out
              .map((r) => `  ${r.count} — ${r.query}${r.error ? ` (failed: ${r.error})` : ""}`)
              .join("\n"),
          { resultsPerQuery: num, spentUsd: queries.length * COST_PER_QUERY, results: out }
        );
      }
    );

    /* 11 ────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "queue_people",
      {
        title: "Add people to the queue",
        description: `Put people into the shared queue on search data alone. Free, and anyone queued now is upgraded in place if they are enriched later.

Give explicit slugs — the LinkedIn /in/<handle>, never a display name — or neighborsOf, which queues the "People also viewed" neighbours of somebody already enriched. Those neighbours were already paid for as part of enriching them, so expanding a hop costs nothing until you enrich the neighbours themselves.

People the team deleted permanently are refused and counted, not silently dropped. Anyone already marked known or rejected is left exactly as they are.`,
        inputSchema: z.object({
          slugs: z.array(z.string().max(200)).max(100).optional(),
          neighborsOf: z.string().max(200).optional(),
        }),
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      },
      async ({ slugs, neighborsOf }, ctx) => {
        const owner = identity(ctx);
        await migrateIfNeeded();

        const roster = await readRoster();
        const marks = hydrate(await get<Partial<ProfileState>>(stateKey(owner))).marks;

        let hits: { slug: string; name: string; headline: string; url: string; snippet: string; matchedShards: string[] }[] = [];

        if (neighborsOf) {
          const seedSlug = toSlug(neighborsOf);
          const seed = seedSlug ? roster[seedSlug] : undefined;
          if (!seed) return failed(`${neighborsOf} is not in the roster, so its neighbours are unknown.`);
          if (!seed.enriched) {
            return failed(
              `${seed.name} has not been enriched, and the neighbour list only arrives with a profile. Enrich them first.`
            );
          }
          const known = new Set(Object.keys(roster));
          hits = neighborsFrom(seed, known).map((n) => ({
            slug: n.slug,
            name: n.name,
            headline: n.position,
            url: n.url,
            snippet: "",
            matchedShards: [],
          }));
          if (hits.length === 0) return failed(`No new neighbours for ${seed.name}.`);
        } else {
          const wanted = (slugs ?? []).map((s) => toSlug(s)).filter((s): s is string => Boolean(s));
          if (wanted.length === 0) return failed("Give either slugs or neighborsOf.");
          hits = wanted.map((slug) => ({
            slug,
            name: roster[slug]?.name ?? slug,
            headline: roster[slug]?.headline ?? "",
            url: roster[slug]?.url ?? `https://www.linkedin.com/in/${slug}`,
            snippet: "",
            matchedShards: [],
          }));
        }

        const res = await queueHits(owner, hits, {
          query: neighborsOf ? `neighbours of ${neighborsOf}` : "added by Claude",
          selection: EMPTY_SELECTION,
          marks,
        });
        if (res.slugs.length === 0) {
          return failed(
            res.blocked > 0
              ? `All ${res.blocked} were deleted permanently and cannot be re-added.`
              : "Nobody could be queued; they were all already triaged."
          );
        }

        const at = new Date().toISOString();
        const next = { ...marks };
        for (const slug of res.slugs) if (!next[slug]) next[slug] = { status: "queued", at };
        const key = stateKey(owner);
        const current = hydrate(await get<Partial<ProfileState>>(key));
        await set(key, mergeState(current, { marks: { ...current.marks, ...next } }));
        await addPeopleCapped(res.people, next);

        log.info("mcp.queued", { owner, count: res.slugs.length });
        return reply(
          `Queued ${res.slugs.length}, ${res.added} new to the roster.` +
            (res.blocked ? ` ${res.blocked} refused as permanently deleted.` : "") +
            (res.skipped ? ` ${res.skipped} left alone, already triaged.` : ""),
          { added: res.added, queued: res.slugs.length, blocked: res.blocked, skipped: res.skipped, slugs: res.slugs }
        );
      }
    );

    /* 12 ────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "enrich_people",
      {
        title: "Pay for full profiles",
        description: `Pay to pull full LinkedIn profiles for people in the queue. $${COST_PER_PROFILE} each, charged whether or not the profile comes back, capped at the daily profile limit across the whole app.

Enrich the highest-scoring search-only people first. Somebody already enriched is money spent twice for nothing, and a search-only person's score comes from two lines of snippet — enriching is how anyone gets a real score.

This starts a run and waits up to two minutes. If it has not landed you get status "running" and a jobId; call again with that jobId and no slugs to finish applying it. The profiles are already paid for at that point and are lost if nobody collects them.

Enriching also fetches each person's neighbours, which is what queue_people's neighborsOf reads.`,
        inputSchema: z.object({
          slugs: z.array(z.string().max(200)).max(MAX_PROFILES_PER_RUN).optional(),
          jobId: z.string().max(80).optional().describe("Finish applying a run from an earlier call."),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ slugs, jobId }, ctx) => {
        const owner = identity(ctx);
        await migrateIfNeeded();

        if (jobId) {
          const job = await readJob(owner, jobId);
          if (!job) return failed(`No run with id ${jobId}.`);
          const applied = await applyEnrichJob(job);
          if (applied.status === "done") {
            return reply(
              `Applied ${applied.people.length} profiles${applied.alreadyApplied ? " (already applied earlier)" : ""}.`,
              { status: "done", jobId, applied: applied.people.length, slugs: applied.newSlugs }
            );
          }
          if (applied.status === "error") return failed(`That run failed: ${applied.error}`);
          return reply(`Still running. Call again with jobId ${jobId}.`, { status: "running", jobId });
        }

        const wanted = [...new Set((slugs ?? []).map((s) => toSlug(s)).filter((s): s is string => Boolean(s)))];
        if (wanted.length === 0) return failed("Give slugs to enrich, or a jobId to finish applying.");

        const team = await readTeam();
        const erased = new Set(team.deleted);
        const targets = wanted.filter((s) => !erased.has(s));
        if (targets.length === 0) return failed("Those profiles were deleted permanently.");

        const gate = isMock() ? { ok: true as const } : await reserveProfiles(owner, targets.length);
        if (!gate.ok) return failed(gate.error);

        const started = await startProfileRun(targets);
        if (!started.ok) return failed(started.error);

        const job: EnrichJob = {
          id: newJobId(),
          profile: owner,
          kind: "seed",
          runId: started.run.runId,
          datasetId: started.run.datasetId,
          slugs: targets,
          provenance: Object.fromEntries(targets.map((s) => [s, { kind: "seed" as const }])),
          hop: 0,
          status: "running",
          startedAt: new Date().toISOString(),
        };
        await writeJob(job);

        // Wait, but not past the function's own budget.
        const deadline = Date.now() + 120_000;
        let applied = await applyEnrichJob(job);
        while (applied.status === "running" && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 4_000));
          applied = await applyEnrichJob((await readJob(owner, job.id)) ?? job);
        }

        if (applied.status === "done") {
          return reply(
            `Enriched ${applied.people.length} of ${targets.length}, $${(targets.length * (isMock() ? 0 : COST_PER_PROFILE)).toFixed(3)} spent.`,
            {
              status: "done",
              jobId: job.id,
              requested: targets.length,
              applied: applied.people.length,
              slugs: applied.newSlugs,
            }
          );
        }
        if (applied.status === "error") return failed(`The run failed: ${applied.error}`);
        return reply(
          `Started but not landed yet. The profiles are paid for — call enrich_people with jobId ${job.id} to collect them.`,
          { status: "running", jobId: job.id, requested: targets.length }
        );
      }
    );

    /* 13 ────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "get_settings",
      {
        title: "Limits, costs and defaults",
        description:
          "Every number the loop obeys: the team's default campaign settings, the allowed range of each, and the ceilings that come from the vendors and the app rather than from us. Read this when a campaign stops for a reason involving a limit, or before setting one.",
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async (_args, ctx) => {
        identity(ctx);
        const defaults = await readDefaults();
        const data = {
          defaults,
          limits: LIMITS,
          costs: { perQuery: COST_PER_QUERY, perProfile: COST_PER_PROFILE },
          ceilings: {
            apifyMaxPerRun: MAX_PROFILES_PER_RUN,
            queriesPerSearchCall: 25,
            mock: isMock(),
          },
        };
        return reply(
          `Defaults: ${defaults.days} days, ${defaults.searchesPerDay} searches and ${defaults.queuePerDay} queued a day, ${defaults.enrichPerDay} enriched a day, ceiling $${defaults.budgetUsd.toFixed(2)}, score bar ${defaults.scoreBar}. A search costs $${COST_PER_QUERY}, a profile $${COST_PER_PROFILE}.`,
          data
        );
      }
    );

    /* 14 ────────────────────────────────────────────────────────────────── */
    server.registerTool(
      "set_default_settings",
      {
        title: "Change the team defaults",
        description:
          "Change the numbers a new campaign starts from. Affects campaigns created afterwards, not ones already running — use update_campaign for those. The same values are editable on the Agent screen.",
        inputSchema: z
          .object({ settings: settingsSchema.optional(), ...SETTINGS_SHAPE })
          .strict(),
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
      },
      async (args, ctx) => {
        identity(ctx);
        const patch = asSettings(args);
        if (!Object.keys(patch).length)
          return failed(
            "Nothing to change. Send at least one of days, searchesPerDay, queuePerDay, enrichPerDay, budgetUsd or scoreBar."
          );
        const next = await writeDefaults(patch);
        return reply(
          `Defaults are now ${next.days} days, ${next.searchesPerDay} searches and ${next.queuePerDay} queued a day, ${next.enrichPerDay} enriched a day, ceiling $${next.budgetUsd.toFixed(2)}, score bar ${next.scoreBar}.`,
          { defaults: next }
        );
      }
    );
  },
  {
    serverInfo: { name: "zscore", version: "1.0.0" },
    instructions: `Z-Score finds exceptional young people and ranks them on a hand-tuned taxonomy.

The shape of the work: list_taxonomy to learn the vocabulary, run_search to sanity-check a query, create_campaign to set a multi-day search running, advance_campaign or the daily cron to move it along, get_campaign for the report.

What you may not do, by design: nothing here deletes a person, resets the roster, edits a taxonomy weight, or marks anyone known or rejected. Deciding whether somebody is worth talking to is the human's call.

Spend deliberately. Searching is a tenth of a cent and effectively free. Enriching is four tenths of a cent, is charged even when the profile does not come back, and is the only thing that can run up a bill.`,
  }
);

const authed = withMcpAuth(handler, verifyToken, {
  required: true,
  resourceMetadataPath: "/.well-known/oauth-protected-resource",
});

export { authed as GET, authed as POST, authed as DELETE };

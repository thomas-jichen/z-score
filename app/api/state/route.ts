import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { isEmailAddress } from "@/lib/email";
import { get, set, storeKind, storeIsEphemeral } from "@/lib/store";
import {
  MAX_RECENT_SLUGS,
  MAX_SAVED_SWEEPS,
  emptyFilters,
  hydrate,
  mergeState,
  stateKey,
  type ProfileState,
  type QueueFilters,
  type SavedSweep,
  isDigestCadence,
} from "@/lib/state";
import { migrateIfNeeded, readRoster, readTeam } from "@/lib/serverState";
import { isArchetype } from "@/lib/clusters";
import type { Selection } from "@/lib/query";
import { isBad, readJson, str, strList } from "@/lib/validate";

/**
 * One teammate's own document, plus the shared data the app needs on load.
 *
 * GET is the single read the app makes when it starts: personal state, the
 * roster and the team taxonomy in one round trip, so five screens do not each
 * fetch the same thing.
 *
 * PATCH takes personal fields only, and deliberately not `marks` — those go
 * through /api/people so queue membership has exactly one writer and a pin
 * costs a few bytes rather than a copy of every mark.
 */

export async function GET() {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  try {
    await migrateIfNeeded();
    const [stored, roster, team] = await Promise.all([
      get<Partial<ProfileState>>(stateKey(r.profile)),
      readRoster(),
      readTeam(),
    ]);

    return NextResponse.json({
      ok: true,
      profile: r.profile,
      state: hydrate(stored),
      roster,
      team,
      storage: storeKind(),
      ephemeral: storeIsEphemeral(),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Store read failed." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const body = await readJson<Partial<ProfileState>>(req);
  if (isBad(body)) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });

  const patch = cleanPatch(body);
  if (Object.keys(patch).length === 0) {
    return NextResponse.json({ ok: false, error: "Nothing to change." }, { status: 400 });
  }

  try {
    await migrateIfNeeded();
    const key = stateKey(r.profile);
    const next = mergeState(hydrate(await get<Partial<ProfileState>>(key)), patch);
    await set(key, next);
    return NextResponse.json({ ok: true, state: next, storage: storeKind() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Store write failed." },
      { status: 500 }
    );
  }
}

/* ── Validation ─────────────────────────────────────────────────────────── */

/**
 * Allowlist, not a passthrough. This route used to merge whatever JSON arrived
 * straight into stored state, so one malformed body could poison a document or
 * push it past what the store accepts.
 */
function cleanPatch(raw: Partial<ProfileState>): Partial<ProfileState> {
  const out: Partial<ProfileState> = {};

  if (Array.isArray(raw.sweeps)) out.sweeps = raw.sweeps.slice(0, MAX_SAVED_SWEEPS).map(cleanSweep);
  if (raw.lastSelection !== undefined) {
    out.lastSelection = raw.lastSelection === null ? null : cleanSelection(raw.lastSelection);
  }
  if (raw.queueFilters !== undefined) {
    out.queueFilters = raw.queueFilters === null ? null : cleanFilters(raw.queueFilters);
  }
  if (typeof raw.digestSeenAt === "string" || raw.digestSeenAt === null) {
    out.digestSeenAt = raw.digestSeenAt ? str(raw.digestSeenAt, 40) : null;
  }
  /**
   * The address is the only contact detail this app stores, so it is checked here
   * rather than trusted. `null` clears it; anything without an `@` is not an address
   * and is dropped rather than saved and silently never delivered to.
   */
  /**
   * The only contact detail this app stores, so it is checked rather than trusted.
   *
   * The first version asked only for something either side of an `@` with a dot, and
   * accepted `<script>@x.com`. Nothing renders a recipient address today, so that was
   * unreachable rather than safe, and unreachable is not a property worth relying on:
   * the moment anything shows who a digest went to it becomes stored XSS. A
   * conservative character set costs nothing and closes it, plus-addressing included.
   */
  if (typeof raw.email === "string" || raw.email === null) {
    const e = raw.email ? str(raw.email, 200).trim() : "";
    out.email = e && isEmailAddress(e) ? e : null;
  }
  if (isDigestCadence(raw.digest)) out.digest = raw.digest;
  if (typeof raw.campaignEmails === "boolean") out.campaignEmails = raw.campaignEmails;
  /**
   * Not client-writable. It is the record of what was actually sent, and a client
   * that could set it could either re-send the same digest all day or switch its own
   * off by dating it into the future.
   */
  if (raw.seeds !== undefined) out.seeds = strList(raw.seeds, 250, 300);
  if (typeof raw.activeJobId === "string" || raw.activeJobId === null) {
    out.activeJobId = raw.activeJobId ? str(raw.activeJobId, 80) : null;
  }
  if (raw.recentSlugs !== undefined) {
    out.recentSlugs = strList(raw.recentSlugs, MAX_RECENT_SLUGS, 200);
  }

  return out;
}

function cleanSelection(raw: unknown): Selection {
  const o = (raw ?? {}) as Record<string, unknown>;
  return {
    programs: strList(o.programs, 60, 80),
    titles: strList(o.titles, 60, 80),
    colleges: strList(o.colleges, 60, 80),
    highSchools: strList(o.highSchools, 60, 80),
    years: strList(o.years, 20, 8),
    states: strList(o.states, 60, 40),
    homeStates: strList(o.homeStates, 60, 40),
  };
}

/** A stored sweep keeps its hits so "Load" can replay it, so hits are capped too. */
function cleanSweep(raw: unknown): SavedSweep {
  const o = (raw ?? {}) as Record<string, unknown>;
  const hits = Array.isArray(o.hits) ? o.hits.slice(0, 100) : [];
  return {
    id: str(o.id, 40) || String(Date.now()),
    query: str(o.query, 500),
    selection: cleanSelection(o.selection),
    hits: hits.map((h) => {
      const x = (h ?? {}) as Record<string, unknown>;
      return {
        slug: str(x.slug, 200),
        name: str(x.name, 200),
        headline: str(x.headline, 500),
        url: str(x.url, 500),
        snippet: str(x.snippet, 1000),
        matchedShards: [],
        inferredYear: str(x.inferredYear, 8) || undefined,
      };
    }),
    ranAt: str(o.ranAt, 40) || new Date().toISOString(),
    mode: o.mode === "seed" ? "seed" : "serp",
    enrichedSlugs: strList(o.enrichedSlugs, 250, 200),
  };
}

function cleanFilters(raw: unknown): QueueFilters {
  const o = (raw ?? {}) as Record<string, unknown>;
  const base = emptyFilters();
  return {
    cluster: isArchetype(o.cluster) ? o.cluster : "all",
    band: str(o.band, 20) || base.band,
    years: strList(o.years, 20, 8),
    pinnedOnly: o.pinnedOnly === true,
    // `enrichedOnly` is the boolean this replaced. Read so that anyone who had the
    // filter on when it shipped keeps it on rather than silently seeing everyone.
    enrichment:
      o.enrichment === "enriched" || o.enrichment === "thin"
        ? o.enrichment
        : o.enrichedOnly === true
          ? "enriched"
          : "all",
    polymathOnly: o.polymathOnly === true,
  };
}

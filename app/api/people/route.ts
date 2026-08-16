import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { isArchetype } from "@/lib/clusters";
import type { Hit } from "@/lib/types";
import type { Selection } from "@/lib/query";
import {
  MAX_PEOPLE,
  capRoster,
  personFromHit,
  personFromSlug,
  type Marks,
  type Person,
  type PersonStatus,
} from "@/lib/people";
import {
  MAX_DELETED,
  ROSTER_KEY,
  TEAM_KEY,
  hydrate,
  mergeState,
  rawKey,
  stateKey,
  type ProfileState,
  type TeamState,
} from "@/lib/state";
import { migrateIfNeeded, readRoster, readTeam, writePeople } from "@/lib/serverState";
import { buildSearchLabels } from "@/lib/tags";
import { del, get, hdel, set } from "@/lib/store";
import { extractSlug } from "@/lib/search";
import { toSlug } from "@/lib/enrichment";
import type { ProfileId } from "@/lib/profiles";
import { bounded, isBad, readJson, str, strList } from "@/lib/validate";
import { log } from "@/lib/log";

/**
 * Operations on the roster.
 *
 * Op-based rather than "here is the new state", for two reasons. Pinning one
 * person should cost a few bytes, not a copy of the whole roster — which is what
 * the old single-document PATCH forced, and it got worse with every profile
 * enriched. And the server owns the merge, so two teammates acting at the same
 * time cannot overwrite each other.
 *
 * Roster writes go to the shared hash. Mark writes go to the caller's own
 * document, and nothing here lets one teammate change another's marks.
 */

export const maxDuration = 60;

const STATUSES: readonly PersonStatus[] = ["queued", "known", "rejected"];

/** One add call is at most one sweep's results. */
const MAX_ADD = 250;
/** A bulk action from the queue. Generous, but not unbounded. */
const MAX_MARK = 2000;

type Body =
  | { op: "addHits"; hits?: unknown; query?: unknown; selection?: unknown }
  | {
      op: "addSlugs";
      slugs?: unknown;
      /** Neighbours, which arrive already knowing their own name and position. */
      people?: unknown;
      seedSlug?: unknown;
      seedName?: unknown;
      hop?: unknown;
    }
  | { op: "mark"; slugs?: unknown; status?: unknown; pinned?: unknown; note?: unknown }
  | { op: "setCluster"; slug?: unknown; cluster?: unknown }
  | { op: "terms"; slug?: unknown; add?: unknown; remove?: unknown }
  | { op: "delete"; slugs?: unknown }
  | { op: "reset" };

export async function GET() {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  try {
    await migrateIfNeeded();
    const [roster, team, stored] = await Promise.all([
      readRoster(),
      readTeam(),
      get<Partial<ProfileState>>(stateKey(r.profile)),
    ]);
    return NextResponse.json({ ok: true, roster, team, marks: hydrate(stored).marks });
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

  const op = String((body as { op?: string }).op ?? "");

  try {
    await migrateIfNeeded();

    switch (body.op) {
      case "addHits":
        return await addHits(r.profile, body);
      case "addSlugs":
        return await addSlugs(r.profile, body);
      case "mark":
        return await mark(r.profile, body);
      case "setCluster":
        return await setCluster(body);
      case "terms":
        return await editTerms(body);
      case "delete":
        return await remove(r.profile, body);
      case "reset":
        return await resetEverything(r.profile);
      default:
        return NextResponse.json({ ok: false, error: "Unknown operation." }, { status: 400 });
    }
  } catch (e) {
    log.error("people.failed", { op, error: e instanceof Error ? e.message : "unknown" });
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Store write failed." },
      { status: 500 }
    );
  }
}

/* ── Marks live in the caller's own document ─────────────────────────────── */

async function patchMarks(profile: ProfileId, fn: (marks: Marks) => Marks): Promise<Marks> {
  const key = stateKey(profile);
  const current = hydrate(await get<Partial<ProfileState>>(key));
  const next = mergeState(current, { marks: fn({ ...current.marks }) });
  await set(key, next);
  return next.marks;
}

const queued = (marks: Marks, slugs: string[]): Marks => {
  const at = new Date().toISOString();
  for (const slug of slugs) {
    // Re-adding someone previously rejected puts them back, which is what
    // clicking add again plainly means.
    marks[slug] = { ...(marks[slug] ?? { at }), status: "queued", at };
  }
  return marks;
};

/**
 * Write new people, then evict if the roster has outgrown its cap.
 *
 * Capping on write rather than on read means the store never accumulates past
 * the bound. Without it a write eventually exceeds what the backend accepts,
 * which fails every save at once instead of degrading.
 */
async function addPeople(fresh: Person[], marks: Marks): Promise<void> {
  await writePeople(fresh);
  if (fresh.length === 0) return;

  const roster = await readRoster();
  if (Object.keys(roster).length <= MAX_PEOPLE) return;

  const kept = capRoster(roster, marks);
  const evicted = Object.keys(roster).filter((slug) => !(slug in kept));
  if (evicted.length > 0) {
    await hdel(ROSTER_KEY, evicted);
    log.warn("people.evicted", { count: evicted.length, cap: MAX_PEOPLE });
  }
}

/* ── Add ────────────────────────────────────────────────────────────────── */

/**
 * Queue search results on SERP data alone. Nothing is spent, and anyone added
 * this way is upgraded in place if they are enriched later.
 */
async function addHits(profile: ProfileId, body: Extract<Body, { op: "addHits" }>) {
  const raw = Array.isArray(body.hits) ? body.hits.slice(0, MAX_ADD) : [];
  const query = str(body.query, 500);
  const selection = normaliseSelection(body.selection);

  const [roster, team] = await Promise.all([readRoster(), readTeam()]);
  const erased = new Set(team.deleted);
  const fresh: Person[] = [];
  const slugs: string[] = [];
  let blocked = 0;

  for (const item of raw) {
    const h = (item ?? {}) as Partial<Hit>;
    const slug = toSlug(str(h.slug, 200)) ?? extractSlug(str(h.url, 500));
    if (!slug || slugs.includes(slug)) continue;
    // Deleted for good. A sweep will keep finding them — the search engine does not
    // know — so the refusal has to live here, at the door to the roster.
    if (erased.has(slug)) {
      blocked++;
      continue;
    }
    slugs.push(slug);

    // Already in the roster? Keep the richer record; only marks change below.
    if (roster[slug]) continue;

    const hit: Hit = {
      slug,
      name: str(h.name, 200),
      headline: str(h.headline, 500),
      url: str(h.url, 500),
      snippet: str(h.snippet, 1000),
      matchedShards: [],
      inferredYear: str(h.inferredYear, 8) || undefined,
    };

    // Chips are cross-checked against this hit's own text, so an OR group never
    // silently asserts a credential the snippet does not actually show.
    const labels = buildSearchLabels(`${hit.name} ${hit.headline} ${hit.snippet}`, selection);
    fresh.push(personFromHit(hit, { query, labels }));
  }

  if (slugs.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error: blocked > 0 ? blockedMessage(blocked) : "No valid people in that list.",
      },
      { status: 400 }
    );
  }

  const marks = await patchMarks(profile, (m) => queued(m, slugs));
  await addPeople(fresh, marks);

  log.info("people.added", { source: "serp", added: fresh.length, queued: slugs.length, blocked });
  return NextResponse.json({ ok: true, added: fresh.length, queued: slugs.length, blocked, marks });
}

/**
 * Said plainly, because the alternative is a silent shortfall.
 *
 * Ticking eight people and being told eight were added when one was refused is the
 * kind of quiet lie that makes someone stop trusting the count.
 */
function blockedMessage(n: number): string {
  return `${n} ${n === 1 ? "person was" : "people were"} deleted permanently and cannot be re-added. Restore them under Stored data on the taxonomy screen.`;
}

/**
 * Seeds and neighbours.
 *
 * A seed is known only by slug until enrichment fills it in. A neighbour is not:
 * People Also Viewed hands back a name and a position for free, so `people[]`
 * carries those through and the roster records a real person rather than a bare
 * username that every teammate then sees.
 *
 * `slugs[]` remains the seed path and any caller with nothing but slugs.
 */
type IncomingPerson = {
  slug: string;
  name: string;
  headline: string;
  seedSlug: string;
  seedName: string;
};

function cleanIncoming(raw: unknown, fallback: { seedSlug: string; seedName: string }): IncomingPerson[] {
  if (!Array.isArray(raw)) return [];
  const out: IncomingPerson[] = [];
  const seen = new Set<string>();

  for (const item of raw.slice(0, MAX_ADD)) {
    const o = (item ?? {}) as Record<string, unknown>;
    const slug = toSlug(str(o.slug, 200));
    if (!slug || seen.has(slug)) continue;
    seen.add(slug);
    out.push({
      slug,
      name: str(o.name, 200).trim(),
      // The vendor calls it `position`; ours is `headline`. Accept either.
      headline: (str(o.headline, 300) || str(o.position, 300)).trim(),
      seedSlug: toSlug(str(o.seedSlug, 200)) ?? fallback.seedSlug,
      seedName: str(o.seedName, 200).trim() || fallback.seedName,
    });
  }
  return out;
}

async function addSlugs(profile: ProfileId, body: Extract<Body, { op: "addSlugs" }>) {
  const fallbackSeedSlug = toSlug(str(body.seedSlug, 200)) ?? "";
  const fallbackSeedName = str(body.seedName, 200).trim();

  // Each hop is one depth, so it is a property of the batch. This used to be
  // hardcoded to 1, which recorded a hop-2 neighbour as a hop-1 one.
  const hop = bounded(body.hop, 1, 5) ?? 1;

  const incoming = cleanIncoming(body.people, {
    seedSlug: fallbackSeedSlug,
    seedName: fallbackSeedName,
  });

  const bare = [
    ...new Set(
      strList(body.slugs, MAX_ADD, 200)
        .map((s) => toSlug(s))
        .filter((s): s is string => Boolean(s))
    ),
  ]
    .filter((slug) => !incoming.some((p) => p.slug === slug))
    .map((slug) => ({
      slug,
      name: "",
      headline: "",
      seedSlug: fallbackSeedSlug,
      seedName: fallbackSeedName,
    }));

  const everything = [...incoming, ...bare].slice(0, MAX_ADD);
  if (everything.length === 0) {
    return NextResponse.json({ ok: false, error: "No valid profiles." }, { status: 400 });
  }

  // A neighbour of someone still in the roster is the likeliest way a deleted person
  // walks back in: People Also Viewed keeps offering them.
  const { allowed, blocked } = await partitionBlocked(everything.map((p) => p.slug));
  const all = everything.filter((p) => allowed.includes(p.slug));
  if (all.length === 0) {
    return NextResponse.json({ ok: false, error: blockedMessage(blocked.length) }, { status: 400 });
  }
  const list = all.map((p) => p.slug);

  const roster = await readRoster();
  const fresh = all
    .filter((p) => !roster[p.slug])
    .map((p) =>
      personFromSlug(
        p.slug,
        p.seedSlug
          ? { kind: "pav", seedSlug: p.seedSlug, seedName: p.seedName || p.seedSlug, hop }
          : { kind: "seed" },
        { name: p.name, headline: p.headline }
      )
    );

  const marks = await patchMarks(profile, (m) => queued(m, list));
  await addPeople(fresh, marks);

  log.info("people.added", {
    source: "slug",
    added: fresh.length,
    queued: list.length,
    blocked: blocked.length,
    hop,
  });
  return NextResponse.json({
    ok: true,
    added: fresh.length,
    queued: list.length,
    blocked: blocked.length,
    marks,
  });
}

/* ── Mark ───────────────────────────────────────────────────────────────── */

async function mark(profile: ProfileId, body: Extract<Body, { op: "mark" }>) {
  const list = strList(body.slugs, MAX_MARK, 200)
    .map((s) => toSlug(s))
    .filter((s): s is string => Boolean(s));
  if (list.length === 0) {
    return NextResponse.json({ ok: false, error: "No profiles given." }, { status: 400 });
  }

  const status = STATUSES.includes(body.status as PersonStatus)
    ? (body.status as PersonStatus)
    : undefined;
  const pinned = typeof body.pinned === "boolean" ? body.pinned : undefined;
  const note = typeof body.note === "string" ? str(body.note, 2000) : undefined;

  if (status === undefined && pinned === undefined && note === undefined) {
    return NextResponse.json({ ok: false, error: "Nothing to change." }, { status: 400 });
  }

  const marks = await patchMarks(profile, (m) => {
    const at = new Date().toISOString();
    for (const slug of list) {
      const prev = m[slug] ?? { status: "queued" as PersonStatus, at };
      m[slug] = {
        ...prev,
        ...(status !== undefined ? { status } : {}),
        ...(pinned !== undefined ? { pinned } : {}),
        ...(note !== undefined ? { note: note || undefined } : {}),
        at,
      };
    }
    return m;
  });

  return NextResponse.json({ ok: true, marks });
}

/* ── Roster edits, shared across the team ───────────────────────────────── */

async function setCluster(body: Extract<Body, { op: "setCluster" }>) {
  const slug = toSlug(str(body.slug, 200));
  if (!slug) return NextResponse.json({ ok: false, error: "No profile." }, { status: 400 });

  const roster = await readRoster();
  const person = roster[slug];
  if (!person) return NextResponse.json({ ok: false, error: "Not in the roster." }, { status: 404 });

  // null clears the override and returns the person to the computed label.
  const cluster = isArchetype(body.cluster) ? body.cluster : null;
  const next: Person = { ...person, clusterOverride: cluster, updatedAt: new Date().toISOString() };
  await writePeople([next]);

  return NextResponse.json({ ok: true, person: next });
}

async function editTerms(body: Extract<Body, { op: "terms" }>) {
  const slug = toSlug(str(body.slug, 200));
  if (!slug) return NextResponse.json({ ok: false, error: "No profile." }, { status: 400 });

  const roster = await readRoster();
  const person = roster[slug];
  if (!person) return NextResponse.json({ ok: false, error: "Not in the roster." }, { status: 404 });

  const add = strList(body.add, 20, 60);
  const drop = new Set(strList(body.remove, 20, 60).map((t) => t.toLowerCase()));

  const manual = [...(person.manualTerms ?? []), ...add].filter(
    (t, i, all) =>
      !drop.has(t.toLowerCase()) && all.findIndex((x) => x.toLowerCase() === t.toLowerCase()) === i
  );
  // Removing a term the model proposed has to stick, or it reappears on the next
  // tagger run and the removal reads as broken.
  const extracted = (person.extractedTerms ?? []).filter((t) => !drop.has(t.toLowerCase()));

  /**
   * Removal has to work on tags read from structured fields too, and those are not in
   * either list above — so dropping one did nothing at all. Recorded per person, and
   * cleared by adding the same label back.
   */
  const added = new Set(add.map((t) => t.toLowerCase()));
  const suppressed = [
    ...new Set([
      ...(person.suppressedTags ?? []).filter((t) => !added.has(t.toLowerCase())),
      ...strList(body.remove, 20, 60),
    ]),
  ];

  const next: Person = {
    ...person,
    manualTerms: manual.length ? manual : undefined,
    extractedTerms: extracted.length ? extracted : undefined,
    suppressedTags: suppressed.length ? suppressed : undefined,
    updatedAt: new Date().toISOString(),
  };
  await writePeople([next]);

  return NextResponse.json({ ok: true, person: next });
}

/**
 * Hard delete from the shared roster, as opposed to rejecting, which is
 * personal and reversible. This is the control that answers "erase this
 * person's data".
 *
 * Three things go, and the fourth is what makes it stick:
 *
 *   the roster row      shared, so they leave everyone's queue at once
 *   the raw payload     the vendor's own copy of a real person, at its own key
 *   the caller's mark   nothing left to triage
 *   the slug is blocked so the next sweep does not read them as a new face
 *
 * The block is the whole difference between this and rejecting. Rejection works by
 * *remembering* the person; deleting removes the thing that was doing the
 * remembering, so without a list of its own, "delete permanently" would mean "delete
 * until the next sweep runs".
 */
async function remove(profile: ProfileId, body: Extract<Body, { op: "delete" }>) {
  const list = strList(body.slugs, MAX_MARK, 200)
    .map((s) => toSlug(s))
    .filter((s): s is string => Boolean(s));
  if (list.length === 0) {
    return NextResponse.json({ ok: false, error: "No profiles given." }, { status: 400 });
  }

  await hdel(ROSTER_KEY, list);

  // The archive is a copy of a real person's profile, so it goes with them. Best
  // effort: a store hiccup here must not leave the roster row deleted and the
  // request reported as failed, which would read as "nothing happened".
  await Promise.all(
    list.map((slug) =>
      del(rawKey(slug)).catch((e) =>
        log.warn("people.raw.deleteFailed", {
          slug,
          error: e instanceof Error ? e.message : "unknown",
        })
      )
    )
  );

  const team = await block(list);
  const marks = await patchMarks(profile, (m) => {
    for (const slug of list) delete m[slug];
    return m;
  });

  log.info("people.deleted", { count: list.length, blocked: team.deleted.length });
  return NextResponse.json({ ok: true, deleted: list.length, marks, team });
}

/**
 * Add slugs to the shared blocklist.
 *
 * Read-modify-write against the live document rather than one loaded earlier in the
 * request: this is the same key the taxonomy screen writes, and a delete taking
 * several seconds must not hand back a taxonomy from before whatever a teammate
 * changed in the meantime.
 */
async function block(slugs: string[]): Promise<TeamState> {
  const current = await readTeam();
  const next: TeamState = {
    ...current,
    deleted: [...new Set([...current.deleted, ...slugs])].slice(-MAX_DELETED),
    updatedAt: new Date().toISOString(),
  };
  await set(TEAM_KEY, next);
  return next;
}

/**
 * Split an incoming batch into what may be added and what was erased for good.
 *
 * Enforced on the server because the roster is shared: a client with a stale team
 * document, or a sweep whose results were fetched before the deletion, would
 * otherwise walk someone straight back in.
 */
async function partitionBlocked(slugs: string[]): Promise<{ allowed: string[]; blocked: string[] }> {
  const team = await readTeam();
  if (team.deleted.length === 0) return { allowed: slugs, blocked: [] };
  const gone = new Set(team.deleted);
  return {
    allowed: slugs.filter((s) => !gone.has(s)),
    blocked: slugs.filter((s) => gone.has(s)),
  };
}

/**
 * Delete every person the team holds.
 *
 * The population is minors, so a one-click way to erase the corpus is a
 * requirement rather than a nicety. Taxonomy weights survive, because those are
 * the team's tuning rather than anybody's personal data.
 */
async function resetEverything(profile: ProfileId) {
  const roster = await readRoster();
  const slugs = Object.keys(roster);
  if (slugs.length > 0) await hdel(ROSTER_KEY, slugs);

  // The archived vendor payloads are the same data at a different key, so an erase
  // that left them behind would not be one.
  await Promise.all(
    slugs.map((slug) =>
      del(rawKey(slug)).catch((e) =>
        log.warn("people.raw.deleteFailed", {
          slug,
          error: e instanceof Error ? e.message : "unknown",
        })
      )
    )
  );

  // Nobody is blocked. "Erase what we hold" is not "never look at these people
  // again" — that is a judgement about a person, and it is made one at a time.
  const marks = await patchMarks(profile, () => ({}));

  log.warn("people.reset", { deleted: slugs.length });
  return NextResponse.json({ ok: true, deleted: slugs.length, marks });
}

/* ── Helpers ────────────────────────────────────────────────────────────── */

function normaliseSelection(raw: unknown): Selection {
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

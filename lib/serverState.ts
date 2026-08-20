import { isArchetype, type Archetype } from "./clusters";
import type { Marks, Person, Roster } from "./people";
import {
  MAX_PEOPLE,
  capRoster,
  isSuppressed,
  migrateLegacy,
  personFromHit,
  refreshDerived,
} from "./people";
import { buildSearchLabels } from "./tags";
import type { Selection } from "./query";
import type { Hit } from "./types";
import type { ProfileId } from "./profiles";
import type { EnrichedProfile } from "./enrichment";
import { get, hdel, hgetall, hkeys, hset, keys, set } from "./store";
import {
  ROSTER_KEY,
  SCHEMA_KEY,
  SCHEMA_VERSION,
  TEAM_KEY,
  emptyTeam,
  hydrate,
  hydrateTeam,
  mergeTeam,
  type CustomTerms,
  type ProfileState,
  type TaxonomyPrefs,
  type TeamState,
} from "./state";

/**
 * Everything in the state layer that touches the store.
 *
 * Split out from lib/state.ts because that file is imported by client
 * components for its types and pure helpers, and lib/store.ts reaches for
 * node:fs. Bundling the two together dragged the filesystem backend into the
 * browser bundle, which fails the build outright — better than shipping it.
 *
 * Nothing here may be imported from a client component.
 */


export async function readRoster(): Promise<Roster> {
  const roster = await hgetall<Person>(ROSTER_KEY);
  // Derived fields are recomputed here so a correction to how they are derived
  // reaches records already stored, without paying Apify to enrich anyone twice.
  for (const [slug, person] of Object.entries(roster)) {
    roster[slug] = refreshDerived(person);
  }
  return roster;
}

export async function writePeople(people: Person[]): Promise<void> {
  if (people.length === 0) return;
  await hset(
    ROSTER_KEY,
    Object.fromEntries(people.map((p) => [p.slug, p]))
  );
}

/** Every slug the roster holds, without unpacking two thousand profiles to find out. */
export async function rosterSlugs(): Promise<Set<string>> {
  return new Set(await hkeys(ROSTER_KEY));
}

/**
 * Write new people, then evict if the roster has outgrown its cap.
 *
 * Lifted out of the people route, where it was the only place eviction happened
 * — so the enrichment path, which writes with a bare `writePeople`, could push
 * the roster past its cap indefinitely. That is exactly what `capRoster` exists
 * to prevent, and the campaign loop would have made it routine rather than
 * theoretical.
 *
 * Capping on write rather than on read means the store never accumulates past
 * the bound. Without it a write eventually exceeds what the backend accepts,
 * which fails every save at once instead of degrading.
 */
export async function addPeopleCapped(fresh: Person[], marks: Marks = {}): Promise<string[]> {
  await writePeople(fresh);
  if (fresh.length === 0) return [];

  const roster = await readRoster();
  if (Object.keys(roster).length <= MAX_PEOPLE) return [];

  const kept = capRoster(roster, marks);
  const evicted = Object.keys(roster).filter((slug) => !(slug in kept));
  if (evicted.length > 0) await hdel(ROSTER_KEY, evicted);
  return evicted;
}

export type QueueHitsResult = {
  /** Roster rows created. Someone already held is queued without being rewritten. */
  added: number;
  /** Slugs now in the caller's queue. */
  slugs: string[];
  /** Refused because the team deleted them for good. */
  blocked: number;
  /** Skipped because the caller had already triaged them, and `reviveRejected` was off. */
  skipped: number;
  people: Person[];
};

/**
 * Turn search hits into queued people.
 *
 * Extracted from the people route so the campaign loop cannot drift from it. The
 * route was the only place that respected the deletion blocklist, capped the
 * roster, and cross-checked search chips against a hit's own text — and an
 * unattended loop that skipped any one of those would do damage nightly rather
 * than once.
 *
 * `reviveRejected` is the one behaviour that must differ between the two callers.
 * The route sets it: a human clicking add again on someone they rejected plainly
 * means to put them back. A campaign must never do that, or it silently undoes
 * human triage every morning for a week.
 */
export async function queueHits(
  profile: ProfileId,
  hits: Hit[],
  opts: {
    query: string;
    selection: Selection;
    reviveRejected?: boolean;
    marks?: Marks;
    max?: number;
  }
): Promise<QueueHitsResult> {
  const [roster, team] = await Promise.all([readRoster(), readTeam()]);
  const erased = new Set(team.deleted);
  const marks = opts.marks ?? {};
  const limit = opts.max ?? hits.length;

  const fresh: Person[] = [];
  const slugs: string[] = [];
  let blocked = 0;
  let skipped = 0;

  for (const hit of hits) {
    if (slugs.length >= limit) break;
    const slug = hit.slug;
    if (!slug || slugs.includes(slug)) continue;
    // Deleted for good. A sweep will keep finding them — the search engine does
    // not know — so the refusal has to live here, at the door to the roster.
    if (erased.has(slug)) {
      blocked++;
      continue;
    }
    if (!opts.reviveRejected && isSuppressed(marks[slug])) {
      skipped++;
      continue;
    }
    slugs.push(slug);

    // Already in the roster? Keep the richer record; only marks change.
    if (roster[slug]) continue;

    // Chips are cross-checked against this hit's own text, so an OR group never
    // silently asserts a credential the snippet does not actually show.
    const labels = buildSearchLabels(
      `${hit.name} ${hit.headline} ${hit.snippet}`,
      opts.selection
    );
    fresh.push(personFromHit(hit, { query: opts.query, labels }));
  }

  return { added: fresh.length, slugs, blocked, skipped, people: fresh };
}

export async function readTeam(): Promise<TeamState> {
  return hydrateTeam(await get<Partial<TeamState>>(TEAM_KEY));
}

/* ── Migration ──────────────────────────────────────────────────────────── */

/**
 * Legacy documents held everything in one blob per teammate, including up to
 * 500 enriched profiles under `candidates`. This lifts those into the shared
 * roster and converts each teammate's `ratings` into their own marks.
 *
 * Guarded two ways: a stored schema version so it runs once across processes,
 * and an in-process promise so concurrent requests during a cold start cannot
 * both run it.
 */
let migrating: Promise<void> | null = null;

export function migrateIfNeeded(): Promise<void> {
  if (!migrating) migrating = runMigration().catch((e) => {
    // Reset so a transient store failure can be retried on the next request
    // rather than latching the app into an unmigrated state forever.
    migrating = null;
    throw e;
  });
  return migrating;
}

type LegacyDoc = Partial<ProfileState> & {
  candidates?: Record<string, EnrichedProfile>;
  ratings?: Record<string, "interested" | "not_interested" | "already_know">;
  /**
   * `archetypes` was the old field name for `clusters`. Its values are typed as
   * plain strings because the old union included "polymath", which is no longer a
   * cluster — the migration below drops those rather than writing an invalid id.
   */
  taxonomy?: Partial<TaxonomyPrefs> & { archetypes?: Record<string, string> };
  customTerms?: CustomTerms;
};

async function runMigration(): Promise<void> {
  const version = await get<number>(SCHEMA_KEY);
  if (version === SCHEMA_VERSION) return;

  const profileKeys = await keys("zscore:profile:");
  let roster: Roster = {};
  let team = emptyTeam();

  for (const key of profileKeys) {
    const doc = await get<LegacyDoc>(key);
    if (!doc) continue;

    const hasLegacy = doc.candidates || doc.ratings;
    if (hasLegacy) {
      const { roster: r, marks } = migrateLegacy(doc);
      roster = { ...roster, ...r };
      // Keep this teammate's own marks, merged over anything already present.
      const next = hydrate({ ...doc, marks: { ...(doc.marks ?? {}), ...marks } });
      delete (next as Partial<LegacyDoc>).candidates;
      delete (next as Partial<LegacyDoc>).ratings;
      delete (next as Partial<LegacyDoc>).taxonomy;
      delete (next as Partial<LegacyDoc>).customTerms;
      await set(key, next);
    }

    // The taxonomy was per-teammate and becomes team-wide. First writer wins on
    // a conflicting weight, which is fine: these were near-identical defaults.
    if (doc.taxonomy) {
      const legacy = doc.taxonomy;
      team = mergeTeam(team, {
        taxonomy: {
          ...team.taxonomy,
          weights: { ...legacy.weights, ...team.taxonomy.weights },
          // Old ids are still valid apart from "polymath", which became a badge.
          // Anything unrecognised is dropped rather than written back.
          clusters: {
            ...Object.fromEntries(
              Object.entries(legacy.archetypes ?? {})
                .filter(([, v]) => isArchetype(v))
                .map(([k, v]) => [k, v as Archetype])
            ),
            ...(legacy.clusters ?? {}),
            ...team.taxonomy.clusters,
          },
          promoted: [...new Set([...(legacy.promoted ?? []), ...team.taxonomy.promoted])],
          dismissed: [...new Set([...(legacy.dismissed ?? []), ...team.taxonomy.dismissed])],
        },
      });
    }
    if (doc.customTerms) {
      const c = doc.customTerms;
      team = mergeTeam(team, {
        customTerms: {
          programs: [...new Set([...c.programs, ...team.customTerms.programs])],
          titles: [...new Set([...c.titles, ...team.customTerms.titles])],
          colleges: [...new Set([...c.colleges, ...team.customTerms.colleges])],
          highSchools: [...new Set([...c.highSchools, ...team.customTerms.highSchools])],
          years: [...new Set([...c.years, ...team.customTerms.years])],
          // Geography arrived later than this migration, so a legacy document has
          // no such lists to merge.
          states: [...team.customTerms.states],
          homeStates: [...team.customTerms.homeStates],
        },
      });
    }
  }

  const existing = await readRoster();
  const merged = capRoster({ ...roster, ...existing });
  await writePeople(Object.values(merged));

  const existingTeam = await get<Partial<TeamState>>(TEAM_KEY);
  await set(TEAM_KEY, existingTeam ? mergeTeam(team, existingTeam) : team);
  await set(SCHEMA_KEY, SCHEMA_VERSION);
}

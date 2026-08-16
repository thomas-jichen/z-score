import { START_WEIGHT, TERM_CLUSTER, type Archetype, type BandThresholds } from "./clusters";
import { US_STATES, type CountKind } from "./extract";
import {
  ACCELERATORS,
  CLUBS,
  FLAGS,
  LOW_SIGNAL,
  PURGED,
  RETIRED,
  COLLEGES,
  COMPANIES,
  LABS,
  HIGH_SCHOOLS,
  MAJORS,
  PROGRAMS,
  STARTUPS,
  TITLES,
} from "./searchTaxonomy";
import {
  normalizeKey as seedKey,
  seedRegistry,
  type TagFacet,
  type TagRegistry,
} from "./tagRegistry";
import type { Hit } from "./types";
import type { Selection } from "./query";
import type { ProfileId } from "./profiles";
import type { Marks } from "./people";

/**
 * Two scopes, because the team shares findings but not judgement.
 *
 *   team      the roster and the taxonomy. Shared, so nobody pays Apify twice
 *             for the same person and everyone sees one score for them
 *   personal  pin, already-known, rejected, filters, sweep history. Private,
 *             so Grace triaging her list does not reshape Cory's
 *
 * A split scoring model would mean three different z-scores for one person,
 * which defeats the point of a shared ranked list, so the taxonomy is team-wide.
 */

export type SweepMode = "serp" | "seed";

export type SavedSweep = {
  id: string;
  query: string;
  selection: Selection;
  hits: Hit[];
  ranAt: string;
  mode?: SweepMode;
  /** Who was actually enriched out of this run, so cost stays auditable. */
  enrichedSlugs?: string[];
};

/** Extra menu options someone added themselves, merged into the built-in lists. */
export type CustomTerms = {
  programs: string[];
  titles: string[];
  colleges: string[];
  highSchools: string[];
  years: string[];
  states: string[];
  homeStates: string[];
};

/**
 * Points and a ceiling for a countable thing.
 *
 * Nine experiences is a real signal and nineteen is padding, so every count has
 * a cap. Both numbers are here rather than in code because which of them matters
 * is a judgement about the population, not a fact about it.
 */
export type CountRule = { points: number; cap: number };

export type CountRules = Record<CountKind, CountRule>;

/**
 * Colour thresholds for a score. Defined in lib/clusters.ts alongside the rest of
 * the model; re-exported here because this is where the taxonomy lives.
 *
 * They used to be sigma cutoffs hardcoded in `scoreBand`. On an additive scale the
 * right numbers depend entirely on how the weights are tuned, so they became part
 * of the taxonomy.
 */
export type { BandThresholds } from "./clusters";

export type TaxonomyPrefs = {
  /** Term to weight. Only entries someone actually changed. */
  weights: Record<string, number>;
  /** Term to cluster, or null for "carries weight, casts no vote". */
  clusters: Record<string, Archetype | null>;
  /** Extracted terms promoted into the taxonomy, so they start scoring. */
  promoted: string[];
  /** Extracted terms dismissed, so they stop being suggested. */
  dismissed: string[];

  /**
   * The tag registry: one entry per real-world thing, with its aliases, so two
   * spellings of one award can never both score. Supersedes `promoted`, which is
   * kept for the legacy read path during migration.
   */
  tags: TagRegistry;
  /**
   * Which generation of the seed weights this document has seen.
   *
   * A stored weight is normally the team's to keep, and the migration never touches
   * it. But a stored weight is *also* what an older seed list happened to say, and
   * those two are indistinguishable after the fact. When the seed table is
   * deliberately recalibrated, this is what lets the correction reach documents
   * already written — once, for the tags the seeds own, and never again.
   */
  seedVersion?: number;
  /** How much a countable thing is worth, and where counting stops. */
  counts: CountRules;
  /** Score needed in two or more clusters for the Polymath badge. */
  polymathPoints: number;
  /** Default weight for a newly promoted tag, per facet. */
  facetDefaults: Record<TagFacet, number>;
  bands: BandThresholds;
};

/** Team-shared. Small, and always read together, so one document. */
export type TeamState = {
  taxonomy: TaxonomyPrefs;
  customTerms: CustomTerms;
  /**
   * Slugs erased for good, so they cannot come back.
   *
   * Rejecting is personal and reversible — it lives in `marks`, and it suppresses
   * someone from *your* sweeps by remembering that you said no. Deleting is neither:
   * it drops the shared roster row and the archived vendor payload, and there is then
   * nothing left to remember them by. Without this list the next sweep would surface
   * them as a brand-new face and re-add them, which is the opposite of what the
   * button says.
   *
   * Team-wide, because the roster it guards is team-wide. Reversible from the
   * taxonomy screen, since the alternative is that one misfire bans someone forever
   * with no way to see it happened.
   */
  deleted: string[];
  updatedAt: string;
};

/**
 * Blocklist cap.
 *
 * Bounded because this document is read on every page load. Well above any real
 * amount of deleting, and oldest-first eviction is the right end to lose: a slug
 * deleted long ago is one nothing is still trying to re-add.
 */
export const MAX_DELETED = 2000;

export type QueueFilters = {
  cluster: Archetype | "all";
  band: string;
  years: string[];
  pinnedOnly: boolean;
  enrichedOnly: boolean;
  polymathOnly: boolean;
};

/** One teammate's own document. */
export type ProfileState = {
  /** Slug to mark. Queue membership, pin, already-known, rejected. */
  marks: Marks;
  /** Newest first, capped so the document stays small. */
  sweeps: SavedSweep[];
  lastSelection: Selection | null;
  queueFilters: QueueFilters | null;
  /** When the digest was last opened, so it can mark what is new. */
  digestSeenAt: string | null;
  seeds: string[];
  /** An enrichment run in flight, so a reload reattaches instead of orphaning it. */
  activeJobId: string | null;
  /**
   * Who the last run added, so the People Also Viewed offer built from them
   * survives a reload. Held here rather than on the page because the offer is
   * derived from the roster and the only thing a reload loses is which people to
   * derive it from. Capped, since it is only ever a batch.
   */
  recentSlugs: string[];
  updatedAt: string;
};

/** One batch's worth. The enrich route caps a run at 250. */
export const MAX_RECENT_SLUGS = 250;

/**
 * A stored sweep keeps every hit so "Load" can replay it. On a paid Serper plan
 * that is up to 100 hits each, so the cap is lower than it looks like it should
 * be — 25 runs of history is more than anyone scrolls back through.
 */
export const MAX_SAVED_SWEEPS = 25;

export const SCHEMA_VERSION = 2;

export function stateKey(profile: ProfileId): string {
  return `zscore:profile:${profile}`;
}
export const ROSTER_KEY = "zscore:team:people";
export const TEAM_KEY = "zscore:team:prefs";
export const SCHEMA_KEY = "zscore:team:schema";

/**
 * The vendor's untouched payload for one person, archived per key.
 *
 * Its own key rather than a field on the roster, because the roster hash is read
 * on every page load and this is only ever needed when re-deriving. Holding it at
 * all is what makes adding a field later free instead of a paid re-enrich.
 */
export function rawKey(slug: string): string {
  return `zscore:raw:${slug}`;
}

/**
 * Starting calibration.
 *
 * Deliberately modest. A count is worth less than a named credential, because
 * listing nine roles is easier than getting into RSI, and the caps stop a padded
 * profile from out-scoring a strong one on volume alone.
 */
export function defaultCounts(): CountRules {
  return {
    /**
     * Priced well below the credentials, and capped low.
     *
     * These were worth up to 7.6 between them, against a target of about 10 for the
     * strongest person in the roster — so most of a score could come from the least
     * discriminating thing on a profile. Anyone can list eight experiences.
     *
     * Cut again, to a ceiling of 2.4, because counts are breadth by definition and
     * breadth was still winning: half of a publication-heavy score came from here,
     * which put it above founders who had been funded. A publication or a patent
     * still moves a score noticeably, because for a nineteen-year-old it should.
     *
     * One decimal throughout, because that is all a weight can hold: `clampWeight`
     * rounds to a tenth, so a stored 0.15 became 0.2 the first time anyone saved.
     */
    experience: { points: 0.1, cap: 4 },
    project: { points: 0.1, cap: 3 },
    publication: { points: 0.3, cap: 3 },
    patent: { points: 0.4, cap: 2 },
    /**
     * Off by default. An award already scores as its own tag, and a profile with
     * seventeen honors is mostly listing AP Scholar and National Merit — paying
     * per honor on top of the award weights rewards length, not achievement. The
     * knob exists so it can be turned on deliberately.
     */
    honor: { points: 0, cap: 8 },
  };
}

/**
 * Default weight for a newly promoted tag of each facet.
 *
 * A program or award is the thing this tool exists to find, so those start
 * highest. A job title is the cheapest claim on a profile, so it starts lowest.
 * Counts are not here: they are priced by `CountRules`, not per tag.
 */
export function defaultFacetWeights(): Record<TagFacet, number> {
  return {
    program: 0.8,
    // The heaviest default in the table. Somebody wrote a cheque.
    accelerator: 1.2,
    /**
     * These are what a name *nobody curated* starts at — an employer, a university
     * or a school first seen on somebody's profile. The seeded lists sit above them,
     * and named tunings above that.
     *
     * Titles start at zero on purpose. A title is what you were called; the few
     * worth points are named in START_WEIGHT. Listing "Intern", "Analyst" and
     * "Software Engineer" used to pay 0.6 — more than an ISEF finalist now scores.
     */
    company: 0.2,
    /**
     * What an unrecognised one starts at, and the three sit low on purpose.
     *
     * The seeded lists are above them and named tunings above that. A startup is
     * lowest because the long tail is somebody's own side project, and the signal
     * that they *built* it is already carried by the founding title.
     */
    startup: 0.1,
    lab: 0.3,
    club: 0.2,
    org: 0.1,
    college: 0.2,
    highschool: 0.1,
    major: 0.1,
    title: 0,
    flag: 0.2,
    count: 0,
    year: 0,
    // Geography groups and filters; it is not an achievement, so it starts at zero.
    state: 0,
    homestate: 0,
  };
}

/**
 * Sized so the top of a real roster reaches the top band.
 *
 * The recalibrated table puts the strongest person in the live queue at 9.9, and the
 * ceiling was 20 — so nobody was ever exceptional and a third of the roster fell
 * below the lowest band. These cut the actual distribution into shapes that mean
 * something: one exceptional, a couple strong, a third in the middle.
 */
export function defaultBands(): BandThresholds {
  return { exceptional: 9, strong: 7, above: 5, mid: 3 };
}

/**
 * The starting registry, built from the vocabulary that was already curated.
 *
 * A new tag scores zero until someone promotes it, which is the right default and
 * what was asked for. But the extractor produces roughly thirty candidates per
 * person, so an empty registry would mean several hundred promotions before any
 * score meant anything. Everything seeded here was hand-picked already, so it
 * arrives promoted at the weight it already had, and the review queue holds only
 * genuinely new things.
 */
function seededTags(): TagRegistry {
  return seedRegistry({
    programs: PROGRAMS,
    accelerators: ACCELERATORS,
    startups: STARTUPS,
    labs: LABS,
    clubs: CLUBS,
    flags: FLAGS,
    colleges: COLLEGES,
    highSchools: HIGH_SCHOOLS,
    titles: TITLES,
    majors: MAJORS,
    companies: COMPANIES,
    startWeight: START_WEIGHT,
    termCluster: TERM_CLUSTER,
    states: US_STATES,
    facetDefaults: defaultFacetWeights(),
  });
}

export function emptyTeam(): TeamState {
  return {
    taxonomy: {
      weights: {},
      clusters: {},
      promoted: [],
      dismissed: [],
      tags: seededTags(),
      counts: defaultCounts(),
      /**
       * Reaching this in two clusters earns the badge. 1.5 is roughly one strong
       * credential, which keeps the old meaning: IOI (2.0, olympiad) plus RSI
       * (1.8, research) is a polymath, TASP plus Mathcamp is not.
       */
      polymathPoints: 1.5,
      facetDefaults: defaultFacetWeights(),
      bands: defaultBands(),
    },
    customTerms: {
      programs: [],
      titles: [],
      colleges: [],
      highSchools: [],
      years: [],
      states: [],
      homeStates: [],
    },
    deleted: [],
    updatedAt: new Date().toISOString(),
  };
}

export function emptyState(): ProfileState {
  return {
    marks: {},
    sweeps: [],
    lastSelection: null,
    queueFilters: null,
    digestSeenAt: null,
    seeds: [],
    activeJobId: null,
    recentSlugs: [],
    updatedAt: new Date().toISOString(),
  };
}

export const emptyFilters = (): QueueFilters => ({
  cluster: "all",
  band: "all",
  years: [],
  pinnedOnly: false,
  enrichedOnly: false,
  polymathOnly: false,
});

/** Fill in anything a stored document is missing, so older writes stay readable. */
export function hydrate(stored: Partial<ProfileState> | null): ProfileState {
  const base = emptyState();
  if (!stored) return base;
  return {
    ...base,
    ...stored,
    marks: stored.marks ?? base.marks,
    sweeps: Array.isArray(stored.sweeps) ? stored.sweeps : base.sweeps,
    seeds: stored.seeds ?? base.seeds,
    recentSlugs: stored.recentSlugs ?? base.recentSlugs,
  };
}

/**
 * Reclassify tags stored under the retired "school" facet.
 *
 * College and high school started as one facet and were split, because they
 * answer different questions and carry very different weights. Sixty seeded tags
 * were already stored under the old name, and a facet that no longer exists is
 * dropped by validation — so without this they vanish from the taxonomy screen and
 * the sweep menus, taking their weights with them.
 *
 * Decided against the curated lists first, since those are exactly the tags that
 * were seeded, then by name.
 */
const LEGACY_SCHOOL = "school";
/**
 * Retired. A programme and an award were never two different kinds of thing — a
 * Palantir Meritocracy Fellowship and a Bank of America Student Leader award are
 * both "somebody selective picked you", which is what `program` means. Two sections
 * only ever meant two places to look and a coin flip about which one a new tag
 * landed in.
 */
const LEGACY_AWARD = "award";

/**
 * The facet a seed list assigns, keyed by canonical id.
 *
 * The seed lists are authoritative: a curated entry knows what it is. A tag
 * promoted from the review queue defaults to `award`, because that is what the
 * tagger reads out of prose — so "Z Fellows" arrived as an award even though
 * `PROGRAMS` names it a programme. This corrects that on read rather than leaving
 * it to be noticed and fixed by hand.
 */
function seedFacets(): Map<string, TagFacet> {
  const m = new Map<string, TagFacet>();
  const put = (label: string, facet: TagFacet) => {
    const id = seedKey(label);
    if (id && !m.has(id)) m.set(id, facet);
  };
  // Accelerators before programmes, matching seedRegistry, so a label in both lists
  // resolves the same way in the migration as it does in a fresh document.
  for (const x of ACCELERATORS) put(x.label, "accelerator");
  for (const x of LABS) put(x.label, "lab");
  for (const x of CLUBS) put(x.label, "club");
  for (const x of STARTUPS) put(x.label, "startup");
  for (const x of FLAGS) put(x.label, "flag");
  for (const x of PROGRAMS) put(x.label, "program");
  for (const x of COLLEGES) put(x.label, "college");
  for (const x of HIGH_SCHOOLS) put(x.label, "highschool");
  for (const x of TITLES) put(x.label, "title");
  for (const x of MAJORS) put(x.label, "major");
  for (const x of COMPANIES) put(x.label, "company");
  return m;
}

/**
 * The current generation of `START_WEIGHT` and the facet defaults.
 *
 * Bump this only for a deliberate, whole-table recalibration, and say what changed.
 *
 *   1 — the original table.
 *   2 — accelerators split out and put at the top; competitions repriced by cohort
 *       size (ISEF 1.4 → 0.8, MOP 1.0 → 1.6); titles zeroed; counts cut from a
 *       ceiling of 7.6 to 3.4, so the strongest person lands near 10.
 *   3 — startups, labs and college clubs split out of "company"; hackathons and open
 *       competitions added, which were missing entirely.
 *   4 — the open-entry half of that removed again: AIME, DECA, FBLA, HOSA, Science
 *       Olympiad and the second-tier hackathons say nothing about a person and were
 *       inflating anyone who listed a lot of activities. Activity-tier weights cut so
 *       that breadth cannot out-score depth.
 */
export const SEED_VERSION = 4;

/**
 * Adopt a recalibrated seed table, once.
 *
 * Only touches tags the seed lists own, and only their weight and cluster — a tag
 * the team created, and anything the team added to a seeded tag, is left exactly as
 * it is. Guarded by the version so it cannot run twice and cannot creep into being a
 * rule that quietly overwrites tuning whenever a seed changes.
 */
const behindSeeds = (tax: Partial<TaxonomyPrefs>) => (tax.seedVersion ?? 1) < SEED_VERSION;

function adoptSeedWeights(tags: TagRegistry): TagRegistry {
  const seeded = seededTags();
  const retired = new Set(RETIRED.map((label) => seedKey(label)));
  let changed = false;
  const next = { ...tags };
  for (const [id, def] of Object.entries(tags)) {
    // Withdrawn from the vocabulary: switched off rather than deleted, so it is
    // visible on the taxonomy screen and one slider from coming back.
    if (retired.has(id)) {
      if (def.weight !== 0 || def.promoted) {
        next[id] = { ...def, weight: 0, promoted: false };
        changed = true;
      }
      continue;
    }
    const seed = seeded[id];
    if (!seed) continue;
    if (def.weight === seed.weight && (def.cluster ?? null) === (seed.cluster ?? null)) continue;
    next[id] = { ...def, weight: seed.weight, cluster: seed.cluster };
    changed = true;
  }
  return changed ? next : tags;
}

/**
 * Bring a stored registry up to date with the seed vocabulary.
 *
 * Three jobs, all on read, so a stored document never has to be edited by hand:
 *
 *   1. Reclassify the retired "school" facet, split into college and high school.
 *      A facet that no longer exists is dropped by validation, so without this the
 *      sixty seeded school tags vanish from the screens and take their weights.
 *   2. Correct a facet the seed lists disagree with. A tag promoted from the review
 *      queue defaults to `award`, so "Z Fellows" arrived as an award even though
 *      PROGRAMS names it a programme.
 *   3. Union in new seed tags and new aliases. Aliases are the whole mechanism
 *      preventing "Massachusetts Institute of Technology" from becoming a second
 *      MIT, and adding one to a seed list has to reach documents already stored.
 *   4. Surrender an alias the seeds have since given to a different tag. Splitting
 *      Jane Street AMP out of Jane Street moved "AMP" from the firm to the
 *      programme, and without this the firm kept it — so the alias table had one
 *      key pointing at two tags and which one won was arbitrary.
 *
 * Weights, clusters and promoted state are never touched: those are the team's
 * tuning, and a seed list has no business overwriting them.
 */
function migrateFacets(tags: TagRegistry): TagRegistry {
  /**
   * Deleted, not switched off.
   *
   * `RETIRED` leaves a row on the taxonomy screen at zero, which is right for a
   * judgement call someone might reverse. These are not judgement calls — a tag for
   * an organisation with two hundred thousand members is noise, and leaving the row
   * there only invites somebody to switch it back on.
   */
  const purged = new Set(PURGED.map((label) => seedKey(label)));
  if (Object.keys(tags).some((id) => purged.has(id))) {
    tags = Object.fromEntries(Object.entries(tags).filter(([id]) => !purged.has(id)));
  }

  const colleges = new Set(COLLEGES.map((c) => c.label.toLowerCase()));
  const authoritative = seedFacets();
  const seeded = seededTags();

  /**
   * Which tag the seed lists say each alias belongs to.
   *
   * Only aliases the seeds actually claim are listed, so one a teammate added by
   * hand is invisible here and therefore untouched below.
   */
  const aliasOwner = new Map<string, string>();
  for (const def of Object.values(seeded)) {
    for (const a of def.aliases) if (!aliasOwner.has(a)) aliasOwner.set(a, def.id);
  }

  let changed = false;
  const next = { ...tags };

  for (const def of Object.values(tags)) {
    let updated = def;

    if ((updated.facet as string) === LEGACY_AWARD) {
      updated = { ...updated, facet: "program" };
    }

    if ((updated.facet as string) === LEGACY_SCHOOL) {
      const label = updated.label.toLowerCase();
      const isCollege =
        colleges.has(label) ||
        /university|college|institute of technology|\bpolytechnic\b/.test(label);
      updated = { ...updated, facet: isCollege ? "college" : "highschool" };
    }

    const should = authoritative.get(updated.id);
    if (should && should !== updated.facet) updated = { ...updated, facet: should };

    // Union, never replace: an alias someone added by hand must survive. But an
    // alias the seeds have reassigned is given up, or two tags answer to one key.
    const fresh = seeded[updated.id];
    const merged = [...new Set([...updated.aliases, ...(fresh?.aliases ?? [])])].filter(
      (a) => a !== updated.id && (aliasOwner.get(a) ?? updated.id) === updated.id
    );
    if (
      merged.length !== updated.aliases.length ||
      merged.some((a, i) => a !== updated.aliases[i])
    ) {
      updated = { ...updated, aliases: merged };
    }
    // A school's state, which arrived after these documents were written. Without
    // this the home state silently stays empty for every seeded school already
    // stored — Groton, Phillips Exeter and Brooklyn Tech all lost theirs.
    if (fresh?.state && !updated.state) updated = { ...updated, state: fresh.state };

    if (updated !== def) {
      next[updated.id] = updated;
      changed = true;
    }
  }

  // Newly seeded entries the stored document has never seen.
  for (const [id, def] of Object.entries(seeded)) {
    if (!next[id]) {
      next[id] = def;
      changed = true;
    }
  }

  return changed ? next : tags;
}

export function hydrateTeam(stored: Partial<TeamState> | null): TeamState {
  const base = emptyTeam();
  if (!stored) return base;
  const tax: Partial<TaxonomyPrefs> = stored.taxonomy ?? {};
  return {
    ...base,
    ...stored,
    taxonomy: {
      ...base.taxonomy,
      ...tax,
      // Nested objects need their own merge, or a document written before these
      // existed comes back with the field missing rather than defaulted, and
      // every read of `counts.experience.points` throws.
      // Migrated on read, so a document written before the school split keeps its
      // sixty school tags instead of having them silently validated away.
      /**
       * A document behind the seed generation takes the new table for the three
       * things the recalibration is *about*: the weights, the count prices and the
       * facet defaults. A document already current keeps whatever it holds.
       */
      ...(() => {
        const migrated = migrateFacets(tax.tags ?? base.taxonomy.tags);
        return behindSeeds(tax)
          ? {
              tags: adoptSeedWeights(migrated),
              counts: base.taxonomy.counts,
              facetDefaults: base.taxonomy.facetDefaults,
              // The thresholds are read in the same units, so they move together.
              bands: base.taxonomy.bands,
            }
          : {
              tags: migrated,
              counts: { ...base.taxonomy.counts, ...(tax.counts ?? {}) },
              facetDefaults: { ...base.taxonomy.facetDefaults, ...(tax.facetDefaults ?? {}) },
              bands: { ...base.taxonomy.bands, ...(tax.bands ?? {}) },
            };
      })(),
      seedVersion: SEED_VERSION,
      /**
       * Known noise is declined once, in the seeds, rather than one profile at a time.
       *
       * Unioned so nothing a teammate dismissed by hand comes back, and never
       * subtracted: this is the same list the dismiss button writes to, so anything
       * seeded here can be brought back on the taxonomy screen.
       */
      dismissed: [...new Set([...(tax.dismissed ?? []), ...LOW_SIGNAL])],
      polymathPoints: tax.polymathPoints ?? base.taxonomy.polymathPoints,
    },
    customTerms: { ...base.customTerms, ...(stored.customTerms ?? {}) },
    // Written before the blocklist existed, so a missing field is "nobody", not a
    // read of `undefined.includes` on the add path.
    deleted: Array.isArray(stored.deleted)
      ? stored.deleted.filter((s): s is string => typeof s === "string")
      : base.deleted,
  };
}

/**
 * Shallow merge at the top level. Every field is replaced wholesale by the
 * client, which already holds the full current value, so a deep merge would
 * make deletions impossible.
 */
export function mergeState(base: ProfileState, patch: Partial<ProfileState>): ProfileState {
  const next: ProfileState = { ...base, ...patch, updatedAt: new Date().toISOString() };
  if (next.sweeps.length > MAX_SAVED_SWEEPS) next.sweeps = next.sweeps.slice(0, MAX_SAVED_SWEEPS);
  return next;
}

export function mergeTeam(base: TeamState, patch: Partial<TeamState>): TeamState {
  return {
    ...base,
    ...patch,
    taxonomy: { ...base.taxonomy, ...(patch.taxonomy ?? {}) },
    customTerms: { ...base.customTerms, ...(patch.customTerms ?? {}) },
    updatedAt: new Date().toISOString(),
  };
}

import type { Archetype } from "./clusters";
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
};

export type TaxonomyPrefs = {
  /** Term to weight. Only entries someone actually changed. */
  weights: Record<string, number>;
  /** Term to cluster, or null for "carries weight, casts no vote". */
  clusters: Record<string, Archetype | null>;
  /** Extracted terms promoted into the taxonomy, so they start scoring. */
  promoted: string[];
  /** Extracted terms dismissed, so they stop being suggested. */
  dismissed: string[];
};

/** Team-shared. Small, and always read together, so one document. */
export type TeamState = {
  taxonomy: TaxonomyPrefs;
  customTerms: CustomTerms;
  updatedAt: string;
};

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
  updatedAt: string;
};

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

export function emptyTeam(): TeamState {
  return {
    taxonomy: { weights: {}, clusters: {}, promoted: [], dismissed: [] },
    customTerms: { programs: [], titles: [], colleges: [], highSchools: [], years: [] },
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
  };
}

export function hydrateTeam(stored: Partial<TeamState> | null): TeamState {
  const base = emptyTeam();
  if (!stored) return base;
  return {
    ...base,
    ...stored,
    taxonomy: { ...base.taxonomy, ...(stored.taxonomy ?? {}) },
    customTerms: { ...base.customTerms, ...(stored.customTerms ?? {}) },
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

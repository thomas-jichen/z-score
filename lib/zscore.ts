/**
 * Score display model.
 *
 * `score` is a point total: the sum of the weights of the tags a person holds
 * plus the priced counts, and nothing else. It is what every ranked list sorts
 * on. `archetype_score` is the same sum restricted to the terms voting for their
 * primary cluster, which is what a breakdown wants.
 *
 * The figures are written with a σ throughout. That is house style carried over
 * from when this really was a z-score; it is not a standard deviation and no copy
 * in the product claims it is.
 *
 * The model itself — clusters, weights, counts — lives in lib/clusters.ts and
 * lib/candidates.ts. This file is the shape the screens read.
 */

export type { Archetype, ScoreBand } from "./clusters";
export {
  ARCHETYPES,
  archetypeLabel,
  formatSigma,
  isArchetype,
  scoreBand,
} from "./clusters";

import type { Archetype } from "./clusters";

/**
 * One contributing term in a breakdown.
 *
 * `points` is the weight itself, so the breakdown sums to the displayed total
 * exactly. It used to be `deviation`, the weight divided by sigma, which meant the
 * rows on the detail screen never added up to the number above them.
 */
export type Signal = {
  id: string;
  /** What it is, as it should read to a human: "IMO Silver 2025" */
  label: string;
  /** Which part of the record it came from. `snippet` means search text only. */
  source:
    | "honors"
    | "projects"
    | "volunteering"
    | "education"
    | "experience"
    | "snippet"
    | "extracted"
    | "roster";
  /** Contribution to the total, in points. */
  points: number;
  /** Which cluster this term votes for, if any. */
  cluster?: Archetype | null;
  /** Present when a public roster corroborates the claim. */
  verifiedBy?: string;
};

/** One hop in the discovery chain. Every hop is navigable in the UI. */
export type DiscoveryHop = {
  kind: "seed" | "people_also_viewed" | "keyword_sweep" | "roster";
  label: string;
  /** Profile slug, when the hop is a person. Absent for keyword/roster hops. */
  slug?: string;
};

export type Candidate = {
  slug: string;
  name: string;
  headline: string;
  url: string;
  location?: string;
  state?: string;
  school?: string;
  graduation_year?: string;

  /** Primary cluster: the single highest-weighted matched term wins. */
  archetype: Archetype;
  /** Reaching `taxonomy.polymathPoints` in two or more clusters. A badge. */
  polymath: boolean;
  /** The other clusters they clear, for the badge's detail. */
  secondary_archetypes: Archetype[];

  /** Points from the terms voting for their primary cluster. */
  archetype_score: number;
  /** The whole-profile total. This is what ranked lists sort on. */
  score: number;
  /** Points per cluster, for the breakdown and the polymath badge. */
  cluster_scores: Partial<Record<Archetype, number>>;

  signals: Signal[];
  discovery: DiscoveryHop[];

  /** False when this person is known from search results alone. */
  enriched: boolean;
  surfaced_at: string;
};

/** The two or three terms that dominate the score, largest first. */
export function dominantSignals(c: Candidate, n = 3): Signal[] {
  return [...c.signals].sort((a, b) => b.points - a.points).slice(0, n);
}

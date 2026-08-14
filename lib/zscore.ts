/**
 * Z-Score display model.
 *
 * The product name is the metric: a candidate's score is a true z-score,
 * standard deviations from a fixed reference point. `z_score_normalized` is the
 * whole-profile figure and the one every ranked list sorts on;
 * `z_score_archetype` is the same person measured against their own cluster,
 * which is what a breakdown wants.
 *
 * The model itself — clusters, weights, calibration — lives in lib/clusters.ts.
 * This file is the shape the screens read plus the formatting they need.
 */

export type { Archetype, ScoreBand } from "./clusters";
export {
  ARCHETYPES,
  SCORE_BANDS,
  archetypeLabel,
  formatSigma,
  isArchetype,
  scoreBand,
} from "./clusters";

import type { Archetype } from "./clusters";

/** One contributing term in a breakdown, expressed as a deviation, never points. */
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
  /** Contribution in sigma. Can be negative. */
  deviation: number;
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
  /** Clearing +0.5σ in two or more clusters. A badge, not a cluster. */
  polymath: boolean;
  /** The other clusters they clear, for the badge's detail. */
  secondary_archetypes: Archetype[];

  /** Measured against their own cluster. */
  z_score_archetype: number;
  /** Whole-profile figure. This is what ranked lists sort on. */
  z_score_normalized: number;
  /** Per-cluster z, for the breakdown and the polymath badge. */
  cluster_scores: Partial<Record<Archetype, number>>;

  signals: Signal[];
  discovery: DiscoveryHop[];

  /** False when this person is known from search results alone. */
  enriched: boolean;
  surfaced_at: string;
};

/**
 * `z_score` is the value shown to the user: the whole-profile figure. The
 * cluster-relative intermediate is available separately for breakdowns.
 */
export function z_score(c: Candidate): number {
  return c.z_score_normalized;
}

/** The two or three terms that dominate the score, largest absolute first. */
export function dominantSignals(c: Candidate, n = 3): Signal[] {
  return [...c.signals].sort((a, b) => Math.abs(b.deviation) - Math.abs(a.deviation)).slice(0, n);
}

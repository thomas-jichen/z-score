/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The scoring model. Six clusters, and addition.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── The whole formula ─────────────────────────────────────────────────────
 *
 *     score = Σ weight(tag)               for promoted tags the person holds
 *           + Σ points(kind) × min(n, cap)  for countable things
 *
 * That is it. No mean, no standard deviation, no division, no population. Every
 * term is a number someone set on the taxonomy screen, so any total can be
 * explained by pointing at the rows that produced it.
 *
 * This replaced a standardised model whose figure was `(raw − 2.2) / 1.8`. The
 * property worth keeping from it was never the statistics — it was that the
 * calibration is fixed, so the same person scores the same regardless of who else
 * has been enriched. Addition keeps that for free, and `toCandidates` remains a
 * plain map with no reduce over the pool.
 *
 * Worked examples against START_WEIGHT below, asserted in
 * scripts/check-parsing.ts so a weight edit cannot silently move the scale:
 *
 *     Hack Club alone              0.7
 *     RSI + ISEF + USAMO           4.5
 *     IMO + IOI + RSI + 1 pub      6.6
 *
 * The UI still writes these with a σ. It is a house mark, not a claim.
 *
 * ── Why six clusters, and why polymath is not one ─────────────────────────
 * A cluster is a reference class. Polymath is not a population, it is the union
 * of overlaps, so it was made a badge instead: awarded for reaching
 * `taxonomy.polymathPoints` in two or more clusters. Same fact, no pretence that
 * you could take a mean of it.
 */

/**
 * Five clusters.
 *
 * "olympiad" was folded into "quant": competition maths and quantitative trading
 * select for the same thing, and splitting them meant a USAMO qualifier and a Jane
 * Street intern were treated as different populations when the pipeline between
 * them is the most trodden path in this population.
 *
 * "scholar" became "operator". Selective-scholarship-and-humanities was a
 * catch-all for whatever the other four did not describe, which is the shape of a
 * missing category rather than a real one. Operator names something specific:
 * people who run things — chapters, non-profits, camps, programmes.
 */
export type Archetype = "research" | "builder" | "founder" | "quant" | "operator";

/**
 * Colour thresholds for a score. Declared here rather than in lib/state.ts so
 * that state can import the weights and the seed vocabulary from this file
 * without the two forming a cycle. Re-exported from state for callers.
 */
export type BandThresholds = {
  exceptional: number;
  strong: number;
  above: number;
  mid: number;
};

export const ARCHETYPES: { id: Archetype; label: string; blurb: string }[] = [
  { id: "quant", label: "Quant", blurb: "Competition math and informatics, trading, quantitative research" },
  { id: "research", label: "Research", blurb: "Published, lab-affiliated, or a selective research program" },
  { id: "builder", label: "Builder", blurb: "Ships things: repos, hardware, side projects" },
  { id: "founder", label: "Founder", blurb: "Started something with users or revenue" },
  { id: "operator", label: "Operator", blurb: "Runs things: chapters, non-profits, programs, teams" },
];

/**
 * Tie-break order for equal weights, so a person's label never flickers
 * between renders. Earlier wins.
 */
const CLUSTER_ORDER: Archetype[] = ["quant", "research", "founder", "builder", "operator"];

export function archetypeLabel(a: Archetype): string {
  return ARCHETYPES.find((x) => x.id === a)?.label ?? a;
}

export function isArchetype(v: unknown): v is Archetype {
  return typeof v === "string" && ARCHETYPES.some((a) => a.id === v);
}

/**
 * Which cluster a term votes for. `null` means the term carries score weight
 * but casts no vote — QuestBridge is a socioeconomic context signal, not a
 * talent type, and calling it an archetype was always arbitrary. Editable per
 * term on the taxonomy screen, including back to a cluster.
 */
export const TERM_CLUSTER: Record<string, Archetype | null> = {
  // Quant, which now covers competition maths and informatics as well as trading.
  IMO: "quant",
  IOI: "quant",
  USAMO: "quant",
  "USACO Platinum": "quant",
  USAPhO: "quant",
  USABO: "quant",
  Mathcamp: "quant",
  PROMYS: "quant",
  // Research
  RSI: "research",
  STS: "research",
  ISEF: "research",
  SSP: "research",
  "MIT PRIMES": "research",
  "Simons Fellow": "research",
  "Garcia Program": "research",
  // Builder
  "Hack Club": "builder",
  "Conrad Challenge": "builder",
  // Founder
  "Thiel Fellow": "founder",
  "Neo Scholar": "founder",
  "Diamond Challenge": "founder",
  "Jane Street": "quant",
  // Operator
  "Coca-Cola Scholar": "operator",
  TASP: "operator",
  SPARC: "operator",
  QuestBridge: null,
  // Z Fellows is a fellowship you get for starting something, so it is a
  // programme that votes Founder rather than an award.
  "Z Fellow": "founder",
};

/** Starting points for a human to tune, which is the point of the taxonomy screen. */
export const START_WEIGHT: Record<string, number> = {
  IMO: 2.0,
  IOI: 2.0,
  RSI: 1.8,
  STS: 1.8,
  "Thiel Fellow": 1.6,
  "MIT PRIMES": 1.5,
  ISEF: 1.4,
  USAMO: 1.3,
  "Neo Scholar": 1.3,
  "USACO Platinum": 1.2,
  "Jane Street": 1.2,
  PROMYS: 1.1,
  SSP: 1.0,
  "Simons Fellow": 1.0,
  "Coca-Cola Scholar": 0.9,
  "Garcia Program": 0.9,
  USAPhO: 0.9,
  USABO: 0.9,
  SPARC: 0.8,
  "Conrad Challenge": 0.8,
  QuestBridge: 0.8,
  "Hack Club": 0.7,
  "Diamond Challenge": 0.7,
  Mathcamp: 0.7,
  TASP: 0.6,
};

/** Anything promoted from the review queue without an explicit weight. */
export const DEFAULT_WEIGHT = 0.5;

/**
 * The score is a sum, and nothing else.
 *
 * There used to be a global `CALIBRATION = { mu: 2.2, sigma: 1.8 }` and a
 * per-cluster equivalent, and every figure on every screen was
 * `(raw − mu) / sigma`. Both are gone, along with `zFrom` and `POLYMATH_SIGMA`.
 *
 * What survives is the part that was already doing the work: a weight per tag, a
 * points-per-item price for countable things, and addition. Every input is
 * editable on the taxonomy screen, so a number can always be explained by
 * pointing at the rows that produced it.
 *
 * The σ glyph is kept in the UI as a house style. It no longer denotes a standard
 * deviation, and the prose that claimed it did has been rewritten rather than
 * left to mislead.
 */
export function weightOf(label: string, overrides: Record<string, number>): number {
  return overrides[label] ?? START_WEIGHT[label] ?? DEFAULT_WEIGHT;
}

export function clusterOf(
  label: string,
  overrides: Record<string, Archetype | null>
): Archetype | null {
  if (label in overrides) return overrides[label];
  return TERM_CLUSTER[label] ?? null;
}

/** Keep values identical across server and client renders. */
export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Primary cluster: the single highest-weighted matched term wins.
 *
 * Deliberately not "the cluster where their own z is highest", which would ask
 * which population they are more exceptional within. Highest-weight-wins is
 * simpler and predictable: drag RSI above IOI on the taxonomy screen and an
 * IOI+RSI person becomes Research. The taxonomy is the model.
 *
 * Per-cluster z is computed anyway for the badge, so switching to
 * highest-z-wins later is a change to this function alone.
 */
export function assignCluster(
  terms: { label: string; weight: number; cluster: Archetype | null }[]
): Archetype | null {
  let best: { cluster: Archetype; weight: number } | null = null;

  for (const t of terms) {
    if (!t.cluster) continue;
    if (!best || t.weight > best.weight) {
      best = { cluster: t.cluster, weight: t.weight };
      continue;
    }
    // Equal weight: fixed order decides, so the label is stable.
    if (t.weight === best.weight) {
      const a = CLUSTER_ORDER.indexOf(t.cluster);
      const b = CLUSTER_ORDER.indexOf(best.cluster);
      if (a !== -1 && (b === -1 || a < b)) best = { cluster: t.cluster, weight: t.weight };
    }
  }

  return best?.cluster ?? null;
}

/** Headline words that indicate building rather than credentialling. */
export const FOUNDER_WORDS =
  /\b(founder|co-?founder|ceo|started|launched|y combinator|yc\s?[swf]\d{2})\b/i;
export const BUILDER_WORDS = /\b(building|built|shipped|open ?source|maintainer|hackathon)\b/i;
export const QUANT_WORDS = /\b(quant|quantitative|trading|trader|market making)\b/i;

/**
 * Cluster when no taxonomy term matched at all. Common for exactly the people
 * this tool is meant to find — the ones with limited online presence and no
 * brand-name program on their profile.
 */
export function clusterFromText(text: string, hasProjects: boolean): Archetype | null {
  if (FOUNDER_WORDS.test(text)) return "founder";
  if (QUANT_WORDS.test(text)) return "quant";
  if (BUILDER_WORDS.test(text) || hasProjects) return "builder";
  return null;
}

export const SCORE_BANDS_ORDER = ["exceptional", "strong", "above", "mid", "below"] as const;
export type ScoreBand = (typeof SCORE_BANDS_ORDER)[number];

/**
 * Colour only. Blue is reserved for genuine outliers so a column of these reads
 * as a distribution rather than a wall of accent.
 *
 * The thresholds are no longer constants: on a sum, the right cutoffs depend on
 * how the weights were tuned, so they come from the taxonomy and move with it.
 */
export function scoreBand(score: number, bands: BandThresholds): ScoreBand {
  if (score >= bands.exceptional) return "exceptional";
  if (score >= bands.strong) return "strong";
  if (score >= bands.above) return "above";
  if (score >= bands.mid) return "mid";
  return "below";
}

/**
 * Always rendered with an explicit sign.
 *
 * The σ is a house mark, not a claim: this is a point total, not a deviation.
 * Kept because the product is called Z-Score and the notation is what the team
 * reads fluently.
 */
export function formatSigma(score: number): string {
  const sign = score < 0 ? "−" : "+";
  return `${sign}${Math.abs(score).toFixed(1)}σ`;
}

/**
 * ═══════════════════════════════════════════════════════════════════════════
 * The scoring model. Six clusters, fixed calibration, no measured population.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── Why the calibration is fixed ──────────────────────────────────────────
 * The score used to standardise over whoever happened to be enriched. That has
 * three consequences, all bad: a person's number moves as the pool grows, a
 * lone candidate always scores exactly 0, and two teammates see different
 * values for the same person. So mu and sigma are constants here. Same person,
 * same score, forever, until someone deliberately retunes a weight or a
 * constant on the taxonomy screen.
 *
 *     raw = Σ weight(matched term) + bonuses
 *     z   = (raw − mu) / sigma
 *
 * Worked examples against START_WEIGHT below, which are also asserted in
 * scripts/check-parsing.ts so a weight edit cannot silently move the scale:
 *
 *     Hack Club alone              raw 0.7   −0.8σ
 *     RSI + ISEF + USAMO           raw 4.5   +1.3σ
 *     IMO + IOI + RSI + 1 pub      raw 6.6   +2.4σ
 *
 * ── Why six clusters, and why polymath is not one ─────────────────────────
 * A cluster is a reference class: you judge an olympiad kid against olympiad
 * kids. Polymath is not a population, it is the union of overlaps, so a mean
 * polymath does not exist. It was also absorbing everything unclassifiable —
 * Jane Street, Coca-Cola Scholar, QuestBridge, TASP and SPARC were all
 * polymaths — which is how you could tell two clusters were missing.
 *
 * Polymath is now a badge: awarded for clearing POLYMATH_SIGMA in two or more
 * clusters. That keeps the multi-cluster fact visible without pretending it is
 * a population you can take a mean of.
 */

export type Archetype = "olympiad" | "research" | "builder" | "founder" | "quant" | "scholar";

export const ARCHETYPES: { id: Archetype; label: string; blurb: string }[] = [
  { id: "olympiad", label: "Olympiad", blurb: "Competition math, informatics, physics, bio" },
  { id: "research", label: "Research", blurb: "Published, lab-affiliated, or a selective research program" },
  { id: "builder", label: "Builder", blurb: "Ships things: repos, hardware, side projects" },
  { id: "founder", label: "Founder", blurb: "Started something with users or revenue" },
  { id: "quant", label: "Quant", blurb: "Trading and quantitative research pipelines" },
  { id: "scholar", label: "Scholar", blurb: "Selective scholarships and humanities programs" },
];

/**
 * Tie-break order for equal weights, so a person's label never flickers
 * between renders. Earlier wins.
 */
const CLUSTER_ORDER: Archetype[] = [
  "olympiad",
  "research",
  "founder",
  "quant",
  "builder",
  "scholar",
];

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
  // Olympiad
  IMO: "olympiad",
  IOI: "olympiad",
  USAMO: "olympiad",
  "USACO Platinum": "olympiad",
  USAPhO: "olympiad",
  USABO: "olympiad",
  Mathcamp: "olympiad",
  PROMYS: "olympiad",
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
  // Quant
  "Jane Street": "quant",
  // Scholar
  "Coca-Cola Scholar": "scholar",
  TASP: "scholar",
  SPARC: "scholar",
  QuestBridge: null,
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

/** Global calibration. See the worked examples in the header. */
export const CALIBRATION = { mu: 2.2, sigma: 1.8 };

/**
 * Per-cluster calibration, used only for the badge and the "in Olympiad"
 * figure on the detail screen. A single cluster's raw is smaller than the
 * whole-profile raw, so mu is lower. Each mu is roughly one typical
 * credential in that cluster.
 */
export const CLUSTER_CALIBRATION: Record<Archetype, { mu: number; sigma: number }> = {
  olympiad: { mu: 1.2, sigma: 1.2 },
  research: { mu: 1.2, sigma: 1.2 },
  builder: { mu: 0.7, sigma: 0.9 },
  founder: { mu: 1.0, sigma: 1.1 },
  quant: { mu: 0.9, sigma: 0.9 },
  scholar: { mu: 0.8, sigma: 0.8 },
};

/** Clear this in two or more clusters and you get the Polymath badge. */
export const POLYMATH_SIGMA = 0.5;

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

export function zFrom(raw: number, cal: { mu: number; sigma: number }): number {
  return round((raw - cal.mu) / cal.sigma);
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

/** Blue is reserved for genuine outliers so a column of these reads as a distribution. */
export function scoreBand(z: number): ScoreBand {
  if (z >= 2.5) return "exceptional";
  if (z >= 1.5) return "strong";
  if (z >= 0.5) return "above";
  if (z >= -0.5) return "mid";
  return "below";
}

export const SCORE_BANDS: { id: ScoreBand | "all"; label: string }[] = [
  { id: "all", label: "All" },
  { id: "exceptional", label: "≥ +2.5σ" },
  { id: "strong", label: "+1.5 – 2.5σ" },
  { id: "above", label: "+0.5 – 1.5σ" },
  { id: "mid", label: "±0.5σ" },
];

/** Always rendered with an explicit sign. "+2.4σ", "−0.3σ". */
export function formatSigma(z: number): string {
  const sign = z < 0 ? "−" : "+";
  return `${sign}${Math.abs(z).toFixed(1)}σ`;
}

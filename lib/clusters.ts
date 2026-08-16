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
  "Jane Street AMP": "quant",
  "Jane Street": "quant",
  IPhO: "quant",
  IChO: "quant",
  MOP: "quant",
  "Breakthrough Junior Challenge": "research",
  "ISEF Grand Award": "research",
  IBO: "research",
  // Builder
  "Hack Club": "builder",
  "Conrad Challenge": "builder",
  buildspace: "builder",
  TreeHacks: "builder",
  CalHacks: "builder",
  HackMIT: "builder",
  /**
   * Founder — and every accelerator votes here.
   *
   * Being backed is the definitive founder signal, and it is the vote that most
   * needs casting: without it someone whose whole record is "YC S26, ex-Palantir"
   * fell through to the text heuristic to get labelled at all.
   */
  "Thiel Fellow": "founder",
  "Neo Scholar": "founder",
  "Diamond Challenge": "founder",
  "Y Combinator": "founder",
  a16z: "founder",
  Sequoia: "founder",
  "Founders Fund": "founder",
  "Pear VC": "founder",
  "South Park Commons": "founder",
  "1517 Fund": "founder",
  Contrary: "founder",
  "Dorm Room Fund": "founder",
  "Entrepreneur First": "founder",
  Techstars: "founder",
  Antler: "founder",
  "Emergent Ventures": "founder",
  "Funded founder": "founder",
  // Operator
  "Coca-Cola Scholar": "operator",
  TASP: "operator",
  SPARC: "operator",
  QuestBridge: null,
  // Z Fellows is a fellowship you get for starting something, so it is a
  // programme that votes Founder rather than an award.
  "Z Fellow": "founder",
};

/**
 * Starting points for a human to tune, which is the point of the taxonomy screen.
 *
 * ── The scale ─────────────────────────────────────────────────────────────
 * Nothing exceeds 2.0, and the strongest person in a healthy roster lands near 10.
 * That keeps the σ glyph honest as an analogy even though the arithmetic is a plain
 * sum: a "+10σ" reads as remarkable and a "+3σ" as ordinary, which is what the
 * numbers should feel like.
 *
 * ── What earns 2.0 ────────────────────────────────────────────────────────
 * Two things, and they are different in kind:
 *
 *   1. **Somebody wrote a cheque.** Y Combinator, a Thiel Fellowship. A programme
 *      admitting you is an opinion; an investor funding you is a decision with
 *      money behind it, made by people whose job is exactly this judgement. For a
 *      tool that exists to find people worth backing, that is the strongest
 *      evidence available, and it used to score 0.5 as though YC were an employer.
 *   2. **The global ceiling of a competition.** An IMO or IOI medal is a few hundred
 *      people on earth per year.
 *
 * ── Why so much moved down ────────────────────────────────────────────────
 * Selectivity, roughly by cohort size, replaced vibes. ISEF sat at 1.4 above every
 * accelerator, and ISEF has ~1,800 finalists a year — a real achievement, and an
 * order of magnitude less selective than MOP's sixty. MOP sat *below* USAMO, which
 * is its own qualifying round. Both are fixed.
 *
 * ── Descriptions are not achievements ─────────────────────────────────────
 * Titles start at zero and majors at 0.1. "Intern" and "Software Engineer" were each
 * worth 0.2, so listing five ordinary roles paid the same as a Coca-Cola
 * Scholarship. Founding something is the exception, because it is a fact about what
 * you did rather than what you were called.
 */
export const START_WEIGHT: Record<string, number> = {
  /* ── Accelerators, fellowships, funds ─────────────────────────────────── */
  // The ceiling. Somebody wrote a cheque, which is the hardest filter there is.
  "Y Combinator": 2.0,
  "Thiel Fellow": 2.0,
  a16z: 2.0,
  "Z Fellow": 2.0,
  Sequoia: 2.0,
  "Founders Fund": 2.0,
  "Neo Scholar": 1.5,
  "Pear VC": 1.5,
  "South Park Commons": 1.5,
  "1517 Fund": 1.5,
  "Afore Capital": 1.5,
  "Battery Ventures": 1.5,
  Lightspeed: 1.5,
  "General Catalyst": 1.5,
  "Khosla Ventures": 1.5,
  "Index Ventures": 1.5,
  Accel: 1.5,
  Greylock: 1.5,
  Benchmark: 1.5,
  Bessemer: 1.4,
  "645 Ventures": 1.2,
  "Emergent Ventures": 1.2,
  Contrary: 1.2,
  "Entrepreneur First": 1.2,
  // A student-run fund is real but junior to the firms above it.
  "Dorm Room Fund": 1.0,
  Techstars: 0.7,
  Antler: 0.7,
  // Open enrolment, tens of thousands of people.
  buildspace: 0.2,

  /* ── Competitions and programmes ──────────────────────────────────────── */
  // International olympiad: a few hundred people on earth per year.
  IMO: 2.0,
  IOI: 2.0,
  IPhO: 2.0,
  IBO: 2.0,
  IChO: 2.0,
  MOP: 1.6,
  RSI: 1.6,
  "Palantir Meritocracy Fellow": 1.5,
  "ISEF Grand Award": 1.4,
  "MIT PRIMES": 1.4,
  "Davidson Fellow": 1.3,
  "Berkeley M.E.T.": 1.3,
  "Penn M&T": 1.3,
  Rise: 1.2,
  "Coolidge Scholar": 1.2,
  USAMO: 1.2,
  "Jane Street AMP": 1.2,
  STS: 1.2,
  "Huntsman Program": 1.1,
  "Vagelos Program": 1.1,
  "USACO Platinum": 1.0,
  PROMYS: 1.0,
  SSP: 0.9,
  Mathcamp: 0.9,
  TASP: 0.9,
  SPARC: 0.9,
  "Simons Fellow": 0.9,
  "Coca-Cola Scholar": 0.8,
  "Garcia Program": 0.8,
  ISEF: 0.7,
  "Presidential Scholar": 0.5,
  USAPhO: 0.5,
  USABO: 0.5,
  QuestBridge: 0.5,
  // Activities. A good builder does one on a weekend.
  "Hack Club": 0.4,
  TreeHacks: 0.3,
  CalHacks: 0.3,
  HackMIT: 0.3,
  "Breakthrough Junior Challenge": 0.3,
  "Conrad Challenge": 0.3,
  "Diamond Challenge": 0.3,
  "Bank of America Student Leader": 0.3,
  // A two-week summer course, and it was scoring as a Yale degree.
  "Yale Young Global Scholars": 0.2,

  /**
   * ── Employers ────────────────────────────────────────────────────────────
   *
   * A name anyone in the industry would recognise is 1.4 — a long way above where
   * these started, and deliberately close to the competition tier. Getting hired by
   * one of these at nineteen is a harder filter than most awards.
   */
  Google: 1.4,
  Meta: 1.4,
  Apple: 1.4,
  Microsoft: 1.4,
  Amazon: 1.4,
  Nvidia: 1.4,
  OpenAI: 1.4,
  Anthropic: 1.4,
  DeepMind: 1.4,
  Palantir: 1.4,
  Stripe: 1.4,
  SpaceX: 1.4,
  Tesla: 1.4,
  IBM: 1.4,
  Bloomberg: 1.4,
  "Jane Street": 1.4,
  Citadel: 1.4,
  "Citadel Securities": 1.4,
  "Hudson River Trading": 1.4,
  "Two Sigma": 1.4,
  "Jump Trading": 1.4,
  "D. E. Shaw": 1.4,
  Susquehanna: 1.4,
  "McKinsey & Company": 1.4,
  "Bain & Company": 1.4,
  "Boston Consulting Group": 1.4,
  "Goldman Sachs": 1.4,
  NASA: 1.4,
  Databricks: 1.2,
  Snowflake: 1.2,
  // Real, and a rung below the names above.
  Tencent: 0.7,
  Intel: 0.7,
  Waymo: 0.7,
  Regeneron: 0.7,
  "Bell Labs": 0.7,

  /* ── Universities ─────────────────────────────────────────────────────── */
  MIT: 0.8,
  Stanford: 0.8,
  Caltech: 0.8,
  Harvard: 0.8,
  Princeton: 0.6,
  Berkeley: 0.6,
  "Carnegie Mellon": 0.6,
  Yale: 0.6,
  Columbia: 0.6,
  Oxford: 0.6,
  Cambridge: 0.6,
  UChicago: 0.6,
  UPenn: 0.6,
  Cornell: 0.4,

  /* ── High schools ─────────────────────────────────────────────────────── */
  // A feeder is worth a little; where someone went to school is mostly not the point.
  TJHSST: 0.4,
  "Phillips Exeter": 0.4,
  "Phillips Andover": 0.4,
  Stuyvesant: 0.4,
  IMSA: 0.4,
  NCSSM: 0.4,
  Harker: 0.4,

  /* ── Whole-profile facts ──────────────────────────────────────────────── */
  // The single most predictive flag here: they founded it and someone funded it.
  "Funded founder": 1.2,
  "Competition winner": 0.4,
  Influencer: 0.3,
  "Has a site": 0.1,
  Published: 0,
  "Patent holder": 0,

  /* ── Titles ───────────────────────────────────────────────────────────── */
  Founder: 0.2,
  CTO: 0.2,
  CEO: 0.1,
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

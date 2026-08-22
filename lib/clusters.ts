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
  /**
   * ─── Votes that were missing ─────────────────────────────────────────────
   *
   * Thirty-three tags at weight 0.5 or more scored without voting for any cluster,
   * so they moved a person up the ranking without saying what kind of person they
   * are. Twelve were accelerators, which the note below says all vote founder.
   *
   * A null vote is still a legitimate answer and some of these keep it: National
   * YoungArts is an arts award and there is no arts cluster, QuestBridge is a
   * college-match scholarship and says nothing about a discipline. Guessing at those
   * would be worse than abstaining.
   */
  "Afore Capital": "founder",
  "Battery Ventures": "founder",
  "645 Ventures": "founder",
  Lightspeed: "founder",
  "General Catalyst": "founder",
  "Khosla Ventures": "founder",
  "Index Ventures": "founder",
  Accel: "founder",
  Greylock: "founder",
  Benchmark: "founder",
  Bessemer: "founder",
  "Pareto Fellowship": "founder",
  // Dual degrees in engineering and business; Huntsman is international studies and
  // Vagelos is life sciences, so the two of them land elsewhere.
  "Berkeley M.E.T.": "founder",
  "Penn M&T": "founder",
  "Huntsman Program": "operator",
  "Vagelos Program": "research",
  "Palantir Meritocracy Fellow": "builder",
  // Research awards.
  "NeurIPS High School Track": "research",
  "S.T. Yau Science Award": "research",
  "Davidson Fellow": "research",
  USESO: "research",
  // Competition maths and computational linguistics.
  "Math Prize for Girls": "quant",
  NACLO: "quant",
  "National Economics Challenge": "quant",
  // Civic, service and leadership.
  USSYP: "operator",
  "Gloria Barron Prize": "operator",
  "Jack Kent Cooke Scholar": "operator",
  "Cameron Impact Scholar": "operator",
  "Presidential Scholar": "operator",
  Rise: "operator",
  "Coolidge Scholar": "operator",

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
 * Titles start at zero and majors at 0.03. "Intern" and "Software Engineer" were
 * each worth 0.2 on the old scale, so listing five ordinary roles paid the same as a
 * Coca-Cola Scholarship. Founding something is the exception, because it is a fact
 * about what you did rather than what you were called.
 *
 * ── The numbers below are a third of what they were ───────────────────────
 * Every figure in this table was divided by three in seed version 5, and nothing
 * else about it changed: no ratio moved, so no ranking moved, only the unit. The
 * heaviest tag is 0.67 and the strongest person in a real roster lands near 6, where
 * before the vocabulary grew they landed near 10 and had drifted to 17. Weights are
 * held to two decimals for the same reason — at a tenth this table would collapse
 * onto ten distinct values and the count rules would round to nothing.
 *
 * Historical numbers quoted above are left as they were written. They describe what
 * something *used* to be worth, and rewriting them would make the reasoning harder
 * to follow rather than easier.
 */
export const START_WEIGHT: Record<string, number> = {
  /* ── Accelerators, fellowships, funds ─────────────────────────────────── */
  // The ceiling. Somebody wrote a cheque, which is the hardest filter there is.
  "Y Combinator": 0.67,
  "Thiel Fellow": 0.67,
  a16z: 0.67,
  "Z Fellow": 0.67,
  Sequoia: 0.67,
  "Founders Fund": 0.67,
  "Neo Scholar": 0.5,
  "Pear VC": 0.5,
  "South Park Commons": 0.5,
  "1517 Fund": 0.5,
  "Afore Capital": 0.5,
  "Battery Ventures": 0.5,
  Lightspeed: 0.5,
  "General Catalyst": 0.5,
  "Khosla Ventures": 0.5,
  "Index Ventures": 0.5,
  Accel: 0.5,
  Greylock: 0.5,
  Benchmark: 0.5,
  Bessemer: 0.47,
  "645 Ventures": 0.4,
  "Emergent Ventures": 0.4,
  Contrary: 0.4,
  "Entrepreneur First": 0.4,
  // A student-run fund is real but junior to the firms above it.
  "Dorm Room Fund": 0.33,
  Techstars: 0.23,
  Antler: 0.23,
  // Open enrolment, tens of thousands of people.
  buildspace: 0.07,

  /* ── Competitions and programmes ──────────────────────────────────────── */
  // International olympiad: a few hundred people on earth per year.
  IMO: 0.67,
  IOI: 0.67,
  IPhO: 0.67,
  IBO: 0.67,
  IChO: 0.67,
  MOP: 0.53,
  RSI: 0.53,
  "Palantir Meritocracy Fellow": 0.5,
  /**
   * Priced by how many people a year hold the thing, which is the only comparison
   * that makes a taxonomy readable. USSYP takes two per state; the Barron Prize
   * twenty-five nationally; Math Prize for Girls is the top of a field of a few
   * hundred. NCWIT and Elks are broad at their base and only mean something at the
   * top, so both carry a ladder rather than a low flat number.
   */
  USSYP: 0.37,
  "Gloria Barron Prize": 0.37,
  "NeurIPS High School Track": 0.4,
  "Jack Kent Cooke Scholar": 0.33,
  "Cameron Impact Scholar": 0.3,
  "S.T. Yau Science Award": 0.33,
  "Math Prize for Girls": 0.27,
  "National YoungArts": 0.27,
  NACLO: 0.2,
  USESO: 0.17,
  "National Economics Challenge": 0.17,
  "NCWIT Aspirations": 0.1,
  "Elks Most Valuable Student": 0.1,
  "Cum Laude Society": 0.07,
  "Pareto Fellowship": 0.4,
  "ISEF Grand Award": 0.47,
  "MIT PRIMES": 0.47,
  "Davidson Fellow": 0.43,
  "Berkeley M.E.T.": 0.43,
  "Penn M&T": 0.43,
  Rise: 0.4,
  "Coolidge Scholar": 0.4,
  USAMO: 0.4,
  "Jane Street AMP": 0.4,
  STS: 0.4,
  "Huntsman Program": 0.37,
  "Vagelos Program": 0.37,
  "USACO Platinum": 0.33,
  PROMYS: 0.33,
  SSP: 0.3,
  Mathcamp: 0.3,
  TASP: 0.3,
  SPARC: 0.3,
  "Simons Fellow": 0.3,
  "Coca-Cola Scholar": 0.27,
  "Garcia Program": 0.27,
  ISEF: 0.23,
  "Presidential Scholar": 0.17,
  USAPhO: 0.17,
  USABO: 0.17,
  QuestBridge: 0.17,
  // Activities. A good builder does one on a weekend.
  "Hack Club": 0.13,
  TreeHacks: 0.1,
  CalHacks: 0.1,
  HackMIT: 0.1,
  "Breakthrough Junior Challenge": 0.1,
  "Conrad Challenge": 0.1,
  "Diamond Challenge": 0.1,
  "Bank of America Student Leader": 0.1,
  // A two-week summer course, and it was scoring as a Yale degree.

  /**
   * ── Employers ────────────────────────────────────────────────────────────
   *
   * A name anyone in the industry would recognise is 1.4 — a long way above where
   * these started, and deliberately close to the competition tier. Getting hired by
   * one of these at nineteen is a harder filter than most awards.
   */
  Google: 0.47,
  Meta: 0.47,
  Apple: 0.47,
  Microsoft: 0.47,
  Amazon: 0.47,
  Nvidia: 0.47,
  OpenAI: 0.47,
  Anthropic: 0.47,
  DeepMind: 0.47,
  Palantir: 0.47,
  Stripe: 0.47,
  SpaceX: 0.47,
  Tesla: 0.47,
  IBM: 0.47,
  Bloomberg: 0.47,
  "Jane Street": 0.47,
  Citadel: 0.47,
  "Citadel Securities": 0.47,
  "Hudson River Trading": 0.47,
  "Two Sigma": 0.47,
  "Jump Trading": 0.47,
  "D. E. Shaw": 0.47,
  Susquehanna: 0.47,
  "McKinsey & Company": 0.47,
  "Bain & Company": 0.47,
  "Boston Consulting Group": 0.47,
  "Goldman Sachs": 0.47,
  NASA: 0.47,
  Databricks: 0.4,
  Snowflake: 0.4,
  // Real, and a rung below the names above.
  Tencent: 0.23,
  Intel: 0.23,
  Waymo: 0.23,
  Regeneron: 0.23,
  "Bell Labs": 0.23,

  /* ── Universities ─────────────────────────────────────────────────────── */
  MIT: 0.27,
  Stanford: 0.27,
  Caltech: 0.27,
  Harvard: 0.27,
  Princeton: 0.2,
  Berkeley: 0.2,
  "Carnegie Mellon": 0.2,
  Yale: 0.2,
  Columbia: 0.2,
  Oxford: 0.2,
  Cambridge: 0.2,
  UChicago: 0.2,
  UPenn: 0.2,
  Cornell: 0.13,

  /* ── High schools ─────────────────────────────────────────────────────── */
  // A feeder is worth a little; where someone went to school is mostly not the point.
  TJHSST: 0.13,
  "Phillips Exeter": 0.13,
  "Phillips Andover": 0.13,
  Stuyvesant: 0.13,
  IMSA: 0.13,
  NCSSM: 0.13,
  Harker: 0.13,

  /* ── Whole-profile facts ──────────────────────────────────────────────── */
  // The single most predictive flag here: they founded it and someone funded it.
  "Funded founder": 0.4,
  "Hackathon winner": 0.13,
  /**
   * A camp invitation is roughly the top twenty in the country, where a semifinal is
   * the top few hundred. Stacked on USABO at 0.5 that puts a camper at 1.5, between
   * USAMO and MOP, and leaves the semifinalist where they were.
   */
  "Olympiad camper": 0.33,
  Influencer: 0.1,
  "Has a site": 0.03,
  Published: 0,
  "Patent holder": 0,

  /* ── Titles ───────────────────────────────────────────────────────────── */
  Founder: 0.07,
  CTO: 0.07,
  CEO: 0.03,
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
export function formatSigma(score: number, dp: 1 | 2 = 1): string {
  const sign = score < 0 ? "−" : "+";
  return `${sign}${Math.abs(score).toFixed(dp)}σ`;
}

import type { Archetype } from "./clusters";
import {
  ARCHETYPES,
  CALIBRATION,
  CLUSTER_CALIBRATION,
  FOUNDER_WORDS,
  POLYMATH_SIGMA,
  assignCluster,
  clusterFromText,
  round,
  zFrom,
} from "./clusters";
import type { Person } from "./people";
import { textOf } from "./people";
import type { TaxonomyPrefs } from "./state";
import { matchedTerms, type MatchedTerm } from "./tags";
import type { Candidate, DiscoveryHop, Signal } from "./zscore";

/**
 * Turns a record into the scored shape the screens read.
 *
 * ── Scoring is per person ─────────────────────────────────────────────────
 * Because the calibration is fixed (see lib/clusters.ts), this needs no
 * population. That is the point: it used to standardise over whoever happened
 * to be enriched, so scores drifted as the pool grew, a lone candidate always
 * came out at exactly 0, and two teammates saw different numbers for the same
 * person. Now `toCandidates` is a plain map and a single person scores properly.
 */

/** Publications and patents are strong and taxonomy-independent. */
const PUB_WEIGHT = 0.8;
const PATENT_WEIGHT = 1.0;
/** Shipping things is evidence even with no program attached to it. */
const PROJECT_WEIGHT = 0.4;
/** "Founder" in a headline is real signal, held low because it is cheap to write. */
const FOUNDER_TEXT_WEIGHT = 0.5;

function bonuses(p: Person): MatchedTerm[] {
  const out: MatchedTerm[] = [];
  const e = p.enriched;

  if (e) {
    if (e.publications.length > 0) {
      const n = Math.min(e.publications.length, 3);
      out.push({
        label: `${e.publications.length} publication${e.publications.length === 1 ? "" : "s"}`,
        weight: round(PUB_WEIGHT * n),
        cluster: "research",
        source: "projects",
      });
    }
    if (e.patents.length > 0) {
      const n = Math.min(e.patents.length, 2);
      out.push({
        label: `${e.patents.length} patent${e.patents.length === 1 ? "" : "s"}`,
        weight: round(PATENT_WEIGHT * n),
        cluster: "research",
        source: "projects",
      });
    }
    if (e.projects.length > 0) {
      const n = Math.min(e.projects.length, 3);
      out.push({
        label: `${e.projects.length} project${e.projects.length === 1 ? "" : "s"}`,
        weight: round(PROJECT_WEIGHT * n),
        cluster: "builder",
        source: "projects",
      });
    }
  }

  if (FOUNDER_WORDS.test(p.headline)) {
    out.push({
      label: "Founder in headline",
      weight: FOUNDER_TEXT_WEIGHT,
      cluster: "founder",
      source: p.enriched ? "experience" : "snippet",
    });
  }

  return out;
}

function discoveryOf(p: Person): DiscoveryHop[] {
  const via = p.discoveredVia;
  if (via.kind === "serp") {
    return [{ kind: "keyword_sweep", label: via.query || "Keyword sweep" }];
  }
  if (via.kind === "seed") {
    return [{ kind: "seed", label: p.name, slug: p.slug }];
  }
  return [
    { kind: "seed", label: via.seedName, slug: via.seedSlug },
    { kind: "people_also_viewed", label: "People also viewed" },
  ];
}

/** Score one person. No population required. */
export function scoreOne(p: Person, tax: TaxonomyPrefs): Candidate {
  const terms = [...matchedTerms(p, tax), ...bonuses(p)];

  const raw = terms.reduce((sum, t) => sum + t.weight, 0);
  const z = zFrom(raw, CALIBRATION);

  // Per-cluster raw, then per-cluster z against that cluster's own constants.
  const clusterRaw = new Map<Archetype, number>();
  for (const t of terms) {
    if (!t.cluster) continue;
    clusterRaw.set(t.cluster, (clusterRaw.get(t.cluster) ?? 0) + t.weight);
  }

  const cluster_scores: Partial<Record<Archetype, number>> = {};
  for (const [c, cr] of clusterRaw) {
    cluster_scores[c] = zFrom(cr, CLUSTER_CALIBRATION[c]);
  }

  // Primary: highest-weighted matched term wins. Manual override beats it, and
  // a text heuristic catches people with no taxonomy term at all — which is
  // most of the population this tool exists to find.
  const computed =
    assignCluster(terms) ??
    clusterFromText(textOf(p), (p.enriched?.projects.length ?? 0) > 0) ??
    "builder";
  const archetype = p.clusterOverride ?? computed;

  const cleared = ARCHETYPES.map((a) => a.id).filter(
    (c) => (cluster_scores[c] ?? -Infinity) >= POLYMATH_SIGMA
  );
  const polymath = cleared.length >= 2;

  const signals: Signal[] = terms.map((t, i) => ({
    id: `${p.slug}-${t.label}-${i}`,
    label: t.label,
    source: t.source,
    cluster: t.cluster,
    // A term's contribution expressed on the same sigma scale as the score.
    deviation: round(t.weight / CALIBRATION.sigma),
  }));

  const year = p.gradYear ? String(p.gradYear) : p.inferredYear;

  return {
    slug: p.slug,
    name: p.name,
    headline: p.headline,
    url: p.url,
    location: p.location || undefined,
    state: p.state,
    school: p.school,
    graduation_year: year,
    archetype,
    polymath,
    secondary_archetypes: cleared.filter((c) => c !== archetype),
    z_score_archetype: cluster_scores[archetype] ?? z,
    z_score_normalized: z,
    cluster_scores,
    signals,
    discovery: discoveryOf(p),
    enriched: Boolean(p.enriched),
    surfaced_at: p.addedAt,
  };
}

export function toCandidates(people: Person[], tax: TaxonomyPrefs): Candidate[] {
  return people.map((p) => scoreOne(p, tax));
}

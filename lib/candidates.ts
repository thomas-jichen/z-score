import type { Archetype } from "./clusters";
import {
  ARCHETYPES,
  FOUNDER_WORDS,
  assignCluster,
  clusterFromText,
  round,
} from "./clusters";
import { COUNT_KINDS, extractTags, type CountKind } from "./extract";
import type { Person } from "./people";
import { textOf } from "./people";
import type { TaxonomyPrefs } from "./state";
import { indexRegistry, resolveAny } from "./tagRegistry";
import { matchedTerms, type MatchedTerm } from "./tags";
import type { Candidate, DiscoveryHop, Signal } from "./zscore";

/**
 * Turns a record into the scored shape the screens read.
 *
 * ── Scoring is per person ─────────────────────────────────────────────────
 * `toCandidates` is a plain map: no reduce over the pool, no mean, no variance.
 * The same person scores the same whether they are alone or one of a thousand,
 * and two teammates always see one number. That was the one property worth
 * keeping from the standardised model, and addition gives it for free.
 */

/**
 * Countable things, priced from the taxonomy.
 *
 * These used to be hardcoded here — publications at 0.8 × min(n,3), patents at
 * 1.0 × min(n,2), projects at 0.4 × min(n,3) — as invisible pseudo-terms that
 * never appeared as tags and could not be tuned. Same arithmetic, but the points
 * and the cap now come from `taxonomy.counts`, and each one shows up in the
 * breakdown as a row you can trace.
 *
 * A cap per kind is what stops volume beating quality: nine roles is a signal,
 * nineteen is a padded profile.
 */
const COUNT_CLUSTER: Record<CountKind, Archetype | null> = {
  publication: "research",
  patent: "research",
  project: "builder",
  experience: null,
  honor: null,
};

const COUNT_NOUN: Record<CountKind, string> = {
  publication: "publication",
  patent: "patent",
  project: "project",
  experience: "experience",
  honor: "honor",
};

function countTerms(counts: Record<CountKind, number>, tax: TaxonomyPrefs): MatchedTerm[] {
  const out: MatchedTerm[] = [];
  for (const kind of COUNT_KINDS) {
    const n = counts[kind];
    const rule = tax.counts[kind];
    if (!n || !rule || rule.points <= 0) continue;
    const counted = Math.min(n, rule.cap);
    const noun = COUNT_NOUN[kind];
    out.push({
      // Says what was counted and what was capped away, so a total is legible.
      label:
        n > counted
          ? `${n} ${noun}${n === 1 ? "" : "s"}, ${counted} counted`
          : `${n} ${noun}${n === 1 ? "" : "s"}`,
      weight: round(rule.points * counted),
      cluster: COUNT_CLUSTER[kind],
      source: "projects",
    });
  }
  return out;
}

/** "Founder" in a headline is real signal, held low because it is cheap to write. */
const FOUNDER_TEXT_WEIGHT = 0.5;

function bonuses(p: Person): MatchedTerm[] {
  if (!FOUNDER_WORDS.test(p.headline)) return [];
  return [
    {
      label: "Founder in headline",
      weight: FOUNDER_TEXT_WEIGHT,
      cluster: "founder",
      source: p.enriched ? "experience" : "snippet",
    },
  ];
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

/** Score one person. Addition, and no population required. */
export function scoreOne(p: Person, tax: TaxonomyPrefs): Candidate {
  const { counts } = extractTags(p);
  const terms = [...matchedTerms(p, tax), ...countTerms(counts, tax), ...bonuses(p)];

  const score = round(terms.reduce((sum, t) => sum + t.weight, 0));

  // Points per cluster: the same sum, restricted to the terms that vote for it.
  // A term with no cluster still counts toward the total, it just casts no vote.
  const cluster_scores: Partial<Record<Archetype, number>> = {};
  for (const t of terms) {
    if (!t.cluster) continue;
    cluster_scores[t.cluster] = round((cluster_scores[t.cluster] ?? 0) + t.weight);
  }

  // Primary: highest-weighted matched term wins. Manual override beats it, and
  // a text heuristic catches people with no taxonomy term at all — which is
  // most of the population this tool exists to find.
  const computed =
    assignCluster(terms) ??
    clusterFromText(textOf(p), (p.enriched?.projects.length ?? 0) > 0) ??
    "builder";
  const archetype = p.clusterOverride ?? computed;

  // Was "clears +0.5σ in two clusters". Now a point threshold, from the taxonomy,
  // because there is no sigma left to clear.
  const cleared = ARCHETYPES.map((a) => a.id).filter(
    (c) => (cluster_scores[c] ?? 0) >= tax.polymathPoints
  );
  const polymath = cleared.length >= 2;

  const signals: Signal[] = terms.map((t, i) => ({
    id: `${p.slug}-${t.label}-${i}`,
    label: t.label,
    source: t.source,
    cluster: t.cluster,
    // The weight itself. It used to be divided by sigma to sit on the same scale
    // as the score; the score is now the plain sum, so they already match and the
    // breakdown adds up to the total exactly.
    points: round(t.weight),
  }));

  const year = p.gradYear ? String(p.gradYear) : p.inferredYear;

  /**
   * The school, under the one name the app uses for it.
   *
   * The vendor writes whatever the profile owner typed — "Stanford University" on
   * one record, "Stanford" on the next — and the registry already knows those are
   * one school. Resolving the label means the queue row, the graph panel and the
   * tag all say the same word, instead of the screen naming the same place twice.
   */
  const school = p.school
    ? (resolveAny(indexRegistry(tax.tags), p.school)?.label ?? p.school)
    : undefined;

  return {
    slug: p.slug,
    name: p.name,
    headline: p.headline,
    url: p.url,
    location: p.location || undefined,
    state: p.state,
    school,
    graduation_year: year,
    archetype,
    polymath,
    secondary_archetypes: cleared.filter((c) => c !== archetype),
    archetype_score: cluster_scores[archetype] ?? 0,
    score,
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

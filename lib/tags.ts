import type { Archetype } from "./clusters";
import { clusterOf, weightOf } from "./clusters";
import type { Person } from "./people";
import type { TaxonomyPrefs } from "./state";
import type { Selection } from "./query";
import type { Signal } from "./zscore";
import { PROGRAMS } from "./searchTaxonomy";

/**
 * Everything that turns a record into labels.
 *
 * Three sources, and they are deliberately not equal:
 *
 *   query      the chips that built the search. A hypothesis, see below
 *   text       taxonomy terms found in the record's own words. Deterministic
 *   extracted  what the LLM read off the profile. Zero weight until promoted
 *
 * Plus attributes — school, class year, state — which are facts about a person
 * rather than credentials, and are used to group the graph rather than to score.
 */

export type TagKind = "program" | "school" | "year" | "state" | "extracted";

export type Tag = {
  label: string;
  kind: TagKind;
  origin: "query" | "text" | "llm" | "attribute";
  /** False means "the query implies this but the text does not show it". */
  confirmed: boolean;
  cluster?: Archetype | null;
};

/** Whole-term match, so "IMO" does not fire on "important" or "Simons". */
export function mentions(text: string, term: string): boolean {
  if (!text || !term) return false;
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(text);
}

/**
 * The chips that produced a hit, each marked with whether the hit's own text
 * backs it up.
 *
 * A query like `(RSI OR IMO) (MIT OR Stanford)` never reports which branch
 * matched, so attaching every selected chip to every hit would invent facts —
 * and those facts would then score. Cross-checking against the title and
 * snippet is free and turns the guess into evidence. Unconfirmed labels are
 * still kept: they record why this person was looked at, which is worth seeing
 * on the sweep screen even when it cannot be substantiated.
 */
export function buildSearchLabels(
  text: string,
  selection: Selection
): { label: string; confirmed: boolean }[] {
  const labels = [
    ...selection.programs,
    ...selection.colleges,
    ...selection.highSchools,
    ...selection.years,
    ...selection.titles,
  ];
  const seen = new Set<string>();
  const out: { label: string; confirmed: boolean }[] = [];
  for (const label of labels) {
    const key = label.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ label, confirmed: mentions(text, label) });
  }
  return out;
}

export type MatchedTerm = {
  label: string;
  weight: number;
  cluster: Archetype | null;
  source: Signal["source"];
};

/** The record's own words, split by section so a breakdown can cite one. */
function fieldedText(p: Person): { text: string; source: Signal["source"] }[] {
  const e = p.enriched;
  if (!e) {
    return [{ text: [p.headline, p.snippet].filter(Boolean).join(" "), source: "snippet" }];
  }

  return [
    ...e.honors.map((h) => ({
      text: [h.title, h.issuedBy, h.description, h.associatedWith].filter(Boolean).join(" "),
      source: "honors" as const,
    })),
    ...e.projects.map((x) => ({
      text: [x.title, x.description].filter(Boolean).join(" "),
      source: "projects" as const,
    })),
    ...e.volunteering.map((v) => ({
      text: [v.role, v.organization].filter(Boolean).join(" "),
      source: "volunteering" as const,
    })),
    ...e.educations.map((x) => ({
      text: [x.school, x.degree, x.field].filter(Boolean).join(" "),
      source: "education" as const,
    })),
    // Experience descriptions are long-form and were previously not searched at
    // all, which discarded the richest text on a populated profile.
    ...e.experience.map((x) => ({
      text: [x.title, x.company, x.description].filter(Boolean).join(" "),
      source: "experience" as const,
    })),
    {
      text: [e.headline, e.about, ...e.publications, ...e.patents, ...e.certifications]
        .filter(Boolean)
        .join(" "),
      source: "experience" as const,
    },
    { text: p.snippet ?? "", source: "snippet" as const },
  ];
}

/** The taxonomy vocabulary in force: built-ins plus anything promoted. */
export function vocabulary(tax: TaxonomyPrefs): string[] {
  return [...new Set([...PROGRAMS, ...tax.promoted])];
}

/**
 * Which taxonomy terms this record evidences, and where each was found.
 *
 * Search-only and enriched records run through the same matcher with no
 * discount — a search-only person simply has less text, so they match fewer
 * terms and score lower. That is a consequence of the evidence, not a penalty
 * applied on top of it.
 */
export function matchedTerms(p: Person, tax: TaxonomyPrefs): MatchedTerm[] {
  const fields = fieldedText(p);
  const out: MatchedTerm[] = [];
  const seen = new Set<string>();

  for (const term of vocabulary(tax)) {
    const hit = fields.find((f) => mentions(f.text, term));
    if (!hit || seen.has(term)) continue;
    seen.add(term);
    out.push({
      label: term,
      weight: weightOf(term, tax.weights),
      cluster: clusterOf(term, tax.clusters),
      source: hit.source,
    });
  }

  // A confirmed chip that the record's own sections did not surface still
  // counts: the SERP title is text about this person. Unconfirmed chips never
  // count, because nothing substantiates them.
  for (const l of p.searchLabels) {
    if (!l.confirmed || seen.has(l.label)) continue;
    if (!vocabulary(tax).includes(l.label)) continue;
    seen.add(l.label);
    out.push({
      label: l.label,
      weight: weightOf(l.label, tax.weights),
      cluster: clusterOf(l.label, tax.clusters),
      source: "snippet",
    });
  }

  /**
   * Extracted and hand-added terms, once they are in the vocabulary.
   *
   * This case is easy to miss and it breaks the whole taxonomy loop without it.
   * The tagger returns *normalised* names — "Regeneron Science Talent Search"
   * comes back as "STS" — so a promoted term frequently does not appear verbatim
   * anywhere in the profile text. Matching on text alone would mean you promote a
   * term, watch nothing happen, and have no way to tell why.
   *
   * So a term the tagger attributed to this person counts as evidence for that
   * person, but only once someone has promoted it and given it a weight. Before
   * promotion it stays at zero, which is what keeps the model auditable.
   */
  const attributed = [...(p.extractedTerms ?? []), ...(p.manualTerms ?? [])];
  if (attributed.length > 0) {
    const vocab = new Map(vocabulary(tax).map((t) => [t.toLowerCase(), t]));
    for (const raw of attributed) {
      const canonical = vocab.get(raw.trim().toLowerCase());
      if (!canonical || seen.has(canonical)) continue;
      seen.add(canonical);
      out.push({
        label: canonical,
        weight: weightOf(canonical, tax.weights),
        cluster: clusterOf(canonical, tax.clusters),
        source: "extracted",
      });
    }
  }

  return out.sort((a, b) => b.weight - a.weight);
}

/** Facts about a person rather than credentials. Used to group, not to score. */
export function attributeTags(p: Person): Tag[] {
  const out: Tag[] = [];
  const year = p.gradYear ? String(p.gradYear) : p.inferredYear;
  if (p.school) out.push({ label: p.school, kind: "school", origin: "attribute", confirmed: true });
  if (year) out.push({ label: `Class of ${year}`, kind: "year", origin: "attribute", confirmed: true });
  if (p.state) out.push({ label: p.state, kind: "state", origin: "attribute", confirmed: true });
  return out;
}

/**
 * Every label on a person, for the graph and the detail screen. Terms in the
 * taxonomy come first, then attributes, then extracted terms not yet promoted.
 */
export function allTags(p: Person, tax: TaxonomyPrefs): Tag[] {
  const terms = matchedTerms(p, tax);
  const out: Tag[] = terms.map((t) => ({
    label: t.label,
    kind: "program",
    origin: t.source === "snippet" ? "query" : "text",
    confirmed: true,
    cluster: t.cluster,
  }));

  const have = new Set(out.map((t) => t.label.toLowerCase()));

  for (const t of attributeTags(p)) {
    if (have.has(t.label.toLowerCase())) continue;
    have.add(t.label.toLowerCase());
    out.push(t);
  }

  for (const label of p.manualTerms ?? []) {
    if (have.has(label.toLowerCase())) continue;
    have.add(label.toLowerCase());
    out.push({ label, kind: "extracted", origin: "attribute", confirmed: true });
  }

  for (const label of p.extractedTerms ?? []) {
    if (have.has(label.toLowerCase()) || tax.dismissed.includes(label)) continue;
    have.add(label.toLowerCase());
    out.push({ label, kind: "extracted", origin: "llm", confirmed: true });
  }

  // Unconfirmed chips, last and marked, so the sweep screen can show why this
  // person was looked at without implying the claim is established.
  for (const l of p.searchLabels) {
    if (l.confirmed || have.has(l.label.toLowerCase())) continue;
    have.add(l.label.toLowerCase());
    out.push({ label: l.label, kind: "program", origin: "query", confirmed: false });
  }

  return out;
}

/**
 * How many people match each taxonomy term, tallied in one pass.
 *
 * Per-term counting would re-run the whole vocabulary against every person for
 * every term — quadratic in the vocabulary and visibly slow on a full roster.
 * This walks each person once instead.
 */
export function termCounts(people: Person[], tax: TaxonomyPrefs): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of people) {
    for (const t of matchedTerms(p, tax)) {
      out[t.label] = (out[t.label] ?? 0) + 1;
    }
  }
  return out;
}

/**
 * Extracted terms across the roster that are not in the taxonomy yet, ranked by
 * how many people carry them. This is what the taxonomy review queue shows.
 *
 * Derived rather than stored: a stored counter drifts away from the people it
 * describes as soon as anyone is removed or re-tagged.
 */
export function unmatchedTerms(
  people: Person[],
  tax: TaxonomyPrefs
): { term: string; count: number; slugs: string[] }[] {
  const known = new Set(vocabulary(tax).map((t) => t.toLowerCase()));
  const dismissed = new Set(tax.dismissed.map((t) => t.toLowerCase()));
  const tally = new Map<string, { term: string; slugs: string[] }>();

  for (const p of people) {
    // Hand-added terms are reviewable exactly like extracted ones — someone
    // typing "Davidson Fellow" on a row is the same finding as the model
    // reading it, and both should reach the promote queue.
    for (const raw of [...(p.extractedTerms ?? []), ...(p.manualTerms ?? [])]) {
      const term = raw.trim();
      if (!term) continue;
      const key = term.toLowerCase();
      if (known.has(key) || dismissed.has(key)) continue;
      const entry = tally.get(key) ?? { term, slugs: [] };
      if (!entry.slugs.includes(p.slug)) entry.slugs.push(p.slug);
      tally.set(key, entry);
    }
  }

  return [...tally.values()]
    .map((e) => ({ term: e.term, count: e.slugs.length, slugs: e.slugs }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

import type { Archetype } from "./clusters";
import { clusterOf, weightOf } from "./clusters";
import { extractTags } from "./extract";
import type { Person } from "./people";
import type { TaxonomyPrefs } from "./state";
import type { Selection } from "./query";
import {
  indexRegistry,
  normalizeKey,
  resolveAny,
  resolveTag,
  type TagDef,
  type TagFacet,
} from "./tagRegistry";
import type { Signal } from "./zscore";

/**
 * Everything that turns a record into labels.
 *
 * Four sources, and they are deliberately not equal:
 *
 *   structured a company, school, major, title or count read straight off the
 *              vendor's own fields. Exact, free, and the bulk of a profile
 *   query      the chips that built the search. A hypothesis, see below
 *   text       taxonomy terms found in the record's own words. Deterministic
 *   extracted  what the LLM read off free text. Zero weight until promoted
 *
 * Every one of them lands at zero weight until someone promotes it, so being
 * generous about what counts as a tag costs a queue row, never a wrong score.
 */

export type TagKind = "program" | "school" | "year" | "state" | "extracted";

/**
 * Facets map onto the older, coarser `TagKind` because the graph groups and
 * filters on kind, and eleven filter buttons where there were four is a worse
 * screen. The precise facet rides along for display.
 */
const FACET_KIND: Record<TagFacet, TagKind> = {
  program: "program",
  award: "program",
  company: "extracted",
  org: "extracted",
  college: "school",
  highschool: "school",
  major: "extracted",
  title: "extracted",
  flag: "extracted",
  count: "extracted",
  year: "year",
  state: "state",
};

export type Tag = {
  label: string;
  kind: TagKind;
  /** The precise facet, when this came from the registry. */
  facet?: TagFacet;
  origin: "query" | "text" | "llm" | "attribute";
  /** False means "the query implies this but the text does not show it". */
  confirmed: boolean;
  /** True when deduced rather than stated, e.g. a home state. */
  inferred?: boolean;
  /** True when this tag is promoted and actually contributing to the score. */
  weighted?: boolean;
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

/**
 * The scoring vocabulary: every tag switched on, by display label.
 *
 * One list, from one place. There used to be two parallel systems — a flat
 * `promoted` string list weighted by `taxonomy.weights`, and the tag registry —
 * which meant two screens for editing weights, two ways for the same credential
 * to exist, and no shared alias table between them. The registry is now the only
 * source, so a term and a tag are the same thing.
 */
export function vocabulary(tax: TaxonomyPrefs): string[] {
  return Object.values(tax.tags)
    .filter((d) => d.promoted)
    .map((d) => d.label);
}

/** Facets whose evidence is prose rather than a structured field. */
const TEXT_FACETS = new Set<TagFacet>(["program", "award"]);

/** Which part of a record a facet is understood to have come from. */
const SOURCE_FOR_FACET: Record<TagFacet, MatchedTerm["source"]> = {
  program: "honors",
  award: "honors",
  company: "experience",
  org: "volunteering",
  college: "education",
  highschool: "education",
  major: "education",
  title: "experience",
  flag: "projects",
  count: "projects",
  year: "education",
  state: "education",
};

/**
 * Which taxonomy terms this record evidences, and where each was found.
 *
 * Search-only and enriched records run through the same matcher with no
 * discount — a search-only person simply has less text, so they match fewer
 * terms and score lower. That is a consequence of the evidence, not a penalty
 * applied on top of it.
 */
/**
 * Which registry tags a person holds, and where each was found.
 *
 * Split out from `matchedTerms` because the taxonomy screen needs the same answer
 * *ignoring* whether a tag is switched on — it has to say how many people hold a
 * tag in order to decide whether to switch it on. It used to count only the
 * structured extractor's output, so Programs, Awards, Colleges and High schools
 * all reported zero holders: those are found by text matching and by the tagger,
 * neither of which `extractTags` covers.
 */
export function heldTags(p: Person, tax: TaxonomyPrefs): { def: TagDef; source: Signal["source"] }[] {
  const index = indexRegistry(tax.tags);
  const out: { def: TagDef; source: Signal["source"] }[] = [];
  const seen = new Set<string>();

  const take = (def: TagDef, source: Signal["source"]) => {
    if (seen.has(def.id)) return;
    seen.add(def.id);
    out.push({ def, source });
  };

  /**
   * 1. Structured facts, read straight off the vendor's fields.
   *
   * Companies, schools, majors, titles, flags and geography. Exact, free, and the
   * bulk of a populated profile.
   */
  for (const cand of extractTags(p).tags) {
    const res = resolveTag(index, cand);
    if (res.kind === "exact") take(res.def, SOURCE_FOR_FACET[res.def.facet]);
  }

  /**
   * 2. Credentials named in the record's own words.
   *
   * Only programmes and awards are text-matched. A company or a school is already
   * known exactly from a structured field, and string-matching those as well would
   * fire on any passing mention — "interned at a Google-backed startup" is not a
   * Google role.
   */
  const fields = fieldedText(p);
  for (const def of Object.values(tax.tags)) {
    if (!TEXT_FACETS.has(def.facet) || seen.has(def.id)) continue;
    // Aliases count: "Z-Fellow" in a headline is the Z Fellow tag.
    const forms = [def.label, ...def.aliases];
    const hit = fields.find((f) => forms.some((form) => mentions(f.text, form)));
    if (hit) take(def, hit.source);
  }

  /**
   * 3. What the tagger read out of prose, resolved through the alias table.
   *
   * This case is easy to miss and the taxonomy loop does not work without it. The
   * tagger returns *normalised* names — "Regeneron Science Talent Search" comes
   * back as "STS" — so a credential frequently appears nowhere verbatim in the
   * text. Matching on text alone would mean switching a tag on, watching nothing
   * happen, and having no way to tell why.
   */
  for (const label of [...(p.extractedTerms ?? []), ...(p.manualTerms ?? [])]) {
    const def = resolveAny(index, label);
    if (def) take(def, "extracted");
  }

  /**
   * 4. A confirmed search chip the record's own sections did not surface.
   *
   * The SERP title is text about this person. Unconfirmed chips never count,
   * because nothing substantiates them.
   */
  for (const l of p.searchLabels) {
    if (!l.confirmed) continue;
    const def = resolveAny(index, l.label);
    if (def) take(def, "snippet");
  }

  return out;
}

export function matchedTerms(p: Person, tax: TaxonomyPrefs): MatchedTerm[] {
  const out: MatchedTerm[] = [];

  // Only the tags actually switched on contribute to a score.
  for (const { def, source } of heldTags(p, tax)) {
    if (!def.promoted || def.weight <= 0) continue;
    out.push({ label: def.label, weight: def.weight, cluster: def.cluster, source });
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

  /**
   * Deduped on kind AND label.
   *
   * It used to key on the label alone, so a school named the same as a program
   * silently lost one of them — and the graph keyed on `kind:label` correctly, so
   * the two screens disagreed about how many tags a person had.
   */
  const key = (kind: TagKind, label: string) => `${kind}:${label.toLowerCase()}`;
  const have = new Set(out.map((t) => key(t.kind, t.label)));

  const take = (t: Tag) => {
    if (have.has(key(t.kind, t.label))) return;
    have.add(key(t.kind, t.label));
    out.push(t);
  };

  /**
   * Everything the extractor found, whether or not it scores.
   *
   * Unpromoted tags appear here deliberately: the point of showing a profile is
   * to show what is on it, and holding a tag at zero weight is a statement about
   * scoring, not about whether the fact is real. `weighted` marks which ones are
   * actually contributing so the UI can tell them apart.
   */
  const index = indexRegistry(tax.tags);
  for (const cand of extractTags(p).tags) {
    const res = resolveTag(index, cand);
    const def = res.kind === "exact" ? res.def : null;
    take({
      label: def?.label ?? cand.label,
      kind: FACET_KIND[cand.facet],
      facet: cand.facet,
      origin: cand.selfReported ? "query" : "attribute",
      confirmed: true,
      inferred: cand.inferred,
      weighted: Boolean(def?.promoted && def.weight > 0),
      cluster: def?.cluster ?? null,
    });
  }

  for (const t of attributeTags(p)) take(t);

  for (const label of p.manualTerms ?? []) {
    take({ label, kind: "extracted", origin: "attribute", confirmed: true });
  }

  // `dismissed` is compared case-insensitively here to match `unmatchedTerms`.
  // It used to be an exact-string check, so a term dismissed as "Coke Scholar"
  // and extracted as "coke scholar" vanished from the promote queue while still
  // rendering as a chip.
  const dismissed = new Set(tax.dismissed.map((d) => d.toLowerCase()));
  for (const label of p.extractedTerms ?? []) {
    if (dismissed.has(label.trim().toLowerCase())) continue;
    take({ label, kind: "extracted", origin: "llm", confirmed: true });
  }

  // Unconfirmed chips, last and marked, so the sweep screen can show why this
  // person was looked at without implying the claim is established.
  for (const l of p.searchLabels) {
    if (l.confirmed) continue;
    take({ label: l.label, kind: "program", origin: "query", confirmed: false });
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
  // Resolved through the registry, not compared by lowercase. A term the tagger
  // wrote as "Massachusetts Institute of Technology" is already known as the MIT
  // tag, and offering it again would be offering a duplicate.
  const index = indexRegistry(tax.tags);
  const dismissed = new Set(tax.dismissed.map((t) => normalizeKey(t)));
  const tally = new Map<string, { term: string; slugs: string[] }>();

  for (const p of people) {
    // Hand-added terms are reviewable exactly like extracted ones — someone
    // typing "Davidson Fellow" on a row is the same finding as the model
    // reading it, and both should reach the promote queue.
    for (const raw of [...(p.extractedTerms ?? []), ...(p.manualTerms ?? [])]) {
      const term = raw.trim();
      if (!term) continue;
      const key = normalizeKey(term);
      if (!key || resolveAny(index, term) || dismissed.has(key)) continue;
      const entry = tally.get(key) ?? { term, slugs: [] };
      if (!entry.slugs.includes(p.slug)) entry.slugs.push(p.slug);
      tally.set(key, entry);
    }
  }

  return [...tally.values()]
    .map((e) => ({ term: e.term, count: e.slugs.length, slugs: e.slugs }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

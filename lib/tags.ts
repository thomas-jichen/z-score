import type { Archetype } from "./clusters";
import { clusterOf, weightOf } from "./clusters";
import {
  FOUNDING_ROLE,
  extractTags,
  type OrgFacet,
  type OrgLookup,
  type SchoolLookup,
} from "./extract";
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
  accelerator: "program",
  company: "extracted",
  startup: "extracted",
  lab: "extracted",
  club: "extracted",
  org: "extracted",
  college: "school",
  highschool: "school",
  major: "extracted",
  title: "extracted",
  flag: "extracted",
  count: "extracted",
  year: "year",
  state: "state",
  homestate: "state",
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

type Field = { text: string; source: Signal["source"]; venture?: true; founded?: true };

/**
 * The record's own words, split by section so a breakdown can cite one.
 *
 * `venture` marks the two fields that are prose about a *business* rather than a
 * claim about the person: an experience description and a project description. The
 * distinction matters for anything that means "somebody chose me", because those
 * fields routinely name other people's backers. Olaoluwa Oguneye is a Partner at Dorm
 * Room Fund, "the original student-run venture fund backed by a16z" — a sentence about
 * the fund, which scored him 1.8 as though a16z had backed *him*.
 *
 * `founded` is the exception that makes that rule usable. Tarun Batchu is CEO of Vela,
 * whose description reads "Backed by a16z (sr007) and Z Fellows" — the same shape of
 * sentence, and true about him, because when you founded the company its backers are
 * your backers. The role is what separates the two, and excluding the field outright
 * threw the real one away with the false one.
 */
function fieldedText(p: Person): Field[] {
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
      venture: true as const,
    })),
    ...e.volunteering.map((v) => ({
      text: [v.role, v.organization].filter(Boolean).join(" "),
      source: "volunteering" as const,
    })),
    ...e.educations.map((x) => ({
      text: [x.school, x.degree, x.field].filter(Boolean).join(" "),
      source: "education" as const,
    })),
    /**
     * Experience descriptions are long-form and were previously not searched at all,
     * which discarded the richest text on a populated profile.
     *
     * The company *name* is deliberately not in here. It has its own structured
     * resolution path, and throwing it into the credential vocabulary is the "any
     * passing mention" hazard in its purest form: Vineet Saravanan was a Researcher
     * at a company called "SSP International", which scored him for the Summer
     * Science Program.
     */
    ...e.experience.map((x) => ({
      text: [x.title, x.description].filter(Boolean).join(" "),
      source: "experience" as const,
      venture: true as const,
      ...(FOUNDING_ROLE.test(x.title ?? "") ? { founded: true as const } : {}),
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
 * Phrases that carry an accelerator's name and none of its meaning.
 *
 * "Y Combinator Startup School" is a free online course with open enrolment. It read
 * as YC itself and put a 2.0 — the heaviest weight in the taxonomy — on someone whose
 * honour was literally "Y Combinator Startup School 2026 Admit". The YC Summer
 * Fellowship is the same shape of problem: a grant, not a batch, and holding the Y
 * Combinator tag has to mean being funded as a founder.
 *
 * The list is short and specific by design: each entry is a real thing whose whole
 * problem is that it borrows a famous name.
 */
const BORROWED_NAME =
  /startup school|startup library|\bcohort\s+guest\b|newsletter|\bsummer fellow\b|\bfellowship grant\b|\bconference\b|\bmeetup\b/i;

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
/**
 * Facets whose evidence is prose rather than a structured field.
 *
 * Accelerators belong here for the same reason programmes do: "YC S26" and "a16z
 * Speedrun Scout" appear in headlines constantly and frequently nowhere else. The
 * risk that made companies ineligible — "interned at a Google-backed startup" is not
 * a Google role — does not apply, because naming an accelerator in your own headline
 * *is* the claim.
 */
const TEXT_FACETS = new Set<TagFacet>(["program", "accelerator"]);

/** Which part of a record a facet is understood to have come from. */
const SOURCE_FOR_FACET: Record<TagFacet, MatchedTerm["source"]> = {
  program: "honors",
  // Usually read off the education section, where a batch is listed like a degree.
  accelerator: "education",
  company: "experience",
  startup: "experience",
  lab: "experience",
  club: "experience",
  org: "volunteering",
  college: "education",
  highschool: "education",
  major: "education",
  title: "experience",
  flag: "projects",
  count: "projects",
  year: "education",
  state: "education",
  homestate: "education",
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
/**
 * Which state a school is in, from the registry.
 *
 * Resolved rather than looked up by name, so "UC Berkeley …M.E.T. program" finds
 * the Berkeley entry and its state. This is what makes a home state a fact rather
 * than a scan for any state name on the profile.
 */
/**
 * Which facet the registry files an organisation under, whatever the name pattern
 * guessed.
 *
 * The same shape as `schoolStateLookup`, and for the same reason: a pattern is right
 * about the long tail and wrong about every name that does not describe itself.
 * "Cluely" contains no word meaning startup and "Stanford ASES" contains no word
 * meaning club, so the curated answer has to be able to overrule the guess.
 */
export function orgFacetLookup(tax: TaxonomyPrefs): OrgLookup {
  const index = indexRegistry(tax.tags);
  const ALL: OrgFacet[] = ["accelerator", "startup", "lab", "club", "company"];
  /**
   * Organisation facets only, deliberately.
   *
   * Letting this fall through to the programme vocabulary looked helpful — "Ambassador
   * @ Conrad Challenge" is the competition, not a job — and quietly reopened a hole:
   * `normalizeKey` strips "international", so the company "SSP International" collapses
   * to "SSP" and matched the Summer Science Program. Nothing is lost by refusing.
   * Someone who really did the programme says so in their honours, which is where that
   * is read from, and where Conrad Challenge is in fact found.
   */
  return (name, guess) => {
    for (const facet of [guess, ...ALL.filter((f) => f !== guess)]) {
      const r = resolveTag(index, { label: name, facet });
      if (r.kind === "exact") return facet;
    }
    return guess;
  };
}

export function schoolStateLookup(tax: TaxonomyPrefs): SchoolLookup {
  const index = indexRegistry(tax.tags);
  /**
   * The registry answers both questions about a school: which kind it is, and
   * which state it is in.
   *
   * The guess passed in comes from the degree and the school's name, and it is
   * wrong on any acronym — "TJHSST" contains no word that says high school, so it
   * was filed as a college and then failed to resolve against a registry that had
   * it as a high school all along. The registry knows, so it decides, and the
   * guess is only used when the school is genuinely unknown.
   *
   * The guess is still tried first, which is what keeps "Stanford Online High
   * School" from matching Stanford: it asks as a high school, resolves as one, and
   * never reaches the college facet.
   */
  return (school, guess) => {
    /**
     * Accelerators are asked first, whatever the guess.
     *
     * A batch listed in the education section — "Y Combinator / S26", "Z Fellows /
     * Gap Year" — has no word in it that says accelerator, so the name-based guess
     * always calls it a college. Asking the registry first is what turns four
     * profiles' strongest credential from nothing into a tag. It cannot steal a real
     * school, because a school is only claimed here if it is in the accelerator list
     * by name.
     */
    const order: ("highschool" | "college" | "accelerator")[] =
      guess === "highschool"
        ? ["accelerator", "highschool", "college"]
        : ["accelerator", "college", "highschool"];
    for (const facet of order) {
      const r = resolveTag(index, { label: school, facet });
      if (r.kind === "exact") return { facet, state: r.def.state };
    }
    return { facet: guess };
  };
}

export type HeldTag = {
  def: TagDef;
  source: Signal["source"];
  /** Deduced rather than stated, e.g. a home state. */
  inferred?: boolean;
  /** Claimed in the headline rather than backed by a record. */
  selfReported?: boolean;
};

/**
 * The keys a person's removals stand for.
 *
 * Both the registry id and the bare normalised label, because the two answer
 * different questions and a removal means both of them. Resolving through the
 * registry is what makes removing "Yale" remove the Yale tag however the profile
 * spelled it; keeping the bare label is what makes it work for a chip that is not a
 * registry entry at all, and for the geography facets, whose ids carry the facet —
 * `state:massachusetts` and `homestate:massachusetts` are two tags with one name, and
 * clicking × on one of them plainly means that name.
 */
function suppressedKeys(p: Person, index: ReturnType<typeof indexRegistry>): Set<string> {
  const out = new Set<string>();
  for (const label of p.suppressedTags ?? []) {
    const def = resolveAny(index, label);
    if (def) out.add(def.id);
    const bare = normalizeKey(label);
    if (bare) out.add(bare);
  }
  return out;
}

function isSuppressedTag(keys: Set<string>, id: string, label: string): boolean {
  if (keys.size === 0) return false;
  return keys.has(id) || keys.has(normalizeKey(label));
}

export function heldTags(p: Person, tax: TaxonomyPrefs): HeldTag[] {
  const index = indexRegistry(tax.tags);
  const out: HeldTag[] = [];
  const seen = new Set<string>();

  const suppressed = suppressedKeys(p, index);

  const take = (def: TagDef, source: Signal["source"], extra?: Partial<HeldTag>) => {
    if (seen.has(def.id) || isSuppressedTag(suppressed, def.id, def.label)) return;
    seen.add(def.id);
    out.push({ def, source, ...extra });
  };

  /**
   * 1. Structured facts, read straight off the vendor's fields.
   *
   * Companies, schools, majors, titles, flags and geography. Exact, free, and the
   * bulk of a populated profile.
   */
  for (const cand of extractTags(p, schoolStateLookup(tax), orgFacetLookup(tax)).tags) {
    const res = resolveTag(index, cand);
    if (res.kind === "exact") {
      take(res.def, SOURCE_FOR_FACET[res.def.facet], {
        inferred: cand.inferred,
        selfReported: cand.selfReported,
      });
    }
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
    /**
     * An accelerator is only read from what the person says about themselves.
     *
     * Being funded is the heaviest signal here, so it is the one that can least
     * afford a coincidence. A programme name in prose about a company is usually
     * about the company.
     */
    const usable =
      def.facet === "accelerator"
        ? fields.filter((f) => (!f.venture || f.founded) && !BORROWED_NAME.test(f.text))
        : fields;
    /**
     * Aliases count — "Z-Fellow" in a headline is the Z Fellow tag — but only the
     * ones long enough to mean something on their own.
     *
     * "YC" is an alias of Y Combinator, and Yasin Ehsan's experience description
     * reads "10 companies into yc/a16z sr." He places other people into YC; he was
     * never in it. A two-character token in prose is a coincidence waiting to
     * happen, and nothing real is lost by ignoring it: everyone actually in a batch
     * has it in their education section or in their company's registered name.
     */
    const forms = [def.label, ...def.aliases.filter((a) => a.length >= 3)];
    const hit = usable.find((f) => forms.some((form) => mentions(f.text, form)));
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

/**
 * Facts about a person rather than credentials. Used to group, not to score.
 *
 * Removals apply here too, and this is where the × on a profile was silently doing
 * nothing. These three chips are built straight off the person, so a school or a
 * class year came back on the next render however many times it was deleted —
 * Max Fan carried "Ad Astra School" and "Class of 2029" in `suppressedTags` and
 * displayed both. The record of the removal was being kept and never read.
 *
 * The suppression has to live at this layer rather than on the stored field.
 * `refreshDerived` recomputes `school` and `gradYear` from the profile on every read
 * and is deliberately authoritative — so clearing the field would be undone by the
 * next page load, and only the tag layer can hold the correction.
 */
/**
 * Registry labels grouped by facet, for the selection menus.
 *
 * Promoted first, then heaviest, then alphabetical: the tags that actually score
 * are the ones worth searching for, and a menu of two hundred alphabetical
 * entries buries them.
 *
 * Lifted out of the sweep screen so the Agent screen builds a campaign from the
 * same menus in the same order, rather than growing a second opinion about what
 * should be near the top.
 */
export function menusByFacet(tags: TaxonomyPrefs["tags"]): Map<TagFacet, string[]> {
  const m = new Map<TagFacet, string[]>();
  const defs = Object.values(tags).sort(
    (a, b) =>
      Number(b.promoted) - Number(a.promoted) ||
      b.weight - a.weight ||
      a.label.localeCompare(b.label)
  );
  for (const d of defs) {
    const list = m.get(d.facet) ?? [];
    list.push(d.label);
    m.set(d.facet, list);
  }
  return m;
}

export function attributeTags(p: Person, suppressed?: Set<string>): Tag[] {
  const out: Tag[] = [];
  const year = p.gradYear ? String(p.gradYear) : p.inferredYear;
  const keep = (label: string) =>
    !suppressed || !isSuppressedTag(suppressed, normalizeKey(label), label);

  if (p.school && keep(p.school)) {
    out.push({ label: p.school, kind: "school", origin: "attribute", confirmed: true });
  }
  if (year && keep(`Class of ${year}`)) {
    out.push({ label: `Class of ${year}`, kind: "year", origin: "attribute", confirmed: true });
  }
  if (p.state && keep(p.state)) {
    out.push({ label: p.state, kind: "state", origin: "attribute", confirmed: true });
  }
  return out;
}

/**
 * Every label on a person, for the graph and the detail screen. Terms in the
 * taxonomy come first, then attributes, then extracted terms not yet promoted.
 */
export function allTags(p: Person, tax: TaxonomyPrefs): Tag[] {
  /**
   * One pass over the registry, so a tag appears exactly once.
   *
   * This used to run two: `matchedTerms` forced every result to `kind: "program"`,
   * and then a second pass added the same tags again under their real facet. Every
   * scoring tag therefore became two, which is why the graph drew "Shady Side
   * Academy" and "Computer Science" twice and reported eighty-one tags for twenty
   * people. The facet is the tag's own, and it is the only thing that decides kind.
   */
  const out: Tag[] = [];
  const key = (kind: TagKind, label: string) => `${kind}:${label.toLowerCase()}`;
  const have = new Set<string>();
  /** Registry ids already placed, so a resolvable extracted term is not repeated. */
  const placed = new Set<string>();

  const take = (t: Tag) => {
    if (have.has(key(t.kind, t.label))) return;
    have.add(key(t.kind, t.label));
    out.push(t);
  };

  const index = indexRegistry(tax.tags);

  for (const { def, source, inferred, selfReported } of heldTags(p, tax)) {
    placed.add(def.id);
    take({
      label: def.label,
      kind: FACET_KIND[def.facet],
      facet: def.facet,
      origin: selfReported ? "query" : source === "snippet" ? "query" : "attribute",
      confirmed: true,
      inferred,
      // Unpromoted tags still appear: showing a profile means showing what is on
      // it, and holding a tag at zero weight is a statement about scoring, not
      // about whether the fact is real. This marks the ones contributing.
      weighted: def.promoted && def.weight > 0,
      cluster: def.cluster,
    });
  }

  /**
   * The attribute chips, minus any the registry has already placed under its own
   * name for that school or state.
   *
   * Same rule the extracted and manual terms already go through, and it started
   * mattering once the label was corrected: `p.school` became "Stanford University"
   * where the registry holds "Stanford", so the profile grew two school chips for one
   * school. The registry's name is the canonical one and wins.
   */
  for (const t of attributeTags(p, suppressedKeys(p, index))) {
    const def = resolveAny(index, t.label);
    if (def && placed.has(def.id)) continue;
    take(t);
  }

  for (const label of p.manualTerms ?? []) {
    const def = resolveAny(index, label);
    if (def && placed.has(def.id)) continue;
    take({ label, kind: "extracted", origin: "attribute", confirmed: true });
  }

  // `dismissed` is compared case-insensitively here to match `unmatchedTerms`.
  // It used to be an exact-string check, so a term dismissed as "Coke Scholar"
  // and extracted as "coke scholar" vanished from the promote queue while still
  // rendering as a chip.
  const dismissed = new Set(tax.dismissed.map((d) => d.toLowerCase()));
  for (const label of p.extractedTerms ?? []) {
    if (dismissed.has(label.trim().toLowerCase())) continue;
    // Already shown under its canonical name, so showing the raw one too would be
    // the duplicate the registry exists to prevent.
    const def = resolveAny(index, label);
    if (def && placed.has(def.id)) continue;
    take({ label, kind: "extracted", origin: "llm", confirmed: true });
  }

  // Unconfirmed chips, last and marked, so the sweep screen can show why this
  // person was looked at without implying the claim is established.
  for (const l of p.searchLabels) {
    if (l.confirmed) continue;
    const def = resolveAny(index, l.label);
    if (def && placed.has(def.id)) continue;
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
export type Unmatched = {
  term: string;
  count: number;
  slugs: string[];
  /**
   * What the extractor already believes this is, when it came from a structured
   * field. Absent for prose, where only the words are known.
   */
  facet?: TagFacet;
};

export function unmatchedTerms(people: Person[], tax: TaxonomyPrefs): Unmatched[] {
  // Resolved through the registry, not compared by lowercase. A term the tagger
  // wrote as "Massachusetts Institute of Technology" is already known as the MIT
  // tag, and offering it again would be offering a duplicate.
  const index = indexRegistry(tax.tags);
  const schools = schoolStateLookup(tax);
  const orgs = orgFacetLookup(tax);
  const dismissed = new Set(tax.dismissed.map((t) => normalizeKey(t)));
  const tally = new Map<string, { term: string; slugs: string[]; facet?: TagFacet }>();

  const offer = (raw: string, slug: string, facet?: TagFacet) => {
    const term = raw.trim();
    if (!term) return;
    const key = normalizeKey(term);
    if (!key || resolveAny(index, term) || dismissed.has(key)) return;
    const entry = tally.get(key) ?? { term, slugs: [], facet };
    if (!entry.slugs.includes(slug)) entry.slugs.push(slug);
    // A facet from a structured field beats one guessed from prose, which has none.
    if (!entry.facet && facet) entry.facet = facet;
    tally.set(key, entry);
  };

  for (const p of people) {
    // Hand-added terms are reviewable exactly like extracted ones — someone
    // typing "Davidson Fellow" on a row is the same finding as the model
    // reading it, and both should reach the promote queue.
    for (const raw of [...(p.extractedTerms ?? []), ...(p.manualTerms ?? [])]) offer(raw, p.slug);

    /**
     * Structured facts the registry does not know yet.
     *
     * This was the hole. The queue only ever saw what the tagger read out of prose,
     * so a research lab, a student society and a seed-stage startup sitting in the
     * experience section were not tagged, not scored, and — the part that made it
     * unfixable — never even offered. Jacob Lee's profile named eight of them and
     * showed none.
     *
     * Only the facets a person would actually curate. A job title or a class year
     * arriving here would bury the queue in noise.
     */
    for (const cand of extractTags(p, schools, orgs).tags) {
      if (!OFFERABLE.has(cand.facet)) continue;
      if (resolveTag(index, cand).kind === "exact") continue;
      offer(cand.label, p.slug, cand.facet);
    }
  }

  return [...tally.values()]
    .map((e) => ({ term: e.term, count: e.slugs.length, slugs: e.slugs, facet: e.facet }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term));
}

/** Facets worth reviewing by hand. The rest are facts, not judgements. */
const OFFERABLE = new Set<TagFacet>([
  "program",
  "accelerator",
  "company",
  "startup",
  "lab",
  "club",
  "org",
]);

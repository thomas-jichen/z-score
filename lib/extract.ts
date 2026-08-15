import { isHighSchool, type EnrichedProfile } from "./enrichment";
import type { Person } from "./people";
import { MAJORS, TITLES, type Seed } from "./searchTaxonomy";
import { normalizeKey, type TagFacet } from "./tagRegistry";

/**
 * Deterministic tag extraction. No model, no network, no tokens.
 *
 * ── Why this exists ──────────────────────────────────────────────────────
 * The tagger used to ask an LLM to read a profile and name the credentials, and
 * its prompt explicitly excluded schools, companies and job titles. So on a
 * profile naming Stanford, Google, McKinsey, Jane Street, Dorm Room Fund and
 * nine roles, it returned one tag.
 *
 * Almost all of that was never prose to begin with. `experience[].company`,
 * `educations[].school`, `educations[].field`, `experience[].title` and the
 * array lengths are structured vendor fields. Reading them here is exact,
 * instant and free, and it leaves the model with only the job it is actually
 * needed for: judging which of seventeen honors are worth anything, and
 * canonicalising their names.
 *
 * Everything emitted here is a *candidate*. It carries zero weight until someone
 * promotes it, so being generous costs nothing but a row in a review queue.
 */

export type CandidateTag = {
  label: string;
  facet: TagFacet;
  /** LinkedIn's own entity id, where the vendor gave one. Exact dedupe. */
  linkedinId?: string;
  /** True when this was deduced rather than stated. Shown as such. */
  inferred?: boolean;
  /** True when it came from the person's own headline rather than a record. */
  selfReported?: boolean;
};

export type CountKind = "experience" | "project" | "publication" | "patent" | "honor";

export const COUNT_KINDS: readonly CountKind[] = [
  "experience",
  "project",
  "publication",
  "patent",
  "honor",
];

export type Extraction = {
  tags: CandidateTag[];
  counts: Record<CountKind, number>;
};

/** Followers above this reads as reach rather than a normal student network. */
export const INFLUENCER_FOLLOWERS = 10_000;

/* ── Small helpers ──────────────────────────────────────────────────────── */

function clean(s: string | undefined): string {
  return (s ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Split a compound field into parts.
 *
 * "Co-founder & CTO" is two roles, and "Mathematics and Computer Science" is two
 * majors. Both arrive as one string, and treating them as one tag loses half the
 * information. The `and` split is word-bounded so "Research and Development" is
 * not shredded — it splits, but both halves then fail the vocabulary match and
 * fall through as a single raw candidate instead.
 */
function splitCompound(s: string): string[] {
  return s
    .split(/\s*(?:&|\/|,|\band\b|\+|\|)\s*/i)
    .map(clean)
    .filter(Boolean);
}

/** Case-insensitive whole-word containment. "Analyst" fires in "Business Analyst". */
function contains(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Find every seed whose label or alias appears in the text, longest label first
 * so "Co-founder" wins over "Founder" on the same string and both are not
 * emitted for one role.
 */
function seedsIn(text: string, seeds: Seed[]): string[] {
  const out: string[] = [];
  const taken: string[] = [];
  const ordered = [...seeds].sort((a, b) => b.label.length - a.label.length);

  for (const seed of ordered) {
    const forms = [seed.label, ...(seed.aliases ?? [])];
    if (!forms.some((f) => contains(text, f))) continue;
    // Skip a shorter label already covered by a longer one just matched, so
    // "Electrical Engineering and Computer Science" does not also emit "Computer
    // Science" from the same substring.
    if (taken.some((t) => contains(t, seed.label))) continue;
    taken.push(seed.label);
    out.push(seed.label);
  }
  return out;
}

function push(into: CandidateTag[], seen: Set<string>, tag: CandidateTag) {
  const key = `${tag.facet}:${normalizeKey(tag.label)}`;
  if (!tag.label || seen.has(key)) return;
  seen.add(key);
  into.push(tag);
}

/* ── US states, for the home-state inference ────────────────────────────── */

export const US_STATES: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California",
  CO: "Colorado", CT: "Connecticut", DE: "Delaware", FL: "Florida", GA: "Georgia",
  HI: "Hawaii", ID: "Idaho", IL: "Illinois", IN: "Indiana", IA: "Iowa",
  KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi",
  MO: "Missouri", MT: "Montana", NE: "Nebraska", NV: "Nevada",
  NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma",
  OR: "Oregon", PA: "Pennsylvania", RI: "Rhode Island", SC: "South Carolina",
  SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah", VT: "Vermont",
  VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin",
  WY: "Wyoming", DC: "District of Columbia",
};

/** Full state name from a name or a two-letter code. */
export function stateName(v: string | undefined): string | undefined {
  const s = clean(v);
  if (!s) return undefined;
  const upper = s.toUpperCase();
  if (US_STATES[upper]) return US_STATES[upper];
  const hit = Object.values(US_STATES).find((n) => n.toLowerCase() === s.toLowerCase());
  return hit;
}

/**
 * Where someone is now.
 *
 * `region` is the vendor's structured two-letter code and is preferred, but it is
 * frequently absent — on a live record reading "Stanford, California, United
 * States" it came back undefined, so relying on it alone lost the state entirely.
 * The display string is then the only source, and it is reliable because LinkedIn
 * writes it in a fixed "City, Region, Country" form.
 */
export function currentState(e: EnrichedProfile, fallback?: string): string | undefined {
  const fromCode = stateName(e.region) ?? stateName(fallback);
  if (fromCode) return fromCode;

  for (const part of (e.location ?? "").split(",")) {
    const named = stateName(part);
    if (named) return named;
  }
  return undefined;
}

/**
 * Where someone is *from*, as distinct from where they are now.
 *
 * The high school is the answer. A Stanford student's LinkedIn location is
 * Stanford, California; the state that groups them with their cohort is where they
 * went to school.
 *
 * An education record carries no location and a school's name rarely contains one,
 * so the state comes from the school's own registry entry. The previous approach —
 * scanning award issuers, school names and job locations for any state name — put
 * six of nineteen people in the wrong state: Sewickley Academy came out as New
 * York rather than Pennsylvania, Groton as California rather than Massachusetts.
 * A profile mentions many states and only one of them is home.
 *
 * `schoolState` is supplied by the caller, which knows the registry. Falls back to
 * a state named in the school's own text, and returns nothing rather than a guess.
 */
/**
 * Asks the registry what a school is. Takes the caller's guess, and may correct it.
 */
export type SchoolLookup = (
  school: string,
  guess: "highschool" | "college"
) => { facet: "highschool" | "college"; state?: string };

export function inferHomeState(
  e: EnrichedProfile,
  lookup: SchoolLookup
): string | undefined {
  // Earliest first: a high school is far more local than a university.
  const schools = [...e.educations]
    .sort((a, b) => (a.endYear ?? Infinity) - (b.endYear ?? Infinity))
    .filter((x) => x.school);

  const secondary = schools.filter(isHighSchool);
  /**
   * The high school decides, and only falls through to a university when no high
   * school is listed at all.
   *
   * Not "high school first, then anything": someone whose only high school is
   * Stanford Online High School has no knowable home state, and letting it fall
   * through put them in California because that is where their university is.
   * A wrong answer is worse than none here, since this is the field that groups
   * someone with their actual cohort.
   */
  for (const list of secondary.length > 0 ? [secondary] : [schools]) {
    for (const ed of list) {
      const known = lookup(ed.school, isHighSchool(ed) ? "highschool" : "college").state;
      if (known) return known;
    }
    for (const ed of list) {
      const named = STATE_NAMES.find((n) => contains(ed.school, n));
      if (named) return named;
    }
  }
  return undefined;
}

const STATE_NAMES = Object.values(US_STATES);

/* ── The extractor ──────────────────────────────────────────────────────── */

/**
 * `schoolState` maps a school name to its state, supplied by the caller because
 * only it holds the registry. Defaults to knowing nothing, so a caller that does
 * not care about geography needs no extra argument.
 */
export function extractTags(
  p: Person,
  lookup: SchoolLookup = (_s, guess) => ({ facet: guess })
): Extraction {
  const tags: CandidateTag[] = [];
  const seen = new Set<string>();
  const e = p.enriched;

  const counts: Record<CountKind, number> = {
    experience: e?.experience.length ?? 0,
    project: e?.projects.length ?? 0,
    publication: e?.publications.length ?? 0,
    patent: e?.patents.length ?? 0,
    honor: e?.honors.length ?? 0,
  };

  if (!e) {
    // Search-only people still have a headline worth mining.
    for (const m of seedsIn(p.headline, MAJORS)) {
      push(tags, seen, { label: m, facet: "major", selfReported: true });
    }
    for (const t of seedsIn(p.headline, TITLES)) {
      push(tags, seen, { label: t, facet: "title", selfReported: true });
    }
    return { tags, counts };
  }

  /* Schools. `schoolId` makes two spellings of one school the same tag. */
  for (const ed of e.educations) {
    if (!ed.school) continue;
    // Two facets, because a university and a feeder high school answer different
    // questions and carry very different weights. The registry has the final say:
    // the name-based guess is wrong on every acronym.
    push(tags, seen, {
      label: ed.school,
      facet: lookup(ed.school, isHighSchool(ed) ? "highschool" : "college").facet,
      linkedinId: ed.schoolId,
    });
  }

  /* Majors. The education record is authoritative; the headline is a claim. */
  for (const ed of e.educations) {
    for (const part of splitCompound(ed.field ?? "")) {
      const known = seedsIn(part, MAJORS);
      if (known.length > 0) for (const k of known) push(tags, seen, { label: k, facet: "major" });
      else push(tags, seen, { label: part, facet: "major" });
    }
  }
  for (const m of seedsIn(p.headline, MAJORS)) {
    // `push` drops it if the education record already established this major, so
    // the authoritative version keeps its unflagged status.
    push(tags, seen, { label: m, facet: "major", selfReported: true });
  }

  /* Companies and the roles held at them. */
  for (const x of e.experience) {
    if (x.company) {
      push(tags, seen, { label: x.company, facet: "company", linkedinId: x.companyId });
    }
    for (const part of splitCompound(x.title)) {
      const known = seedsIn(part, TITLES);
      if (known.length > 0) for (const k of known) push(tags, seen, { label: k, facet: "title" });
      // An unrecognised role still becomes a candidate rather than vanishing —
      // it just sits at zero weight until someone decides it means something.
      else push(tags, seen, { label: part, facet: "title" });
    }
  }

  /* Organisations someone gave time to rather than worked for. */
  for (const v of e.volunteering) {
    if (v.organization) push(tags, seen, { label: v.organization, facet: "org" });
  }

  /* Flags: facts about the whole profile rather than a line on it. */
  if ((e.followerCount ?? 0) >= INFLUENCER_FOLLOWERS) {
    push(tags, seen, { label: "Influencer", facet: "flag" });
  }
  if (counts.publication > 0) push(tags, seen, { label: "Published", facet: "flag" });
  if (counts.patent > 0) push(tags, seen, { label: "Patent holder", facet: "flag" });
  if ((e.featured ?? []).length > 0) push(tags, seen, { label: "Has a site", facet: "flag" });

  /* Cohort and geography. */
  const year = e.gradYear ?? p.gradYear;
  if (year) push(tags, seen, { label: String(year), facet: "year" });

  const current = currentState(e, p.state);
  if (current) push(tags, seen, { label: current, facet: "state" });

  // Its own facet, and emitted even when it equals the current state. They are
  // two different facts, and "from here and still here" is itself worth filtering
  // on — suppressing the duplicate made that group invisible.
  const home = inferHomeState(e, lookup);
  if (home) push(tags, seen, { label: home, facet: "homestate", inferred: true });

  return { tags, counts };
}

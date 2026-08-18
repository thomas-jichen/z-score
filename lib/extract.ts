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
 * Asks the registry what an education row names. Takes the caller's guess, and may
 * correct it.
 *
 * `accelerator` is one of the answers because LinkedIn's education section is where
 * a batch gets listed: "Y Combinator / S26", "Z Fellows / Gap Year". Those rows were
 * being filed as universities, so they matched nothing and scored nothing — the
 * single strongest signal in the roster, silently dropped on four profiles.
 */
export type SchoolLookup = (
  school: string,
  guess: "highschool" | "college"
) => { facet: "highschool" | "college" | "accelerator"; state?: string };

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
      const answer = lookup(ed.school, isHighSchool(ed) ? "highschool" : "college");
      // An accelerator has an address, not a home town. Skipping it matters: YC
      // would have made every founder in the roster Californian.
      if (answer.facet !== "accelerator" && answer.state) return answer.state;
    }
    for (const ed of list) {
      const named = STATE_NAMES.find((n) => contains(ed.school, n));
      if (named) return named;
    }
  }
  return undefined;
}

const STATE_NAMES = Object.values(US_STATES);

/**
 * A batch marker inside a company's registered name.
 *
 * YC companies almost universally name themselves "Willow (YC S24)" on LinkedIn, and
 * that string is the whole signal: it says professional investors funded this
 * company, which is the strongest thing a profile can say in this population. It was
 * matching nothing, because company names are resolved by exact key and containment
 * is deliberately off for companies — "ex-Google intern" must not become a Google
 * role.
 *
 * This is not that. The marker is part of the legal-ish name, in a fixed shape, and
 * it means one specific thing. So it gets its own narrow rule rather than a general
 * loosening: a season letter and two digits, in brackets, after the accelerator's
 * initials. "(YC S24)", "(YC W23)", "(YC F24)", "(YC X25)".
 */
const BATCH_MARKERS: { re: RegExp; label: string }[] = [
  { re: /\(\s*yc\s*[swfx]?\d{2}\s*\)/i, label: "Y Combinator" },
  { re: /\(\s*(?:a16z\s+)?speedrun(?:\s+[a-z]?\d{2})?\s*\)/i, label: "a16z" },
  { re: /\(\s*pearx?(?:\s+[a-z]?\d{2})?\s*\)/i, label: "Pear VC" },
  { re: /\(\s*techstars(?:\s+[a-z]?\d{2})?\s*\)/i, label: "Techstars" },
];

function backerInCompanyName(company: string): string | null {
  for (const m of BATCH_MARKERS) if (m.re.test(company)) return m.label;
  return null;
}

/**
 * The organisation's name, without the tagline people append to it.
 *
 * LinkedIn company names routinely carry one: "NASA - National Aeronautics and Space
 * Administration", "Kairos | Infrastructure for Performance Content". The whole
 * string matches nothing, so a research post at NASA scored the same as no job at
 * all. Only the leading segment is taken, and only when what is left still looks like
 * a name — containment would be the general fix and is far too dangerous on company
 * names, where "ex-Google intern" must not become a Google role.
 */
function orgName(raw: string): string {
  const head = raw.split(/\s+[-–—|:]\s+/)[0].trim();
  return head.length >= 2 ? head : raw.trim();
}

/**
 * A company that has taken money, in the words founders use to say so.
 *
 * Deliberately narrow. "Raised" alone catches "raised awareness"; these are phrases
 * that only appear when there is a cheque behind them.
 */
const IS_FUNDED =
  /\bbacked by\b|\bfunded by\b|\braised \$|\bpre-?seed\b|\bseed round\b|\bseries [abc]\b|\bventure-backed\b/i;

/**
 * A top placing, as people actually write one.
 *
 * "Finalist", "semifinalist" and "qualifier" are deliberately absent: reaching a
 * final is already what the competition's own tag means, and treating it as a win is
 * the mistake this exists to correct.
 */
const TOP_PLACING =
  /\b(1st|2nd|3rd|first|second|third)\s+place\b|\bgrand (award|prize)\b|\b(gold|silver|bronze)\s+medal(l?ist)?\b|\bchampion\b|\bbest in\b|\bwinner\b|\bwon\b/i;

/**
 * The fair, however it is written. Regeneron and Intel are its former sponsors and
 * both still appear in the name people put on their profile.
 */
const ISEF = /\bisef\b|\binternational science (and|&) engineering fair\b/i;

/**
 * A degree field that says the row is not a degree.
 *
 * Summer programmes, extension courses, exchange terms and audits all land in the
 * education section under the host university's name. "Dual Enrollment" is
 * deliberately absent: registering for credit at a university is a real
 * registration, however young the student.
 */
const ATTENDED_NOT_ENROLLED =
  /\bcoursework\b|\bsummer\b|\bpre-?college\b|\bonline\b|\bextension\b|\bcontinuing education\b|\bcertificate\b|\bnon-?degree\b|\bvisiting\b|\bexchange\b|\baudit(ed|ing)?\b|\benrichment\b/i;

/** A title that names an occasion rather than a job. */
const EVENT_TITLE =
  /\b(symposium|conference|summit|convention|forum|expo|hackathon|datathon|workshop|webinar|panel|seminar|masterclass|open day|insight day|discovery day|career day|info session|showcase|retreat|meetup)\b/i;

/**
 * A word that makes a title a role.
 *
 * Long on purpose: a false positive here costs an event tag, and a false negative
 * costs a real employer. The list errs towards keeping the row.
 */
const ROLE_NOUN =
  /\b(intern|internship|engineer|analyst|researcher|scientist|developer|founder|co-?founder|director|president|officer|manager|lead|associate|fellow|fellowship|consultant|assistant|chair(man|woman)?|board|representative|ambassador|volunteer|teacher|instructor|tutor|mentor|judge|ceo|cto|cfo|coo|cmo|vp|head|partner|trainee|apprentice|extern|scholar|member|coordinator|treasurer|secretary|editor|captain|advis[eo]r|architect|designer|strategist|specialist|technician|staff|counsel|writer|producer|operator|contributor|organiz|organis)\b/i;

/**
 * A hackathon, however it is spelled.
 *
 * `hacks\b` without a leading boundary is deliberate: TreeHacks and CalHacks have no
 * word break before the suffix. "Hack Club" is an organisation rather than an event
 * and does not contain it.
 */
const HACKATHON =
  /\bhackathon\b|hacks\b|\bhackmit\b|\bhack the north\b|\bpennapps\b/i;

/**
 * The named olympiads, by acronym or by the words people write instead.
 *
 * Deliberately a list rather than the bare word "olympiad": Science Olympiad is a
 * school activity with a quarter of a million entrants and was purged from the
 * vocabulary for it, and "National Science Olympiad" would otherwise read as a
 * national olympiad team.
 */
const OLYMPIAD =
  /\b(usabo|usapho|usamo|usaco|usnco|useso|ibo|imo|ipho|icho|ioi|ioaa|naclo)\b|\b(biology|physics|chemistry|mathematical|maths?|astronomy|earth science|computing|linguistics|informatics) olympiad\b/i;

/**
 * The tier where an olympiad stops being an exam and starts being a selection.
 *
 * Megan D'Souza and Evan Xiang both held one USABO tag worth 0.5. Hers reads
 * "Semifinalist, Top 225, score of 31 on the Open Exam"; his reads "2x National
 * Finalist, invited to training camp" — roughly the top twenty in the country. One
 * tag for both is the same mistake ISEF had, where placing and attending scored
 * alike, and it gets the same fix: a tier carried as one flag that stacks with the
 * competition's own weight, rather than a second tag per olympiad.
 *
 * Semifinalist and qualifier are pointedly absent. Clearing the first round is what
 * the competition's own tag already means.
 */
const OLYMPIAD_ELITE =
  /\bnational finalist\b|\btraining camp\b|\bcampers?\b|\bnational team\b|\bteam member\b|\bgold medal(l?ist)?\b/i;

/**
 * The tier above finalist. Narrower than TOP_PLACING, because ISEF's own award names
 * are the specific thing being claimed — "1st place" at a regional feeder fair is
 * not a Grand Award, and neither is "winner".
 */
const ISEF_TIER =
  /\bgrand award\b|\bbest of category\b|\b(1st|2nd|3rd|4th|first|second|third|fourth)\s+place\b/i;

/** The facets an organisation on a profile can turn out to be. */
export type OrgFacet = "company" | "startup" | "lab" | "club" | "accelerator";

/**
 * Asks the registry what an organisation is, given a guess from its name and the
 * role held there. Mirrors `SchoolLookup`: the registry decides, the guess is the
 * fallback for anything it has never seen.
 */
export type OrgLookup = (name: string, guess: OrgFacet) => OrgFacet;

const LAB_WORDS = /\b(lab|labs|laborator(y|ies)|research (group|centre|center|institute|lab))\b/i;
const CLUB_WORDS =
  /\b(club|society|association|chapter|council|fraternity|sorority|student government|student union|entrepreneurs?|ases|bases)\b/i;
/**
 * Actually founded it, as opposed to arriving early.
 *
 * "Founding" on its own is deliberately not here. "Founding Growth and Operations
 * Manager" is employee number five, and reading it as a founder handed Jacob Lee the
 * full 2.0 for Y Combinator off a job at a YC company — putting an early hire level
 * with the people who got into the batch. Being early at a good startup is a real
 * signal and it is scored as one: the company, not the accelerator.
 */
export const FOUNDING_ROLE =
  /\b(founder|co-?founder|founding (partner|member))\b|\b(ceo|cto)\b|\bchief (executive|technology)\b/i;

/**
 * What kind of organisation this is, from its name and the role held there.
 *
 * Everything used to be a company, which is how a research lab, a student society and
 * a seed-stage startup all ended up unrecognised and unweighted on the same profile.
 * These are patterns rather than a list because the long tail is the point: the guess
 * only has to be good enough to file the thing correctly in the review queue, where a
 * person confirms it once and the registry answers for it ever after.
 */
export function classifyOrg(name: string, role = ""): OrgFacet {
  if (backerInCompanyName(name)) return "startup";
  if (LAB_WORDS.test(name)) return "lab";
  if (CLUB_WORDS.test(name)) return "club";
  // Founding a company is the one case where the role, not the name, says what the
  // company is: nobody is the co-founder of a bank.
  if (FOUNDING_ROLE.test(role)) return "startup";
  return "company";
}

/* ── The extractor ──────────────────────────────────────────────────────── */

/**
 * `schoolState` maps a school name to its state, supplied by the caller because
 * only it holds the registry. Defaults to knowing nothing, so a caller that does
 * not care about geography needs no extra argument.
 */
export function extractTags(
  p: Person,
  lookup: SchoolLookup = (_s, guess) => ({ facet: guess }),
  orgLookup: OrgLookup = (_n, guess) => guess
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
    /**
     * Taking a course at a university is not going to it.
     *
     * Vihaan Shringi's education section lists Carnegie Mellon, where he is reading
     * computer science, and Stanford, where the degree field reads "Accredited
     * coursework" for a single summer. Both produced a college tag, so a summer
     * programme scored the same 0.8 as a degree — the same mistake as Ishan
     * Ramrakhiani being tagged Yale for Yale Young Global Scholars, one field over.
     *
     * The row is still on the profile and still visible. It is not a school he
     * attends.
     */
    if (ATTENDED_NOT_ENROLLED.test(`${ed.degree ?? ""} ${ed.field ?? ""}`)) continue;
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
    /**
     * Going to an event at a company is not working there.
     *
     * Max Fan's experience section has `company: "Jump Trading"` with the title "AI
     * Research Symposium" — an event he attended, which scored the same 1.4 as a desk
     * on their trading floor. LinkedIn's experience section takes anything, and a
     * conference is one of the things people put in it.
     *
     * A title naming an event *and* holding no role noun is attendance. Both halves
     * are needed: "Bootcamp Fellow" and "Case Competition Judge" name events and are
     * genuinely roles, and dropping those would lose real signal to fix a smaller
     * problem.
     */
    if (
      x.title &&
      EVENT_TITLE.test(x.title) &&
      !ROLE_NOUN.test(x.title)
    ) {
      continue;
    }
    if (x.company) {
      const name = orgName(x.company);
      const facet = orgLookup(name, classifyOrg(name, x.title));
      push(tags, seen, {
        label: name,
        facet,
        // Only a real employer has a canonical LinkedIn company id worth trusting as
        // an identity; a lab or a club shares its page with the university.
        ...(facet === "company" || facet === "startup" ? { linkedinId: x.companyId } : {}),
      });
      /**
       * The batch belongs to the founders.
       *
       * "(YC S24)" in a company name says the company got in, and for a founder that
       * is the same statement about them. For an early employee it is a statement
       * about their employer — worth something, but not the 2.0 that being selected
       * by Y Combinator is worth. They still get the company as a startup tag.
       */
      const backer = backerInCompanyName(x.company);
      if (backer && FOUNDING_ROLE.test(x.title ?? "")) {
        push(tags, seen, { label: backer, facet: "accelerator" });
      }
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
    if (!v.organization) continue;
    // A student society is a club whether it is listed as a job or as volunteering.
    const guess = classifyOrg(v.organization, v.role);
    const facet = orgLookup(v.organization, guess);
    push(tags, seen, {
      // An employer read out of volunteering is a nonprofit, not a job.
      label: v.organization,
      facet: facet === "company" ? "org" : facet,
    });
  }

  /* Flags: facts about the whole profile rather than a line on it. */
  if ((e.followerCount ?? 0) >= INFLUENCER_FOLLOWERS) {
    push(tags, seen, { label: "Influencer", facet: "flag" });
  }
  if (counts.publication > 0) push(tags, seen, { label: "Published", facet: "flag" });
  if (counts.patent > 0) push(tags, seen, { label: "Patent holder", facet: "flag" });
  if ((e.featured ?? []).length > 0) push(tags, seen, { label: "Has a site", facet: "flag" });

  /**
   * Won a hackathon, rather than went to one.
   *
   * This was "Competition winner" and fired on a placing in any honour at all, which
   * made it true of thirteen people and specific about none of them: a piano
   * competition, a business case, a state science fair and three actual hackathons
   * all carried it. A flag that means "did well at something" adds a constant to
   * almost everybody and separates nobody.
   *
   * Hackathons are the case where the tier carries the most: the taxonomy prices
   * TreeHacks and CalHacks at 0.3 as things a good builder does on a weekend, and
   * winning one is a different claim. The two tiers that used to lean on the general
   * flag have their own tags now — ISEF Grand Award and Olympiad camper.
   *
   * Read from honours only. A placing named in prose about a company is marketing.
   */
  if (
    e.honors.some((h) => {
      const line = `${h.title} ${h.description ?? ""}`;
      return HACKATHON.test(line) && TOP_PLACING.test(line);
    })
  ) {
    push(tags, seen, { label: "Hackathon winner", facet: "flag" });
  }

  /**
   * Placed at ISEF, as opposed to placed at something.
   *
   * The one competition the taxonomy splits by tier, and the only tag here that needs
   * two facts in the same breath: the fair, and the placing. Text matching cannot say
   * that — it matches one form at a time — so the tag used to carry "Grand Award" as
   * an alias, which the noise pass reduced to the bare word `grand`. Every Grand Prize
   * in the corpus then resolved to it: a piano competition, a business-plan contest,
   * and by luck the two people who had actually won one.
   *
   * Read per honour rather than over the whole profile, so an ISEF line and a grand
   * prize from somewhere else cannot combine into a credential neither one is.
   */
  if (
    e.honors.some((h) => {
      const line = `${h.title} ${h.issuedBy ?? ""} ${h.description ?? ""}`;
      return ISEF.test(line) && ISEF_TIER.test(line);
    })
  ) {
    push(tags, seen, { label: "ISEF Grand Award", facet: "program" });
  }

  /**
   * Reached the national round of an olympiad, rather than sat the exam.
   *
   * Same shape as the ISEF tier above and for the same reason: two facts in one
   * line, which text matching cannot express, and read per honour so a semifinal in
   * one subject and a camp invitation in another cannot combine.
   */
  if (
    e.honors.some((h) => {
      const line = `${h.title} ${h.issuedBy ?? ""} ${h.description ?? ""}`;
      return OLYMPIAD.test(line) && OLYMPIAD_ELITE.test(line);
    })
  ) {
    push(tags, seen, { label: "Olympiad camper", facet: "flag" });
  }

  /**
   * Founded something that investors put money into.
   *
   * Two facts live in one line of a profile — getting into the batch, and building the
   * company that got in — and only the first was scored. So a YC founder whose profile
   * says little else sat below someone with a science-fair award and a pile of
   * hackathons, which is backwards for a tool that exists to find people worth
   * funding. The accelerator tag is the filter they cleared; this is the company they
   * built, and it is the fact this whole product is looking for.
   *
   * An early employee at the same company gets neither, which is the point.
   */
  if (
    e.experience.some(
      (x) =>
        FOUNDING_ROLE.test(x.title ?? "") &&
        (backerInCompanyName(x.company ?? "") !== null || IS_FUNDED.test(x.description ?? ""))
    )
  ) {
    push(tags, seen, { label: "Funded founder", facet: "flag" });
  }

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

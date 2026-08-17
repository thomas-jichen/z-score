import { extractSlug } from "./search";
import { COLLEGES } from "./searchTaxonomy";

/**
 * The vendor-neutral shape everything downstream reads.
 *
 * Nothing outside lib/apify.ts knows what HarvestAPI's payload looks like.
 * Swapping to Bright Data — which also exposes People Also Viewed, at roughly a
 * quarter the price, and is the right move above ~100k profiles/month — should
 * mean rewriting one parse function, not touching the UI.
 */

/**
 * A neighbour from the People Also Viewed sidebar. Cheap: no scrape needed.
 *
 * `position` is the vendor's headline equivalent and `year` is inferred from it
 * at parse time. Both are enough to triage a neighbour without opening LinkedIn,
 * which matters because the decision they inform is whether to spend money.
 */
export type Neighbor = {
  slug: string;
  name: string;
  position: string;
  year?: string;
  url: string;
};

/** A neighbour plus which profile surfaced it. What a hop offer is made of. */
export type HopCandidate = Neighbor & { seedSlug: string; seedName: string };

/**
 * How much of `moreProfiles` is the People Also Viewed sidebar.
 *
 * Measured against five real profiles, 90 neighbours: the array comes back at 10
 * or 20 entries, and the quality cliff is at exactly index 10 every time. The
 * first ten are genuine co-views — for a Stanford CS student, other Stanford and
 * MIT students with STS, RSI and USAPhO in their headlines. Entries 11 to 20 are
 * a different population with no overlap: on one profile ten Italian names with
 * no headline at all, on another ten accounts reading "Student at Stanford
 * University", which is LinkedIn's auto-generated headline for someone who never
 * wrote one, plus a cash-for-gold business.
 *
 * Scored across those five profiles: 0 of the first 50 were junk, and 35 of the
 * next 40 were. In four of four profiles that returned twenty, the second block
 * was worthless.
 *
 * So the cut is positional. A headline test alone let one profile's entire tail
 * through, because that tail happened to have headlines.
 */
export const MAX_NEIGHBORS = 10;

/**
 * Whether a neighbour is worth showing at all.
 *
 * Secondary to the positional cut, for a blank inside the first ten. The vendor
 * writes a literal "--" into `position` when it has no headline, and such a row
 * is unactionable on its own terms: nothing to triage on, and $0.004 to find out.
 * One arrived named "Datollski undefined", the scraper stringifying a missing
 * `lastName` — these records are degraded at the source, not merely sparse.
 */
const NO_HEADLINE = /^\s*-{1,2}\s*$/;

export function isUsableNeighbor(n: Neighbor): boolean {
  return n.position.length > 0 && !NO_HEADLINE.test(n.position);
}

/**
 * The neighbours worth offering: the sidebar block, minus anything blank in it.
 *
 * One policy, applied at parse time and again on read, so records enriched
 * before the tail was understood are cleaned up without paying to re-enrich.
 */
export function usableNeighbors(neighbors: Neighbor[]): Neighbor[] {
  return neighbors.slice(0, MAX_NEIGHBORS).filter(isUsableNeighbor);
}

export type Education = {
  school: string;
  /**
   * LinkedIn's own school id. The canonical identity: "Stanford", "Stanford
   * University" and "Stanford U" all carry the same one, so school tags dedupe
   * exactly instead of by string comparison.
   */
  schoolId?: string;
  degree?: string;
  field?: string;
  startYear?: number;
  endYear?: number;
};

export type Honor = {
  title: string;
  issuedBy?: string;
  issuedAt?: string;
  description?: string;
  /** "Associated with Inflection AI". Extra context, present on real payloads. */
  associatedWith?: string;
};

export type Project = {
  title: string;
  description?: string;
  startYear?: number;
};

/**
 * Note there is no `cause`. The parser used to read one; a real HarvestAPI
 * payload has no such field, so it was always undefined and fed an empty
 * string into term matching.
 */
export type Volunteering = {
  role: string;
  organization?: string;
  duration?: string;
};

export type Experience = {
  title: string;
  company?: string;
  /** Same role as `Education.schoolId`: exact company identity, not a string. */
  companyId?: string;
  /** Long-form and often the richest text on a profile. Worth matching against. */
  description?: string;
  /** Where the role was, which is often the home state on an early job. */
  location?: string;
  startYear?: number;
  endYear?: number;
  /** No end date means it is current. Needed to tell a current role from a past one. */
  current?: boolean;
};

/**
 * How a candidate entered the system. Kept per-candidate rather than per-run
 * because the same person is frequently found twice, and which path found them
 * first is the thing worth knowing.
 *
 * PAV is a co-view model, not a similarity model — it reports who browsers
 * looked at in the same session. Provenance is what makes drift measurable:
 * without it there is no way to tell which seeds produce good subtrees.
 */
export type Provenance =
  | { kind: "serp"; query: string }
  /** Hand-supplied starting point, not discovered by the tool. */
  | { kind: "seed" }
  | { kind: "pav"; seedSlug: string; seedName: string; hop: number };

export type EnrichedProfile = {
  slug: string;
  name: string;
  headline: string;
  location: string;
  about: string;
  url: string;
  /**
   * Two-letter region from `location.parsed.regionCode`, e.g. "TX". Structured
   * by the vendor, so the graph groups on this rather than string-slicing the
   * display text.
   */
  region?: string;
  /** Graduation year, derived from education end dates. The main cohort filter. */
  gradYear?: number;
  educations: Education[];
  honors: Honor[];
  projects: Project[];
  volunteering: Volunteering[];
  experience: Experience[];
  skills: string[];
  certifications: string[];
  languages: string[];
  publications: string[];
  patents: string[];
  /**
   * The three below are optional because records enriched before they were
   * captured simply do not have them. Read through `?? []` rather than
   * pretending every stored profile predates nothing.
   */

  /** Coursework. Documented as returned and previously not stored at all. */
  courses?: string[];
  /**
   * Pinned links: personal site, GitHub, press. The vendor doc names this as the
   * builder signal, and it was being dropped in full.
   */
  featured?: string[];
  /** Prose written about the person by someone else. */
  recommendations?: string[];
  /** The vendor's own current-role summary, rather than us re-deriving it. */
  currentPosition?: string;
  followerCount?: number;
  connectionsCount?: number;
  /** Country, so a domestic/international split does not need the display string. */
  countryCode?: string;
  /**
   * Per-item scrape status. Without it a failed scrape and a genuinely sparse
   * profile are indistinguishable, and we would tag the first as if it were the
   * second.
   */
  status?: string;
  /** When the account was created. Joining at 14 is itself a signal. */
  registeredAt?: string;
  /** People Also Viewed. The expansion primitive for the seed path. */
  neighbors: Neighbor[];
  /**
   * How many the sidebar returned with no headline. Kept so the UI can say the
   * list was trimmed instead of quietly showing a shorter one.
   */
  neighborsDropped?: number;
  discoveredVia: Provenance;
  enrichedAt: string;
};

/** $4 per 1,000 profiles, HarvestAPI's no-email mode. */
export const COST_PER_PROFILE = 0.004;

export function estimateCost(count: number): number {
  return count * COST_PER_PROFILE;
}

/** "$0.40", or "$0.004" when the total would round away to nothing. */
export function formatCost(dollars: number): string {
  if (dollars > 0 && dollars < 0.01) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

/**
 * Accepts anything that identifies a profile — a full URL, a locale subdomain
 * URL, a bare slug — and returns the canonical slug.
 *
 * The slug is the only safe dedupe key. Names collide, and the same person
 * shows up under different display names across SERP titles and PAV entries.
 */
export function toSlug(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  const fromUrl = extractSlug(trimmed);
  if (fromUrl) return fromUrl;

  // A bare public identifier. Reject anything with whitespace or a scheme, so
  // a pasted name never silently becomes a lookup for a nonexistent profile.
  if (/^[a-z0-9\-_%]+$/i.test(trimmed)) {
    return decodeURIComponent(trimmed).toLowerCase();
  }
  return null;
}

/** Parse a pasted block of profile URLs, one per line. Reports what failed. */
export function parseSeedInput(text: string): { slugs: string[]; rejected: string[] } {
  const slugs: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const line of text.split(/[\n,]/)) {
    const raw = line.trim();
    if (!raw) continue;
    const slug = toSlug(raw);
    if (!slug) {
      rejected.push(raw);
      continue;
    }
    if (seen.has(slug)) continue;
    seen.add(slug);
    slugs.push(slug);
  }
  return { slugs, rejected };
}

export function profileUrl(slug: string): string {
  return `https://www.linkedin.com/in/${slug}`;
}

/** The neighbours of one profile, as slugs. */
export function neighborsOf(profile: EnrichedProfile): string[] {
  return profile.neighbors.map((n) => n.slug).filter(Boolean);
}

/**
 * Next hop: every neighbour of the given profiles that hasn't been seen.
 *
 * `known` covers both already-enriched candidates and the seeds themselves, so
 * a hop never re-pays for someone already in the store.
 */
export function nextHop(profiles: EnrichedProfile[], known: Set<string>): HopCandidate[] {
  const out: HopCandidate[] = [];
  const picked = new Set<string>();

  for (const p of profiles) {
    for (const n of p.neighbors) {
      if (!n.slug || known.has(n.slug) || picked.has(n.slug)) continue;
      picked.add(n.slug);
      // Spread the neighbour rather than projecting a slug out of it: the name
      // and position are the whole point of showing this row.
      out.push({ ...n, seedSlug: p.slug, seedName: p.name });
    }
  }
  return out;
}

/**
 * Years between leaving school and finishing college. Used to state a class year
 * for someone who has only listed a high school, which is most of this population.
 */
export const HIGH_SCHOOL_TO_COLLEGE = 4;

/**
 * Whether an education record is secondary rather than tertiary.
 *
 * Needed because "class of" throughout the app means the **college** graduating
 * class: a 2026 high-school leaver is the class of 2030. Reads the degree first,
 * which is explicit when present, and falls back to the school's name.
 */
export function isHighSchool(e: Education): boolean {
  const degree = (e.degree ?? "").toLowerCase();
  if (/high school|secondary|hs diploma|ged/.test(degree)) return true;
  if (/bachelor|bs\b|ba\b|master|phd|associate|undergrad|doctor/.test(degree)) return false;

  const school = (e.school ?? "").toLowerCase();
  if (/university|college|institute of technology|\bpolytechnic\b/.test(school)) return false;
  return /high school|\bhs\b|academy|preparatory|\bprep\b|secondary|magnet|gymnasium/.test(school);
}

/**
 * Whether an education record is tertiary *study* — a degree someone is working
 * towards or has finished.
 *
 * The third answer `isHighSchool` cannot give. LinkedIn's education section takes
 * anything, and this population fills it with accelerators and summer programmes:
 * "Z Fellows / Gap Year", "Y Combinator / S26", "buildspace / Physics", "Yale Young
 * Global Scholars / Innovation". None of those is a high school, so treating
 * "not secondary" as "college" handed the class year to whichever of them carried a
 * date — Davido Zhang read as the class of 2026 off a Z Fellows row, and Philip
 * Meng as the class of 2019 off his middle school.
 *
 * So a row counts only when the degree names one, or the school is plainly a
 * degree-granting institution. Everything else is a line on a CV, not a graduation.
 */
export function isDegreeRow(e: Education): boolean {
  if (isHighSchool(e)) return false;
  const degree = (e.degree ?? "").toLowerCase();
  if (
    /bachelor|master|doctor|phd|associate|undergrad|\bb\.?s\.?\b|\bb\.?a\.?\b|\bm\.?s\.?\b|\bm\.?a\.?\b|\bmba\b|\bs\.?b\.?\b/.test(
      degree
    )
  ) {
    return true;
  }
  const school = (e.school ?? "").toLowerCase();
  if (/university|college|institute of technology|\bpolytechnic\b/.test(school)) return true;

  /**
   * The word is not always in the name.
   *
   * "UC Berkeley Management, Entrepreneurship, & Technology (M.E.T.) program" says
   * neither "university" nor "college", so Tarun Batchu's Berkeley row did not count
   * as study and his label fell to a community college that happened to spell the
   * word out. The curated list is the same vocabulary the taxonomy is seeded from
   * and already knows Berkeley, MIT and Caltech under the names people write.
   */
  return KNOWN_COLLEGE.test(school);
}

/**
 * The seeded colleges, matched on whole words so an acronym cannot fire inside
 * another word. Built once: this runs for every education row on every read.
 */
const KNOWN_COLLEGE = new RegExp(
  `\\b(${COLLEGES.flatMap((c) => [c.label, ...(c.aliases ?? [])])
    .map((n) => n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .sort((a, b) => b.length - a.length)
    .join("|")})\\b`,
  "i"
);

/** Highest-signal award first, for the one-line summary in list views. */
export function topHonor(profile: EnrichedProfile): string | undefined {
  return profile.honors[0]?.title;
}

/**
 * Shortest credible gap between leaving school and finishing a degree.
 *
 * Two, not four, because an associate degree is two years and a few of this
 * population finish early. It exists only to reject the impossible.
 */
const MIN_SCHOOL_TO_DEGREE = 2;

/**
 * Class year, meaning the *college* class — the number the whole app means by
 * "class".
 *
 * A stated college end date is the answer, but only when it is possible. LinkedIn
 * college rows are often half-filled: Thomas Wang's Stanford record ends 2026 and
 * his high school also ends 2026, which cannot both be graduations. Taking the
 * stated year at face value made an incoming freshman read as the class of 2026 on
 * every screen. So a college-derived answer has to clear leaving school by
 * `MIN_SCHOOL_TO_DEGREE`, and where it does not, the high-school rule takes over —
 * leaving school in 2026 means the class of 2030.
 *
 * Falls back to the latest start year plus four when no end date is stated, which
 * is common on student profiles that only list "started 2024". A guessed year is
 * better than none for a cohort filter, and the raw dates are kept so the guess is
 * auditable.
 */
export function inferGradYear(educations: Education[]): number | undefined {
  const college = educations.filter(isDegreeRow);
  const school = educations.filter(isHighSchool);

  const years = (rows: Education[], key: "startYear" | "endYear") =>
    rows.map((e) => e[key]).filter((y): y is number => y !== undefined);

  const schoolEnds = years(school, "endYear");
  const schoolStarts = years(school, "startYear");
  const leftSchool = schoolEnds.length
    ? Math.max(...schoolEnds)
    : schoolStarts.length
      ? Math.max(...schoolStarts) + 4
      : undefined;

  /** A college answer only counts if it could not be the high-school year. */
  const credible = (y: number) =>
    leftSchool === undefined || y >= leftSchool + MIN_SCHOOL_TO_DEGREE;

  const collegeEnds = years(college, "endYear");
  if (collegeEnds.length > 0) {
    const stated = Math.max(...collegeEnds);
    if (credible(stated)) return stated;
  }

  // In college with no end date stated: four years from starting.
  const collegeStarts = years(college, "startYear");
  if (collegeStarts.length > 0) {
    const guess = Math.max(...collegeStarts) + 4;
    if (credible(guess)) return guess;
  }

  // No usable college row, which is most of this population.
  return leftSchool === undefined ? undefined : leftSchool + HIGH_SCHOOL_TO_COLLEGE;
}

/**
 * The school to put next to someone's name.
 *
 * A degree beats a high school outright, before any date is consulted. Once
 * someone is at university that is who they are — "Thomas Wang, Shady Side
 * Academy" is not wrong about the past but it is wrong about the present, and this
 * string is the one that appears on the queue row, the graph panel and the digest.
 * Every school is still tagged; this only decides the label.
 *
 * Three levels, not two, and that is the correction. `isHighSchool` answers one
 * question and "not secondary" was being read as "college" — but LinkedIn's
 * education section takes anything, and this population fills it with accelerators,
 * summer programmes and bare institution names. Max Fan's rows are Stanford (BS,
 * 2025-2029), Groton, a conservatory, a dual enrolment, and "Ad Astra School" with
 * no degree and no dates at all. That last row counted as a college, and because an
 * absent end date is read as *still enrolled* it then outranked Stanford: the least
 * informative row on the profile won the label, and he was filed under a school he
 * has no stated degree from while his headline says "Stanford CS & Physics".
 *
 * `isDegreeRow` already draws this distinction and `inferGradYear` already uses it —
 * the same fix, applied to the class year, is what stopped Davido Zhang reading as
 * the class of 2026 off a Z Fellows row. It was never carried across to the label.
 *
 * Dates break ties within a level only. An absent end date still means enrolled and
 * still sorts first, but it can no longer promote a row past a real degree.
 */
export function currentSchool(profile: EnrichedProfile): string | undefined {
  const level = (e: Education) => (isDegreeRow(e) ? 2 : isHighSchool(e) ? 1 : 0);
  const rank = (e: Education) => e.endYear ?? Infinity;
  const sorted = [...profile.educations]
    .filter((e) => e.school)
    .sort(
      (a, b) =>
        level(b) - level(a) ||
        // Infinity on both sides is NaN, which a comparator must never return.
        (rank(b) === rank(a) ? 0 : rank(b) - rank(a)) ||
        (b.startYear ?? 0) - (a.startYear ?? 0)
    );
  return sorted[0]?.school;
}

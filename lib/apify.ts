import type {
  EnrichedProfile,
  Education,
  Experience,
  Honor,
  Neighbor,
  Project,
  Provenance,
  Volunteering,
} from "./enrichment";
import {
  HIGH_SCHOOL_TO_COLLEGE,
  isHighSchool,
  profileUrl,
  toSlug,
  usableNeighbors,
} from "./enrichment";
import { inferYear } from "./search";

/**
 * Apify client for harvestapi/linkedin-profile-scraper.
 *
 * One actor does both jobs. It enriches a profile *and* returns that profile's
 * "People Also Viewed" sidebar as `moreProfiles`, so seed expansion is the same
 * call run twice rather than a second vendor.
 *
 * Runs are started and polled rather than awaited. Apify's synchronous endpoint
 * returns 408 at 300 seconds and a Vercel function caps at 300 too, so a large
 * batch would fail exactly when it mattered most. Polling also survives a page
 * reload mid-run, and is the shape the weekly autonomous loop will need.
 *
 * Note the tilde: the API addresses actors as `user~actor`, not `user/actor`.
 */

const ACTOR = "harvestapi~linkedin-profile-scraper";
const API = "https://api.apify.com/v2";

/** $4/1k. The email-search mode is $10/1k and emails are not what we're after. */
const SCRAPER_MODE = "Profile details no email ($4 per 1k)";

/**
 * One run's batch ceiling.
 *
 * The actor enforces its own, and it depends on the plan: a free Apify account is
 * capped at **10 items per run**, and exceeding it does not truncate — the actor
 * refuses the whole run and writes an error item instead, so asking for 17 returns
 * zero profiles and still bills for the run. Configurable because the right number
 * is a property of the account, not of this code.
 */
export const MAX_PROFILES_PER_RUN = Number(process.env.ZSCORE_APIFY_MAX_PER_RUN ?? 250);

export type RunStatus =
  | "READY"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "TIMING-OUT"
  | "TIMED-OUT"
  | "ABORTING"
  | "ABORTED";

export function isTerminal(status: RunStatus): boolean {
  return status === "SUCCEEDED" || status === "FAILED" || status === "TIMED-OUT" || status === "ABORTED";
}

export function hasToken(): boolean {
  return Boolean(process.env.ZSCORE_APIFY_TOKEN);
}

/** Set ZSCORE_APIFY_MOCK=1 to exercise the whole flow without spending. */
export function isMock(): boolean {
  return process.env.ZSCORE_APIFY_MOCK === "1";
}

function token(): string | null {
  return process.env.ZSCORE_APIFY_TOKEN ?? null;
}

type Started = { runId: string; datasetId: string };

export async function startProfileRun(
  slugs: string[]
): Promise<{ ok: true; run: Started } | { ok: false; error: string }> {
  if (isMock()) {
    return { ok: true, run: { runId: `mock-${Date.now()}`, datasetId: "mock" } };
  }

  const t = token();
  if (!t) return { ok: false, error: "ZSCORE_APIFY_TOKEN is not set." };
  if (slugs.length === 0) return { ok: false, error: "No profiles to enrich." };
  if (slugs.length > MAX_PROFILES_PER_RUN) {
    return { ok: false, error: `At most ${MAX_PROFILES_PER_RUN} profiles per run.` };
  }

  try {
    const res = await fetch(`${API}/acts/${ACTOR}/runs`, {
      method: "POST",
      headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        queries: slugs.map(profileUrl),
        profileScraperMode: SCRAPER_MODE,
      }),
      cache: "no-store",
    });

    const body = await res.text();
    if (!res.ok) {
      return { ok: false, error: `Apify ${res.status}: ${body.slice(0, 200)}` };
    }

    const data = JSON.parse(body) as { data?: { id?: string; defaultDatasetId?: string } };
    const runId = data.data?.id;
    const datasetId = data.data?.defaultDatasetId;
    if (!runId || !datasetId) {
      return { ok: false, error: "Apify did not return a run id." };
    }
    return { ok: true, run: { runId, datasetId } };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach Apify." };
  }
}

export async function getRunStatus(
  runId: string
): Promise<{ ok: true; status: RunStatus } | { ok: false; error: string }> {
  if (isMock()) return { ok: true, status: "SUCCEEDED" };

  const t = token();
  if (!t) return { ok: false, error: "ZSCORE_APIFY_TOKEN is not set." };

  try {
    const res = await fetch(`${API}/actor-runs/${runId}`, {
      headers: { Authorization: `Bearer ${t}` },
      cache: "no-store",
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, error: `Apify ${res.status}: ${body.slice(0, 200)}` };

    const data = JSON.parse(body) as { data?: { status?: RunStatus } };
    const status = data.data?.status;
    if (!status) return { ok: false, error: "Apify returned no run status." };
    return { ok: true, status };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach Apify." };
  }
}

export async function getDatasetItems(
  datasetId: string,
  mockSlugs: string[] = []
): Promise<{ ok: true; items: unknown[] } | { ok: false; error: string }> {
  if (isMock()) return { ok: true, items: mockSlugs.map(mockPayload) };

  const t = token();
  if (!t) return { ok: false, error: "ZSCORE_APIFY_TOKEN is not set." };

  try {
    const res = await fetch(`${API}/datasets/${datasetId}/items?clean=true&format=json`, {
      headers: { Authorization: `Bearer ${t}` },
      cache: "no-store",
    });
    const body = await res.text();
    if (!res.ok) return { ok: false, error: `Apify ${res.status}: ${body.slice(0, 200)}` };

    const items = JSON.parse(body);
    const list: unknown[] = Array.isArray(items) ? items : [];

    /**
     * The actor reports a refusal as a dataset item, not as a failed run.
     *
     * Asking for 17 profiles on a free plan produced `SUCCEEDED`, exit code 0, and
     * a single `{ error: "Free users are limited to 10 items per run..." }`. The
     * old code parsed that item, got null, and reported the job **done with 0
     * people** — so a hard refusal was indistinguishable from seventeen profiles
     * that happened to be empty. Surface it as the failure it is.
     */
    const refusal = list.find((it) => {
      const o = (it ?? {}) as Record<string, unknown>;
      return typeof o.error === "string" && !o.publicIdentifier && !o.linkedinUrl;
    }) as { error?: string } | undefined;
    if (refusal?.error) return { ok: false, error: `Apify: ${refusal.error}` };

    // A run that scraped nothing at all is also a failure, not an empty success.
    if (list.length === 0) {
      return { ok: false, error: "Apify returned no profiles for this run." };
    }

    return { ok: true, items: list };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Could not reach Apify." };
  }
}

// ── Mock ──────────────────────────────────────────────────────────────────
// Shaped exactly like a real HarvestAPI item, including the nested date
// objects and the moreProfiles fan-out, so mock mode exercises the real parser
// rather than a convenient simplification of it.

function mockPayload(slug: string): Record<string, unknown> {
  const seed = [...slug].reduce((a, c) => a + c.charCodeAt(0), 0);
  const pick = <T,>(list: T[], offset = 0) => list[(seed + offset) % list.length];
  const gradYear = 2026 + (seed % 8);

  return {
    publicIdentifier: slug,
    linkedinUrl: profileUrl(slug),
    firstName: pick(["Ada", "Mira", "Noor", "Ken", "Iris", "Theo", "Sana", "Luca"]),
    lastName: pick(["Chen", "Okonkwo", "Haddad", "Tanaka", "Vega", "Brandt", "Iyer"], 3),
    headline: pick([
      "Building something new",
      "Researcher, incoming freshman",
      "Founder | ISEF Finalist",
      "Student, USACO Platinum",
    ], 1),
    // Shaped like the real thing: display text plus a structured `parsed` block.
    location: (() => {
      const [city, region] = pick(
        [
          ["Austin, TX", "TX"],
          ["Palo Alto, CA", "CA"],
          ["Boston, MA", "MA"],
          ["Seattle, WA", "WA"],
        ],
        2
      );
      return { linkedinText: city, countryCode: "US", parsed: { text: city, regionCode: region } };
    })(),
    about: "Mock profile generated because ZSCORE_APIFY_MOCK=1.",
    registeredAt: `${gradYear - 6}-08-14`,
    followerCount: 200 + (seed % 4000),
    connectionsCount: 100 + (seed % 900),
    education: [
      {
        schoolName: pick(["TJHSST", "The Harker School", "Stuyvesant", "Phillips Exeter"], 4),
        schoolId: `mock-school-${seed % 4}`,
        degree: "High School Diploma",
        startDate: { year: gradYear - 4 },
        endDate: { year: gradYear },
      },
      {
        schoolName: "Stanford University",
        schoolLinkedinUrl: "https://www.linkedin.com/school/stanford-university/",
        degree: "Bachelor of Science - BS",
        fieldOfStudy: "Mathematics and Computer Science",
        startDate: { year: gradYear },
      },
    ],
    honorsAndAwards: [
      {
        title: pick(["RSI 2025", "ISEF Finalist", "USAMO Qualifier", "Coca-Cola Scholar"], 5),
        issuedBy: "Mock",
        associatedWith: "Associated with Mock Lab",
      },
      { title: "Regeneron STS Semifinalist", issuedBy: "Society for Science" },
    ],
    projects: [{ title: "Open-source ML library", description: "1.2k stars", startDate: { year: gradYear - 2 } }],
    volunteering: [{ role: "Tutor", organizationName: "Local math circle", duration: "2 yrs" }],
    experience: [
      {
        position: "Research Intern",
        companyName: "University lab",
        description: "Worked on a PROMYS-adjacent problem set and shipped an open source solver.",
        location: "Boston, Massachusetts",
        startDate: { year: gradYear - 1 },
      },
      // A compound title and a known company, so title splitting and company
      // identity are both exercised without the live vendor.
      {
        position: "Co-founder & CTO",
        companyName: "Stealth Startup",
        companyLinkedinUrl: "https://www.linkedin.com/company/stealth-startup/",
        startDate: { year: gradYear - 1 },
        endDate: { year: gradYear },
      },
      {
        position: "Summer Business Analyst",
        companyName: "McKinsey & Company",
        companyId: "1371",
        startDate: { year: gradYear },
      },
    ],
    skills: [{ name: "Python" }, { name: "PyTorch" }],
    certifications: [],
    languages: [],
    publications: [],
    patents: [],
    courses: [{ name: "Linear Algebra" }],
    featured: [{ link: "https://github.com/mock" }],
    receivedRecommendations: [{ text: "Sharpest student I have taught." }],
    currentPosition: { position: "Summer Business Analyst", companyName: "McKinsey & Company" },
    status: "ok",
    // Deterministic fan-out so hop expansion is testable and repeatable.
    // A real `position` states a role and usually the class year, so the mock
    // states one too. Otherwise the review table looks correct in mock mode and
    // then shows an empty class column against the live vendor.
    moreProfiles: Array.from({ length: 3 + (seed % 4) }, (_, i) => ({
      id: `ACoAA${seed}${i}`,
      firstName: "Neighbor",
      lastName: `${i + 1}`,
      position:
        i % 3 === 0
          ? "Student"
          : `Student, class of ${gradYear + (i % 3) - 1}`,
      publicIdentifier: `${slug}-n${i + 1}`,
      linkedinUrl: profileUrl(`${slug}-n${i + 1}`),
    })),
  };
}

// ── Parsing ───────────────────────────────────────────────────────────────
// Everything below is the only code in the repo that knows HarvestAPI's field
// names. Keep it that way.

type RawDate = { month?: number | string | null; year?: number | string | null } | null | undefined;

function yearOf(d: RawDate): number | undefined {
  if (!d?.year) return undefined;
  const n = Number(d.year);
  return Number.isFinite(n) && n > 1900 && n < 2100 ? n : undefined;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function num(v: unknown): number | undefined {
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/**
 * Pull LinkedIn's numeric entity id out of a company or school URL.
 *
 * The vendor sometimes gives the id directly and sometimes only the URL. Both
 * carry the same identity, and having it is what lets "Stanford" and "Stanford
 * University" collapse to one tag without guessing at strings.
 */
function idFromUrl(url: string): string {
  const m = url.match(/linkedin\.com\/(?:company|school|edu)\/([^/?#]+)/i);
  return m ? decodeURIComponent(m[1]).toLowerCase() : "";
}

/**
 * `featured` entries are link objects. Any of several keys may hold the URL, so
 * take the first that looks like one rather than guessing a single field name —
 * `nameList` would silently yield an empty array on a key mismatch.
 */
function featuredLinks(v: unknown): string[] {
  const out: string[] = [];
  for (const item of arr(v)) {
    if (typeof item === "string") {
      if (item.trim()) out.push(item.trim());
      continue;
    }
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const link = [o.link, o.url, o.href, o.title, o.text].map(str).find(Boolean);
    if (link) out.push(link);
  }
  return out;
}

/** Either a string or an object naming a title and a company. */
function currentPositionText(v: unknown): string {
  if (typeof v === "string") return v.trim();
  if (!v || typeof v !== "object") return "";
  const o = v as Record<string, unknown>;
  return [str(o.position) || str(o.title), str(o.companyName) || str(o.company)]
    .filter(Boolean)
    .join(" at ");
}

/** Objects sometimes, plain strings other times. Normalise to strings. */
function nameList(v: unknown, key: string): string[] {
  return arr(v)
    .map((x) => {
      if (typeof x === "string") return x.trim();
      if (x && typeof x === "object") return str((x as Record<string, unknown>)[key]);
      return "";
    })
    .filter(Boolean);
}

/**
 * Graduation year: the latest education end date.
 *
 * Falls back to the latest start year plus four when no end date is stated,
 * which is common on student profiles that only list "started 2024". A guessed
 * year is better than none for a cohort filter, and the raw dates are kept so
 * the guess is auditable.
 */
function inferGradYear(educations: Education[]): number | undefined {
  const college = educations.filter((e) => !isHighSchool(e));
  const school = educations.filter(isHighSchool);

  // A stated college end date is the answer.
  const collegeEnds = college.map((e) => e.endYear).filter((y): y is number => y !== undefined);
  if (collegeEnds.length > 0) return Math.max(...collegeEnds);

  // In college with no end date stated: four years from starting.
  const collegeStarts = college.map((e) => e.startYear).filter((y): y is number => y !== undefined);
  if (collegeStarts.length > 0) return Math.max(...collegeStarts) + 4;

  // Only high school on the profile, which is most of this population. Leaving
  // school in 2026 means the class of 2030, and that is the number the whole app
  // means by "class".
  const schoolEnds = school.map((e) => e.endYear).filter((y): y is number => y !== undefined);
  if (schoolEnds.length > 0) return Math.max(...schoolEnds) + HIGH_SCHOOL_TO_COLLEGE;

  const schoolStarts = school.map((e) => e.startYear).filter((y): y is number => y !== undefined);
  if (schoolStarts.length > 0) return Math.max(...schoolStarts) + 4 + HIGH_SCHOOL_TO_COLLEGE;

  return undefined;
}

/**
 * A neighbour arrives with a name and a `position`, which is the headline
 * equivalent. Keeping both is what lets the review table show who someone is
 * before anyone pays to enrich them — this data is already in a payload we have
 * bought, so dropping it and rendering a bare slug was pure loss.
 *
 * `position` frequently states the class year ("PharmD Candidate 2026A at ..."),
 * so the year is inferred here rather than in the UI: it costs nothing at parse
 * time and then persists with the neighbour.
 *
 * This returns everything parseable, including the tail. `usableNeighbors`
 * decides what to keep, and the difference is what gets reported as dropped.
 */

/**
 * The scraper sometimes sends the string "undefined" where a field was missing,
 * which produced names like "Datollski undefined". Treat those as absent.
 */
function namePart(v: unknown): string {
  const s = str(v);
  return s === "undefined" || s === "null" ? "" : s;
}

function parseNeighbors(v: unknown): Neighbor[] {
  return arr(v)
    .map((raw): Neighbor | null => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const slug =
        toSlug(str(o.publicIdentifier)) ?? toSlug(str(o.linkedinUrl)) ?? null;
      if (!slug) return null;

      const name = [namePart(o.firstName), namePart(o.lastName)].filter(Boolean).join(" ");
      const position = str(o.position);
      return {
        slug,
        name: name || slug,
        position,
        year: inferYear(position),
        url: str(o.linkedinUrl) || profileUrl(slug),
      };
    })
    .filter((n): n is Neighbor => n !== null);
}

/** HarvestAPI payload to our shape. The one place the vendor schema lives. */
export function parseProfile(raw: unknown, discoveredVia: Provenance): EnrichedProfile | null {
  const o = (raw ?? {}) as Record<string, unknown>;

  const slug = toSlug(str(o.publicIdentifier)) ?? toSlug(str(o.linkedinUrl));
  if (!slug) return null;

  const educations: Education[] = arr(o.education).map((e) => {
    const x = (e ?? {}) as Record<string, unknown>;
    return {
      school: str(x.schoolName),
      // Carries LinkedIn's own id where present, so two spellings of the same
      // school resolve to one tag without any string comparison.
      schoolId: str(x.schoolId) || idFromUrl(str(x.schoolLinkedinUrl)) || undefined,
      degree: str(x.degree) || undefined,
      field: str(x.fieldOfStudy) || undefined,
      startYear: yearOf(x.startDate as RawDate),
      endYear: yearOf(x.endDate as RawDate),
    };
  });

  const honors: Honor[] = arr(o.honorsAndAwards).map((h) => {
    const x = (h ?? {}) as Record<string, unknown>;
    return {
      title: str(x.title),
      issuedBy: str(x.issuedBy) || undefined,
      issuedAt: str(x.issuedAt) || undefined,
      description: str(x.description) || undefined,
      associatedWith: str(x.associatedWith) || undefined,
    };
  });

  const projects: Project[] = arr(o.projects).map((p) => {
    const x = (p ?? {}) as Record<string, unknown>;
    return {
      title: str(x.title),
      description: str(x.description) || undefined,
      startYear: yearOf(x.startDate as RawDate),
    };
  });

  const volunteering: Volunteering[] = arr(o.volunteering).map((v) => {
    const x = (v ?? {}) as Record<string, unknown>;
    return {
      role: str(x.role),
      organization: str(x.organizationName) || undefined,
      duration: str(x.duration) || undefined,
    };
  });

  const experience: Experience[] = arr(o.experience).map((e) => {
    const x = (e ?? {}) as Record<string, unknown>;
    const endYear = yearOf(x.endDate as RawDate);
    return {
      title: str(x.position) || str(x.title),
      company: str(x.companyName) || undefined,
      companyId: str(x.companyId) || idFromUrl(str(x.companyLinkedinUrl)) || undefined,
      description: str(x.description) || undefined,
      location: str(x.location) || undefined,
      startYear: yearOf(x.startDate as RawDate),
      endYear,
      // An absent end date is how the vendor says "still there".
      current: endYear === undefined && Boolean(yearOf(x.startDate as RawDate)),
    };
  });

  // Verified against a real payload: location is an object carrying both the
  // display string and a `parsed` block with a structured region code.
  const { location, region, countryCode } = (() => {
    const l = o.location;
    if (typeof l === "string") {
      return { location: l.trim(), region: undefined, countryCode: undefined };
    }
    if (l && typeof l === "object") {
      const obj = l as Record<string, unknown>;
      const parsed = (obj.parsed ?? {}) as Record<string, unknown>;
      return {
        location: str(obj.linkedinText) || str(parsed.text),
        region: str(parsed.regionCode) || undefined,
        countryCode: str(obj.countryCode) || undefined,
      };
    }
    return { location: "", region: undefined, countryCode: undefined };
  })();

  const name =
    [str(o.firstName), str(o.lastName)].filter(Boolean).join(" ") || str(o.name) || slug;

  // Split so the count of discarded entries can be reported rather than the list
  // just arriving shorter than the sidebar actually was.
  const sidebar = parseNeighbors(o.moreProfiles);
  const neighbors = usableNeighbors(sidebar);

  return {
    slug,
    name,
    headline: str(o.headline),
    location,
    region,
    countryCode,
    about: str(o.about),
    url: str(o.linkedinUrl) || profileUrl(slug),
    gradYear: inferGradYear(educations),
    // A row naming a degree or a field but no school is still a real education
    // record. Requiring a school name deleted it outright.
    educations: educations.filter((e) => e.school || e.degree || e.field),
    honors: honors.filter((h) => h.title),
    projects: projects.filter((p) => p.title),
    volunteering: volunteering.filter((v) => v.role),
    experience: experience.filter((e) => e.title),
    skills: nameList(o.skills, "name"),
    certifications: nameList(o.certifications, "title"),
    languages: nameList(o.languages, "language"),
    publications: nameList(o.publications, "title"),
    patents: nameList(o.patents, "title"),
    courses: nameList(o.courses, "name"),
    featured: featuredLinks(o.featured),
    recommendations: nameList(o.receivedRecommendations, "text"),
    currentPosition: currentPositionText(o.currentPosition) || undefined,
    followerCount: num(o.followerCount),
    connectionsCount: num(o.connectionsCount),
    status: str(o.status) || undefined,
    registeredAt: str(o.registeredAt) || undefined,
    neighbors,
    neighborsDropped: sidebar.length - neighbors.length,
    discoveredVia,
    enrichedAt: new Date().toISOString(),
  };
}

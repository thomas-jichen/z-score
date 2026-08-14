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
import { profileUrl, toSlug } from "./enrichment";

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

/** One run's batch ceiling. Beyond this, split into several runs. */
export const MAX_PROFILES_PER_RUN = 250;

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
    return { ok: true, items: Array.isArray(items) ? items : [] };
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
        degree: "High School Diploma",
        startDate: { year: gradYear - 4 },
        endDate: { year: gradYear },
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
        startDate: { year: gradYear - 1 },
      },
    ],
    skills: [{ name: "Python" }, { name: "PyTorch" }],
    certifications: [],
    languages: [],
    publications: [],
    patents: [],
    // Deterministic fan-out so hop expansion is testable and repeatable.
    moreProfiles: Array.from({ length: 3 + (seed % 4) }, (_, i) => ({
      id: `ACoAA${seed}${i}`,
      firstName: "Neighbor",
      lastName: `${i + 1}`,
      position: "Student",
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
  const ends = educations.map((e) => e.endYear).filter((y): y is number => y !== undefined);
  if (ends.length > 0) return Math.max(...ends);

  const starts = educations.map((e) => e.startYear).filter((y): y is number => y !== undefined);
  if (starts.length > 0) return Math.max(...starts) + 4;

  return undefined;
}

function parseNeighbors(v: unknown): Neighbor[] {
  return arr(v)
    .map((raw) => {
      const o = (raw ?? {}) as Record<string, unknown>;
      const slug =
        toSlug(str(o.publicIdentifier)) ?? toSlug(str(o.linkedinUrl)) ?? null;
      if (!slug) return null;

      const name = [str(o.firstName), str(o.lastName)].filter(Boolean).join(" ");
      return {
        slug,
        name: name || slug,
        position: str(o.position),
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
    return {
      title: str(x.position) || str(x.title),
      company: str(x.companyName) || undefined,
      description: str(x.description) || undefined,
      startYear: yearOf(x.startDate as RawDate),
      endYear: yearOf(x.endDate as RawDate),
    };
  });

  // Verified against a real payload: location is an object carrying both the
  // display string and a `parsed` block with a structured region code.
  const { location, region } = (() => {
    const l = o.location;
    if (typeof l === "string") return { location: l.trim(), region: undefined };
    if (l && typeof l === "object") {
      const obj = l as Record<string, unknown>;
      const parsed = (obj.parsed ?? {}) as Record<string, unknown>;
      return {
        location: str(obj.linkedinText),
        region: str(parsed.regionCode) || undefined,
      };
    }
    return { location: "", region: undefined };
  })();

  const name =
    [str(o.firstName), str(o.lastName)].filter(Boolean).join(" ") || str(o.name) || slug;

  return {
    slug,
    name,
    headline: str(o.headline),
    location,
    region,
    about: str(o.about),
    url: str(o.linkedinUrl) || profileUrl(slug),
    gradYear: inferGradYear(educations),
    educations: educations.filter((e) => e.school),
    honors: honors.filter((h) => h.title),
    projects: projects.filter((p) => p.title),
    volunteering: volunteering.filter((v) => v.role),
    experience: experience.filter((e) => e.title),
    skills: nameList(o.skills, "name"),
    certifications: nameList(o.certifications, "title"),
    languages: nameList(o.languages, "language"),
    publications: nameList(o.publications, "title"),
    patents: nameList(o.patents, "title"),
    followerCount: num(o.followerCount),
    connectionsCount: num(o.connectionsCount),
    registeredAt: str(o.registeredAt) || undefined,
    neighbors: parseNeighbors(o.moreProfiles),
    discoveredVia,
    enrichedAt: new Date().toISOString(),
  };
}

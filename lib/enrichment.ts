import { extractSlug } from "./search";

/**
 * The vendor-neutral shape everything downstream reads.
 *
 * Nothing outside lib/apify.ts knows what HarvestAPI's payload looks like.
 * Swapping to Bright Data — which also exposes People Also Viewed, at roughly a
 * quarter the price, and is the right move above ~100k profiles/month — should
 * mean rewriting one parse function, not touching the UI.
 */

/** A neighbour from the People Also Viewed sidebar. Cheap: no scrape needed. */
export type Neighbor = {
  slug: string;
  name: string;
  position: string;
  url: string;
};

export type Education = {
  school: string;
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
  /** Long-form and often the richest text on a profile. Worth matching against. */
  description?: string;
  startYear?: number;
  endYear?: number;
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
  followerCount?: number;
  connectionsCount?: number;
  /** When the account was created. Joining at 14 is itself a signal. */
  registeredAt?: string;
  /** People Also Viewed. The expansion primitive for the seed path. */
  neighbors: Neighbor[];
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
export function nextHop(
  profiles: EnrichedProfile[],
  known: Set<string>
): { slug: string; seedSlug: string; seedName: string }[] {
  const out: { slug: string; seedSlug: string; seedName: string }[] = [];
  const picked = new Set<string>();

  for (const p of profiles) {
    for (const n of p.neighbors) {
      if (!n.slug || known.has(n.slug) || picked.has(n.slug)) continue;
      picked.add(n.slug);
      out.push({ slug: n.slug, seedSlug: p.slug, seedName: p.name });
    }
  }
  return out;
}

/** Highest-signal award first, for the one-line summary in list views. */
export function topHonor(profile: EnrichedProfile): string | undefined {
  return profile.honors[0]?.title;
}

/** Most recent school, which for a student is the one that matters. */
export function currentSchool(profile: EnrichedProfile): string | undefined {
  const sorted = [...profile.educations].sort((a, b) => (b.endYear ?? 0) - (a.endYear ?? 0));
  return sorted[0]?.school;
}

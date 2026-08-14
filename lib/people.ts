import type { EnrichedProfile, HopCandidate, Provenance } from "./enrichment";
import { currentSchool, profileUrl, usableNeighbors } from "./enrichment";
import { inferYear } from "./search";
import type { Hit } from "./types";
import type { Archetype } from "./clusters";

/**
 * One record per person, replacing the old split between `Hit` (search) and
 * `EnrichedProfile` (Apify) where only the second could enter the queue.
 *
 * ── What lives here and what does not ─────────────────────────────────────
 * The roster is team-shared, so **queue state is not on Person** — pinning and
 * rejecting are per-viewer and live in `PersonMark`. Otherwise Grace rejecting
 * someone would delete them out of Cory's queue.
 *
 * Tags are split the same way, by whether they can be recomputed:
 *
 *   stored    searchLabels    which chips surfaced them, fixed at discovery
 *             extractedTerms  what the LLM read off the profile
 *   derived   taxonomy matches, school, class year, state
 *
 * Derived tags are recomputed on every render from lib/tags.ts, so retuning
 * the taxonomy immediately re-tags and re-ranks everyone. Storing them would
 * mean a stale copy per person and a migration on every taxonomy edit.
 */

export type PersonStatus = "queued" | "known" | "rejected";

/** Team-shared. One hash field per person, keyed by slug. */
export type Person = {
  /** Canonical, from extractSlug. The only safe dedupe key; names collide. */
  slug: string;
  name: string;
  headline: string;
  url: string;
  /** SERP snippet. The only free text a search-only person has. */
  snippet?: string;
  /** Class year stated in the snippet or headline, before enrichment confirms it. */
  inferredYear?: string;
  /**
   * The chips that built the query that found them. `confirmed` is whether the
   * term actually appears in their title or snippet — an OR group never says
   * which branch matched, so an unconfirmed label is a hypothesis, not a fact.
   */
  searchLabels: { label: string; confirmed: boolean }[];
  discoveredVia: Provenance;
  /** Present once Apify has run. Absent means search-only, not lower quality. */
  enriched?: EnrichedProfile;
  /** Normalised credential names the LLM read out of free text. */
  extractedTerms?: string[];
  /** Terms added by hand, for something the tagger missed. Promotable like any other. */
  manualTerms?: string[];
  /** When the tagger last ran, so it is not paid for twice. */
  taggedAt?: string;
  location?: string;
  /** Two-letter region from location.parsed.regionCode. Used to cluster the graph. */
  state?: string;
  school?: string;
  gradYear?: number;
  /** Set by hand on the queue or detail screen. Always beats the computed label. */
  clusterOverride?: Archetype | null;
  addedAt: string;
  updatedAt: string;
};

/** Per viewer. Never shared. */
export type PersonMark = {
  status: PersonStatus;
  pinned?: boolean;
  note?: string;
  at: string;
};

export type Roster = Record<string, Person>;
export type Marks = Record<string, PersonMark>;

/**
 * Both terminal states suppress a person from future sweeps, so removing
 * someone actually means something. `known` is kept separate from `rejected`
 * on purpose: "this sweep surfaced 8 people Cory already rates" is evidence the
 * tool works, and folding it into delete throws that away.
 */
export function isSuppressed(mark: PersonMark | undefined): boolean {
  return mark?.status === "known" || mark?.status === "rejected";
}

export function suppressionReason(mark: PersonMark | undefined): string | null {
  if (mark?.status === "known") return "already known";
  if (mark?.status === "rejected") return "rejected earlier";
  return null;
}

const now = () => new Date().toISOString();

/** A search hit, queued on SERP data alone. No Apify call, nothing spent. */
export function personFromHit(
  hit: Hit,
  opts: { query: string; labels: { label: string; confirmed: boolean }[] }
): Person {
  const t = now();
  return {
    slug: hit.slug,
    name: hit.name || hit.slug,
    headline: hit.headline ?? "",
    url: hit.url || profileUrl(hit.slug),
    snippet: hit.snippet || undefined,
    inferredYear: hit.inferredYear,
    searchLabels: opts.labels,
    discoveredVia: { kind: "serp", query: opts.query },
    addedAt: t,
    updatedAt: t,
  };
}

/**
 * A hand-supplied seed or a neighbour, known only by slug until enrichment.
 *
 * A neighbour arrives with a name and a position already, so `seed` carries them
 * through. Without it a queued neighbour is written into the shared roster as a
 * bare slug with no headline, and every teammate sees that until someone pays to
 * enrich them.
 */
export function personFromSlug(
  slug: string,
  via: Provenance,
  seed?: { name?: string; headline?: string }
): Person {
  const t = now();
  return {
    slug,
    name: seed?.name || slug,
    headline: seed?.headline ?? "",
    url: profileUrl(slug),
    searchLabels: [],
    discoveredVia: via,
    addedAt: t,
    updatedAt: t,
  };
}

/**
 * Fold an enrichment result into an existing record, or create one.
 *
 * Upgrading in place is what makes "add to queue now, enrich later" work: the
 * headline, grad year, honors and school flow through to the queue, graph and
 * digest without the person being re-added or losing their marks. Discovery
 * provenance is never overwritten — which path found them *first* is the thing
 * worth knowing, and it is what the graph draws.
 */
export function withEnriched(existing: Person | undefined, profile: EnrichedProfile): Person {
  const base =
    existing ??
    personFromSlug(profile.slug, profile.discoveredVia, {
      name: profile.name,
      headline: profile.headline,
    });
  return {
    ...base,
    name: profile.name || base.name,
    headline: profile.headline || base.headline,
    url: profile.url || base.url,
    location: profile.location || base.location,
    state: profile.region || base.state,
    school: currentSchool(profile) ?? base.school,
    gradYear: profile.gradYear ?? base.gradYear,
    enriched: profile,
    updatedAt: now(),
  };
}

/** Every field of free text a term could plausibly appear in, richest first. */
export function textOf(p: Person): string {
  const e = p.enriched;
  if (!e) return [p.headline, p.snippet].filter(Boolean).join(" ");

  return [
    e.headline,
    e.about,
    ...e.honors.map((h) => [h.title, h.issuedBy, h.description, h.associatedWith].filter(Boolean).join(" ")),
    ...e.projects.map((x) => [x.title, x.description].filter(Boolean).join(" ")),
    ...e.volunteering.map((v) => [v.role, v.organization].filter(Boolean).join(" ")),
    ...e.educations.map((x) => [x.school, x.degree, x.field].filter(Boolean).join(" ")),
    // Experience descriptions are long-form and were previously ignored
    // entirely, which threw away the richest text on a populated profile.
    ...e.experience.map((x) => [x.title, x.company, x.description].filter(Boolean).join(" ")),
    ...e.publications,
    ...e.patents,
    ...e.certifications,
    p.snippet ?? "",
  ]
    .filter(Boolean)
    .join(" \n ");
}

/** Highest-signal award first, for the one-line summary in list views. */
export function topHonorOf(p: Person): string | undefined {
  return p.enriched?.honors[0]?.title;
}

/**
 * Next hop: every neighbour of the given people that has not been seen.
 *
 * `known` covers everyone already in the roster, so a hop never re-pays for
 * someone already held. People Also Viewed is a co-view model, not a similarity
 * model — it reports who browsers looked at in the same session — so the seed
 * attribution travels with each neighbour, which is what makes drift measurable
 * rather than a guess.
 */
export function nextHopFrom(people: Person[], known: Set<string>): HopCandidate[] {
  const out: HopCandidate[] = [];
  const picked = new Set<string>();

  for (const p of people) {
    // The same cut as at parse time, applied again on read, so the twenty-entry
    // records stored before the tail was understood are cleaned up without
    // paying to enrich anyone twice.
    for (const n of usableNeighbors(p.enriched?.neighbors ?? [])) {
      if (!n.slug || known.has(n.slug) || picked.has(n.slug)) continue;
      picked.add(n.slug);
      // The neighbour's own name and position travel with it. Projecting just
      // the slug here is what left the review table showing bare usernames.
      //
      // The year is inferred on read when the stored record has none, so
      // profiles enriched before it was parsed still fill the class column.
      out.push({
        ...n,
        year: n.year ?? inferYear(n.position),
        seedSlug: p.slug,
        seedName: p.name,
      });
    }
  }
  return out;
}

/** One person's neighbours, minus anyone already held. The per-person reveal. */
export function neighborsFrom(person: Person, known: Set<string>): HopCandidate[] {
  return nextHopFrom([person], known);
}

/**
 * Which hop a neighbour of this person sits at.
 *
 * Read off the surfacing person's own provenance rather than counted on a page,
 * so an expansion records the truth no matter which screen it was started from.
 * Capped at what the enrich route accepts.
 */
export function hopAfter(person: Person | undefined): number {
  const via = person?.discoveredVia;
  return Math.min((via?.kind === "pav" ? via.hop : 0) + 1, 5);
}

export const MAX_PEOPLE = 2000;

/**
 * Roster cap. Enriched profiles run several KB each, so without a bound the
 * store eventually rejects a write and every save fails at once rather than
 * degrading. Oldest additions drop first, and anyone pinned or enriched is
 * kept ahead of a search-only record.
 */
export function capRoster(roster: Roster, marks: Marks = {}): Roster {
  const entries = Object.entries(roster ?? {});
  if (entries.length <= MAX_PEOPLE) return roster ?? {};

  const keepScore = (p: Person) =>
    (marks[p.slug]?.pinned ? 2 : 0) + (p.enriched ? 1 : 0);

  entries.sort((a, b) => {
    const k = keepScore(b[1]) - keepScore(a[1]);
    if (k !== 0) return k;
    return (b[1]?.addedAt ?? "").localeCompare(a[1]?.addedAt ?? "");
  });

  return Object.fromEntries(entries.slice(0, MAX_PEOPLE));
}

/* ── Migration ──────────────────────────────────────────────────────────── */

type LegacyRating = "interested" | "not_interested" | "already_know";

/**
 * The old shape: one document per teammate, holding `candidates` keyed by slug
 * plus a flat `ratings` map. Enriched profiles become team-shared people;
 * ratings become that teammate's own marks.
 */
export function migrateLegacy(legacy: {
  candidates?: Record<string, EnrichedProfile>;
  ratings?: Record<string, LegacyRating>;
}): { roster: Roster; marks: Marks } {
  const roster: Roster = {};
  const marks: Marks = {};

  for (const [slug, profile] of Object.entries(legacy.candidates ?? {})) {
    if (!profile?.slug) continue;
    roster[slug] = withEnriched(undefined, profile);
    // Everything already enriched was, by the old model, in the queue.
    roster[slug].addedAt = profile.enrichedAt ?? now();
    marks[slug] = { status: "queued", at: roster[slug].addedAt };
  }

  for (const [slug, rating] of Object.entries(legacy.ratings ?? {})) {
    const status: PersonStatus =
      rating === "already_know" ? "known" : rating === "not_interested" ? "rejected" : "queued";
    marks[slug] = { ...(marks[slug] ?? { at: now() }), status };
  }

  return { roster, marks };
}

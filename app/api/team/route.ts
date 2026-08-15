import { NextResponse } from "next/server";
import { resolveProfile } from "@/lib/auth";
import { isArchetype, type Archetype } from "@/lib/clusters";
import {
  TEAM_KEY,
  emptyTeam,
  hydrateTeam,
  mergeTeam,
  type CustomTerms,
  type TaxonomyPrefs,
  type TeamState,
} from "@/lib/state";
import { COUNT_KINDS } from "@/lib/extract";
import {
  MAX_TAGS,
  TAG_FACETS,
  clampWeight,
  isTagFacet,
  normalizeKey,
  tagId,
  type TagDef,
  type TagRegistry,
} from "@/lib/tagRegistry";
import { migrateIfNeeded, readTeam } from "@/lib/serverState";
import { get, set } from "@/lib/store";
import { isBad, readJson, str, strList } from "@/lib/validate";
import { log } from "@/lib/log";

/**
 * The team's shared tuning: taxonomy weights, cluster assignments, the promote
 * and dismiss lists, and the custom search menu options.
 *
 * Shared rather than per-teammate because a split scoring model would give one
 * person three different z-scores depending on who was looking, which defeats
 * the point of a shared ranked list.
 *
 * Both halves sit in one small document. They have different writers — the sweep
 * screen adds custom terms, the taxonomy screen changes weights — so a write is
 * read-modify-write with a field-level merge. At three users and a few KB the
 * race is not worth a second key.
 */

const MAX_TERMS = 500;
const MAX_MENU_ITEMS = 200;
const TERM_LEN = 80;

export async function GET() {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  try {
    await migrateIfNeeded();
    return NextResponse.json({ ok: true, team: await readTeam() });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Store read failed." },
      { status: 500 }
    );
  }
}

export async function PATCH(req: Request) {
  const r = await resolveProfile();
  if ("error" in r) return NextResponse.json({ ok: false, error: r.error }, { status: r.status });

  const body = await readJson<Partial<TeamState>>(req);
  if (isBad(body)) return NextResponse.json({ ok: false, error: body.error }, { status: body.status });

  const patch: Partial<TeamState> = {};
  if (body.taxonomy) patch.taxonomy = cleanTaxonomy(body.taxonomy);
  if (body.customTerms) patch.customTerms = cleanTerms(body.customTerms);

  if (!patch.taxonomy && !patch.customTerms) {
    return NextResponse.json({ ok: false, error: "Nothing to change." }, { status: 400 });
  }

  try {
    await migrateIfNeeded();
    const current = hydrateTeam(await get<Partial<TeamState>>(TEAM_KEY));
    const next = mergeTeam(current, patch);
    await set(TEAM_KEY, next);

    if (patch.taxonomy) {
      log.info("team.taxonomy", {
        weights: Object.keys(next.taxonomy.weights).length,
        promoted: next.taxonomy.promoted.length,
        dismissed: next.taxonomy.dismissed.length,
      });
    }
    return NextResponse.json({ ok: true, team: next });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : "Store write failed." },
      { status: 500 }
    );
  }
}

/* ── Validation ─────────────────────────────────────────────────────────── */

/**
 * Weights are clamped rather than rejected, and clusters are checked against the
 * real cluster ids so a stale client cannot write "polymath" back into the
 * table — it stopped being a cluster and became a badge.
 */
function cleanTaxonomy(raw: Partial<TaxonomyPrefs>): TaxonomyPrefs {
  const base = emptyTeam().taxonomy;

  const weights: Record<string, number> = {};
  for (const [term, value] of Object.entries(raw.weights ?? {}).slice(0, MAX_TERMS)) {
    const n = Number(value);
    if (!term || term.length > TERM_LEN || !Number.isFinite(n)) continue;
    weights[term] = clampWeight(n);
  }

  const clusters: Record<string, Archetype | null> = {};
  for (const [term, value] of Object.entries(raw.clusters ?? {}).slice(0, MAX_TERMS)) {
    if (!term || term.length > TERM_LEN) continue;
    clusters[term] = isArchetype(value) ? value : null;
  }

  /**
   * The registry is the shared, scoring-bearing document, so it is validated
   * field by field. A client cannot invent a facet, exceed the weight ceiling, or
   * write an id that disagrees with its own label — the id is recomputed here
   * rather than trusted, so alias resolution cannot be subverted from outside.
   *
   * An absent `tags` means "not part of this patch", not "empty". Falling through
   * to `{}` would let a taxonomy edit that happened not to include the registry
   * wipe the whole seeded vocabulary: a silent, total loss of calibration on an
   * unrelated slider drag.
   */
  const tags: TagRegistry = raw.tags === undefined ? base.tags : {};
  for (const value of Object.values(raw.tags ?? {}).slice(0, MAX_TAGS)) {
    const def = (value ?? {}) as Partial<TagDef>;
    const label = str(def.label, TERM_LEN).trim();
    if (!label || !isTagFacet(def.facet)) continue;
    // Recomputed rather than trusted, so a client cannot write an id that
    // disagrees with its own label. Must use the same rule as the registry: the
    // geography facets hold the same fifty labels, so their keys carry the facet,
    // and computing a bare key here silently merged "California the current state"
    // with "California the home state".
    const id = tagId(label, def.facet);
    if (!id || tags[id]) continue;
    tags[id] = {
      id,
      label,
      facet: def.facet,
      aliases: [
        ...new Set(strList(def.aliases, 40, TERM_LEN).map(normalizeKey)),
      ].filter((a) => a && a !== id),
      weight: clampWeight(Number(def.weight)),
      cluster: isArchetype(def.cluster) ? def.cluster : null,
      ...(str(def.linkedinId, 120) ? { linkedinId: str(def.linkedinId, 120) } : {}),
      // A school's state, which is what makes a home state knowable. Dropping it
      // here would have quietly emptied every home state on the next save.
      ...(str(def.state, 60) ? { state: str(def.state, 60) } : {}),
      promoted: def.promoted === true,
    };
  }

  const counts = { ...base.counts };
  for (const kind of COUNT_KINDS) {
    const rule = raw.counts?.[kind];
    if (!rule) continue;
    counts[kind] = {
      points: clampWeight(Number(rule.points)),
      // A cap of zero would mean "never count this", which `points: 0` already
      // says more clearly, so the floor is one.
      cap: Math.min(Math.max(Math.round(Number(rule.cap) || 0), 1), 50),
    };
  }

  const bandOf = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(Math.max(Math.round(n * 10) / 10, 0), 500) : fallback;
  };

  const facetDefaults = { ...base.facetDefaults };
  for (const facet of TAG_FACETS) {
    const v = raw.facetDefaults?.[facet];
    if (v !== undefined) facetDefaults[facet] = clampWeight(Number(v));
  }

  return {
    weights,
    clusters,
    promoted: strList(raw.promoted, MAX_TERMS, TERM_LEN),
    dismissed: strList(raw.dismissed, MAX_TERMS * 2, TERM_LEN),
    tags,
    counts,
    polymathPoints: bandOf(raw.polymathPoints, base.polymathPoints),
    facetDefaults,
    bands: {
      exceptional: bandOf(raw.bands?.exceptional, base.bands.exceptional),
      strong: bandOf(raw.bands?.strong, base.bands.strong),
      above: bandOf(raw.bands?.above, base.bands.above),
      mid: bandOf(raw.bands?.mid, base.bands.mid),
    },
  };
}

function cleanTerms(raw: Partial<CustomTerms>): CustomTerms {
  return {
    programs: strList(raw.programs, MAX_MENU_ITEMS, TERM_LEN),
    titles: strList(raw.titles, MAX_MENU_ITEMS, TERM_LEN),
    colleges: strList(raw.colleges, MAX_MENU_ITEMS, TERM_LEN),
    highSchools: strList(raw.highSchools, MAX_MENU_ITEMS, TERM_LEN),
    years: strList(raw.years, 40, 8),
    states: strList(raw.states, MAX_MENU_ITEMS, TERM_LEN),
    homeStates: strList(raw.homeStates, MAX_MENU_ITEMS, TERM_LEN),
  };
}

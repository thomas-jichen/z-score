import { isArchetype, type Archetype } from "./clusters";
import { toSlug } from "./enrichment";
import { COUNT_KINDS } from "./extract";
import {
  MAX_DELETED,
  SEED_VERSION,
  emptyTeam,
  type CustomTerms,
  type TaxonomyPrefs,
} from "./state";
import {
  MAX_TAGS,
  TAG_FACETS,
  clampWeight,
  isTagFacet,
  tagId,
  usableAliases,
  type TagDef,
  type TagFacet,
  type TagRegistry,
} from "./tagRegistry";
import { str, strList } from "./validate";

/**
 * Validation for the shared team document.
 *
 * Lifted out of the route handler it used to live in, for one reason: nothing could
 * test it there. `cleanTaxonomy` rebuilds the document field by field, so a field it
 * forgets is a field the save deletes — and it silently forgot `seedVersion`, which
 * would have re-run a one-time weight recalibration on every read after every save,
 * overwriting the tuning the client had just sent. That is a domain rule about a
 * shared document, not a detail of HTTP, and it belongs where it can be checked.
 */

const MAX_TERMS = 500;
const MAX_MENU_ITEMS = 200;
const TERM_LEN = 80;

/**
 * Weights are clamped rather than rejected, and clusters are checked against the
 * real cluster ids so a stale client cannot write "polymath" back into the
 * table — it stopped being a cluster and became a badge.
 */
export function cleanTaxonomy(raw: Partial<TaxonomyPrefs>): TaxonomyPrefs {
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
      // Through the shared filter, so a client cannot save back an alias that means
      // nothing on its own — including one an older document is still carrying.
      aliases: usableAliases(strList(def.aliases, 40, TERM_LEN), id),
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
    /**
     * Anything the server hands out is already at the current seed generation, so
     * anything coming back is too.
     *
     * Stated rather than copied from the request, and it has to be here at all: this
     * function rebuilds the document field by field, so an omitted field is a deleted
     * field. Dropping the marker would have re-run the one-time recalibration on the
     * next read — overwriting the weights the client had just finished tuning, on
     * every save.
     */
    seedVersion: SEED_VERSION,
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

/**
 * The blocklist, normalised through the same slug rule as everything else.
 *
 * A slug is the only safe key here: comparing what someone typed against what a SERP
 * returned would let one trailing slash undo a deletion. Newest last, so the cap
 * evicts the oldest — a slug deleted long ago is one nothing is still trying to
 * re-add.
 */
export function cleanDeleted(raw: unknown): string[] {
  // Trimmed from the front before validating, not after. `strList` stops once it has
  // its quota, so capping there would keep the *oldest* entries and silently drop
  // every deletion made after the list filled up.
  const tail = Array.isArray(raw) ? raw.slice(-MAX_DELETED) : raw;
  const list = strList(tail, MAX_DELETED, 200)
    .map((s) => toSlug(s))
    .filter((s): s is string => Boolean(s));
  return [...new Set(list)];
}

export function cleanTerms(raw: Partial<CustomTerms>): CustomTerms {
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

/* ── Automatic promotion ────────────────────────────────────────────────── */

/**
 * The bar a classification has to clear to enter the vocabulary unattended.
 *
 * Two conditions, both necessary. The model has to say it recognised the thing, and
 * the thing has to be worth something — a confident 0.0 is a confident "this is
 * noise", which is a reason to leave it out, not to add it at zero.
 */
export function worthPromoting(c: { sure: boolean; weight: number; facet: TagFacet | null }): boolean {
  return c.sure && c.weight >= AUTO_PROMOTE_FLOOR && c.facet !== null;
}

/**
 * Below this, a tag would not change any ranking and is not worth a row.
 *
 * Set at the activity tier rather than at zero on purpose: the review queue is the
 * right home for anything marginal, and a screen full of 0.2 rows nobody chose is how
 * a taxonomy stops being read.
 */
export const AUTO_PROMOTE_FLOOR = 0.5;

/**
 * Fold newly classified tags into a registry.
 *
 * Never overwrites: a label already present keeps whatever the team set, because the
 * whole point of the taxonomy screen is that a human's number wins. Returns the same
 * object when nothing was added, so callers can skip the write.
 */
export function withPromoted(
  tags: TagRegistry,
  additions: { label: string; facet: TagFacet; weight: number; cluster: Archetype | null }[]
): TagRegistry {
  let changed = false;
  const next = { ...tags };
  for (const a of additions) {
    const id = tagId(a.label, a.facet);
    if (!id || next[id]) continue;
    next[id] = {
      id,
      label: a.label,
      facet: a.facet,
      aliases: [],
      weight: clampWeight(a.weight),
      cluster: a.cluster,
      promoted: true,
    };
    changed = true;
  }
  return changed ? next : tags;
}

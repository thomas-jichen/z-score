import type { Archetype } from "./clusters";

/**
 * The tag registry: one definition per real-world thing, shared by the team.
 *
 * ── Why a registry and not a list of strings ──────────────────────────────
 * The old model kept a flat `string[]` of promoted terms and compared them with
 * `toLowerCase()`. That handles exactly one kind of variance — capitalisation —
 * so "Coca-Cola Scholarship Recipient", "Coca-Cola Scholar" and "Coke Scholar"
 * could all coexist as three separate entries with three separate weights, and a
 * profile supporting two of them scored twice for one award.
 *
 * A registry entry owns its aliases, so once a spelling is resolved it stays
 * resolved. Resolution is deterministic first and only asks a model about labels
 * nothing else could settle:
 *
 *   1. `linkedinId`  — LinkedIn's own company/school id. Exact, no strings.
 *   2. `normalizeKey` — case, accents, punctuation, "&"/"and", and the noise
 *                       words that make one award read as three.
 *   3. `similarity`   — a cheap bigram score. Does not auto-merge; it flags a
 *                       candidate as a possible duplicate for a human.
 *   4. the model      — asked once per genuinely new label, never per person.
 *
 * Steps 1 and 2 need no model and cover most of the traffic. Step 3 deliberately
 * refuses to decide: a wrong auto-merge is unrecoverable, because the distinction
 * it destroyed is gone from the data.
 */

/**
 * College and high school are separate facets rather than one "school".
 *
 * They are different questions — "which university" and "which feeder school" —
 * they carry very different weights, and the sweep menus have always offered them
 * as two lists. Collapsing them would have merged those menus.
 */
export const TAG_FACETS = [
  "program",
  "award",
  "company",
  "org",
  "college",
  "highschool",
  "major",
  "title",
  "flag",
  "count",
  "year",
  "state",
] as const;

export type TagFacet = (typeof TAG_FACETS)[number];

export function isTagFacet(v: unknown): v is TagFacet {
  return typeof v === "string" && (TAG_FACETS as readonly string[]).includes(v);
}

export type TagDef = {
  /** Canonical key, from `normalizeKey(label)`. Stable across relabelling. */
  id: string;
  label: string;
  facet: TagFacet;
  /** Normalised keys that resolve here. Never includes `id` itself. */
  aliases: string[];
  /** 0.0 to 5.0. Only counts once `promoted` is true. */
  weight: number;
  cluster: Archetype | null;
  /** LinkedIn company/school id, when the vendor gave one. */
  linkedinId?: string;
  /**
   * False means "we know about it and it shows on the profile, but it scores
   * zero". Nothing enters the score without someone saying so.
   */
  promoted: boolean;
};

export type TagRegistry = Record<string, TagDef>;

/** Bounds the shared document. Far above any realistic vocabulary. */
export const MAX_TAGS = 4000;
export const MIN_WEIGHT = 0;
export const MAX_WEIGHT = 5;

export function clampWeight(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(Math.round(n * 10) / 10, MIN_WEIGHT), MAX_WEIGHT);
}

/* ── Normalisation ──────────────────────────────────────────────────────── */

/**
 * Noise words stripped before comparing.
 *
 * These are the words that make one credential read as several. A profile writes
 * "Coca-Cola Scholarship Recipient" where the taxonomy says "Coca-Cola Scholar";
 * both reduce to "coca cola". Company suffixes do the same job for "McKinsey &
 * Company" against "McKinsey".
 *
 * Kept deliberately short. Every word here is one that cannot distinguish two
 * real things on its own — "Fellow" is dropped, but "Fellowship" alone would
 * never have been a tag, so nothing is lost.
 */
const NOISE = new Set([
  "the",
  "a",
  "an",
  "of",
  "and",
  "inc",
  "llc",
  "ltd",
  "corp",
  "corporation",
  "company",
  "co",
  "group",
  "foundation",
  "institute",
  "university",
  "univ",
  "college",
  "school",
  "program",
  "programme",
  "scholarship",
  "scholarships",
  "recipient",
  "award",
  "awards",
  "awardee",
  "winner",
  "finalist",
  "semifinalist",
  "qualifier",
  "fellow",
  "fellowship",
  "scholar",
  "member",
  "cohort",
  "national",
  "international",
]);

/**
 * Fold a label to a comparison key.
 *
 * Accents are stripped so "Peña" and "Pena" agree. "&" becomes "and" before the
 * noise pass removes it, so "McKinsey & Company" and "McKinsey and Co" converge.
 * Digits are kept, because "USACO Platinum 2025" and "USACO Platinum" are
 * genuinely different things to some teams and collapsing years silently would
 * be a decision, not a normalisation.
 */
export function normalizeKey(label: string): string {
  const folded = label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

  const kept = folded.split(" ").filter((w) => w && !NOISE.has(w));
  // A label made entirely of noise words still needs a key. "Scholar" alone is
  // not a useful tag, but it must not collide with every other such label.
  return (kept.length > 0 ? kept : folded.split(" ").filter(Boolean)).join("-");
}

/* ── Similarity ─────────────────────────────────────────────────────────── */

function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2));
  return out;
}

/**
 * Sørensen-Dice on character bigrams. 1 is identical, 0 shares nothing.
 *
 * Chosen over edit distance because it is order-insensitive at the token level,
 * so "Stanford ASES" and "ASES Stanford" score high, and because it needs no
 * dependency — this repo ships none at runtime.
 *
 * It catches typos and word-order differences. It does not catch synonyms:
 * "coke" against "coca cola" scores about 0.18. That is the honest limit of any
 * string method, and the reason step 4 exists.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1;
  const A = bigrams(a);
  const B = bigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const g of A) if (B.has(g)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** Above this, two labels in one facet are treated as probably the same thing. */
export const NEAR_DUPLICATE = 0.82;

/* ── Resolution ─────────────────────────────────────────────────────────── */

export type Resolution =
  /** Settled. Use this definition. */
  | { kind: "exact"; def: TagDef }
  /** Nothing matched and nothing looks close. Safe to create. */
  | { kind: "new"; id: string }
  /**
   * Looks like an existing tag but not certainly. Not created and not merged —
   * it goes to the review queue, because collapsing two distinct awards cannot
   * be undone.
   */
  | { kind: "possible"; id: string; candidates: TagDef[] };

/** Index the registry once, rather than scanning it per lookup. */
export type RegistryIndex = {
  byKey: Map<string, TagDef>;
  byLinkedinId: Map<string, TagDef>;
  byFacet: Map<TagFacet, TagDef[]>;
};

export function indexRegistry(reg: TagRegistry): RegistryIndex {
  const byKey = new Map<string, TagDef>();
  const byLinkedinId = new Map<string, TagDef>();
  const byFacet = new Map<TagFacet, TagDef[]>();

  for (const def of Object.values(reg)) {
    byKey.set(def.id, def);
    for (const a of def.aliases) if (!byKey.has(a)) byKey.set(a, def);
    if (def.linkedinId) byLinkedinId.set(`${def.facet}:${def.linkedinId}`, def);
    const list = byFacet.get(def.facet);
    if (list) list.push(def);
    else byFacet.set(def.facet, [def]);
  }

  return { byKey, byLinkedinId, byFacet };
}

/**
 * Look a label up without caring what facet it is.
 *
 * For a term the tagger read out of prose, or a search chip, the facet is not
 * known — only the words are. Resolution is still exact: normalisation plus the
 * alias table, which is the whole point of having them.
 */
export function resolveAny(index: RegistryIndex, label: string): TagDef | null {
  const id = normalizeKey(label);
  return id ? index.byKey.get(id) ?? null : null;
}

export function resolveTag(
  index: RegistryIndex,
  input: { label: string; facet: TagFacet; linkedinId?: string }
): Resolution {
  // 1. Entity id. Exact by construction, so it wins outright.
  if (input.linkedinId) {
    const hit = index.byLinkedinId.get(`${input.facet}:${input.linkedinId}`);
    if (hit) return { kind: "exact", def: hit };
  }

  const id = normalizeKey(input.label);
  if (!id) return { kind: "new", id };

  // 2. Canonical key, including aliases. A facet-qualified key would be more
  // precise, but the same normalised name across two facets is nearly always the
  // same institution wearing two hats (Stanford the school, Stanford the org),
  // and forcing those apart produced duplicate nodes in the graph.
  const byKey = index.byKey.get(id);
  if (byKey && byKey.facet === input.facet) return { kind: "exact", def: byKey };

  // 3. Near matches inside the same facet only. Across facets a high score is
  // meaningless: "Analyst" the title and "Analysis" the major are unrelated.
  const peers = index.byFacet.get(input.facet) ?? [];
  const candidates = peers
    .map((def) => ({
      def,
      score: Math.max(similarity(id, def.id), ...def.aliases.map((a) => similarity(id, a))),
    }))
    .filter((c) => c.score >= NEAR_DUPLICATE)
    .sort((a, b) => b.score - a.score)
    .map((c) => c.def);

  if (candidates.length > 0) return { kind: "possible", id, candidates };
  return { kind: "new", id };
}

/* ── Mutation ───────────────────────────────────────────────────────────── */

export function makeTag(input: {
  label: string;
  facet: TagFacet;
  weight?: number;
  cluster?: Archetype | null;
  linkedinId?: string;
  promoted?: boolean;
}): TagDef {
  return {
    id: normalizeKey(input.label),
    label: input.label.trim(),
    facet: input.facet,
    aliases: [],
    weight: clampWeight(input.weight ?? 0),
    cluster: input.cluster ?? null,
    ...(input.linkedinId ? { linkedinId: input.linkedinId } : {}),
    promoted: input.promoted ?? false,
  };
}

/**
 * Fold `from` into `into`: the surviving tag inherits every alias, and the merged
 * key becomes one of them so any stored reference still resolves.
 */
export function mergeTags(reg: TagRegistry, fromId: string, intoId: string): TagRegistry {
  const from = reg[fromId];
  const into = reg[intoId];
  if (!from || !into || fromId === intoId) return reg;

  const next = { ...reg };
  delete next[fromId];
  next[intoId] = {
    ...into,
    aliases: [...new Set([...into.aliases, from.id, ...from.aliases])].filter(
      (a) => a !== into.id
    ),
    // Keep whichever id we have; an entity id is stronger evidence than a string.
    linkedinId: into.linkedinId ?? from.linkedinId,
    // A merge must never quietly start scoring something that was held at zero.
    promoted: into.promoted,
  };
  return next;
}

/* ── Seeding ────────────────────────────────────────────────────────────── */

/**
 * Build the starting registry from the vocabulary that already exists.
 *
 * New tags score zero until promoted, which is the right default — but with
 * roughly thirty candidates arriving per person, a registry that starts empty
 * means several hundred promotions before any score means anything. Everything
 * seeded here was already hand-curated, so it arrives promoted with the weight it
 * already had. Only genuinely new things reach the review queue.
 */
export function seedRegistry(input: {
  programs: string[];
  colleges: string[];
  highSchools: string[];
  titles: { label: string; aliases?: string[] }[];
  majors: { label: string; aliases?: string[] }[];
  companies: { label: string; aliases?: string[] }[];
  startWeight: Record<string, number>;
  termCluster: Record<string, Archetype | null>;
  facetDefaults: Record<TagFacet, number>;
}): TagRegistry {
  const reg: TagRegistry = {};

  const add = (
    label: string,
    facet: TagFacet,
    aliases: string[] = [],
    weight?: number
  ) => {
    const id = normalizeKey(label);
    if (!id) return;
    const existing = reg[id];
    if (existing) {
      // Two seed lists naming the same thing (Jane Street is both a program and
      // a company) merge rather than collide. First list wins the facet.
      existing.aliases = [
        ...new Set([...existing.aliases, ...aliases.map(normalizeKey)]),
      ].filter((a) => a && a !== id);
      return;
    }
    reg[id] = {
      id,
      label,
      facet,
      aliases: [...new Set(aliases.map(normalizeKey))].filter((a) => a && a !== id),
      weight: clampWeight(weight ?? input.startWeight[label] ?? input.facetDefaults[facet]),
      cluster: input.termCluster[label] ?? null,
      promoted: true,
    };
  };

  for (const p of input.programs) add(p, "program");
  for (const c of input.colleges) add(c, "college");
  for (const h of input.highSchools) add(h, "highschool");
  for (const t of input.titles) add(t.label, "title", t.aliases);
  for (const m of input.majors) add(m.label, "major", m.aliases);
  for (const c of input.companies) add(c.label, "company", c.aliases);

  return reg;
}

/** Record that `label` is another spelling of an existing tag. */
export function addAlias(reg: TagRegistry, id: string, label: string): TagRegistry {
  const def = reg[id];
  const key = normalizeKey(label);
  if (!def || !key || key === def.id || def.aliases.includes(key)) return reg;
  return { ...reg, [id]: { ...def, aliases: [...def.aliases, key] } };
}

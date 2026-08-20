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
  /**
   * Programmes, competitions, olympiads, awards and scholarships — one facet.
   *
   * There used to be an `award` beside this and the line between them was never
   * real: a Palantir Meritocracy Fellowship and a Bank of America Student Leader
   * award are the same kind of thing as RSI, which is that somebody selective picked
   * you. Splitting them only ever produced two sections to look in and a coin flip
   * about which one a new tag landed in.
   */
  "program",
  /**
   * An accelerator, fellowship or fund that selected them — YC, a16z Speedrun,
   * Z Fellows, Thiel, Neo.
   *
   * Its own facet because it is neither a programme nor an employer, and filing it
   * as either lost it. As a programme it collided with the firm of the same name;
   * as a company it read as a job, and "Y Combinator" in the education section then
   * resolved as a *university*. Meanwhile the strongest form of the signal — a
   * company registered as "Willow (YC S24)" — matched nothing at all.
   *
   * It is also the signal this population is most about: professionals put money
   * down. That is a harder filter than any competition.
   */
  "accelerator",
  "company",
  /**
   * Three kinds of thing that were all being filed as "company", which is how a
   * profile like Jacob Lee's came out almost blank: Tech Lead of Stanford ASES,
   * researcher at the Stanford Multi-Robot Systems Lab, growth at Cluely and a
   * founding role at a YC company — none of it tagged, none of it weighted.
   *
   * They are separated because they are worth different amounts and are curated
   * differently. A lab is a named research group at a university; a club is a
   * selective student organisation, where the signal is usually the leadership role;
   * a startup is early-stage, where the signal is being there early at all.
   */
  "startup",
  "lab",
  "club",
  "org",
  "college",
  "highschool",
  "major",
  "title",
  "flag",
  "count",
  "year",
  /** Where they are now, from the LinkedIn location. */
  "state",
  /**
   * Where they are from, deduced from the high school. Separate from `state`
   * because they are different facts and frequently different answers: a Stanford
   * student from Georgia is both, and collapsing them loses the one that groups
   * them with their cohort.
   */
  "homestate",
] as const;

export type TagFacet = (typeof TAG_FACETS)[number];

export function isTagFacet(v: unknown): v is TagFacet {
  return typeof v === "string" && (TAG_FACETS as readonly string[]).includes(v);
}

/**
 * How a tag may be found in prose.
 *
 * `text` is free: the name is distinctive enough that seeing it is enough. `RSI`,
 * `TreeHacks`, `Y Combinator`.
 *
 * `qualified` needs the sentence around it to be talking about holding something.
 * For the names that are simultaneously a credential and an ordinary word: IMO the
 * olympiad and "imo" the opinion, Rise the fellowship and "the rise of
 * transformers", `primes` the programme and "twin primes" in a population of
 * mathematicians.
 *
 * `structured` is never read from prose at all, only from a school or an employer
 * the vendor already resolved to an entity. For the funds whose name is a plain
 * English word, and for the late-stage ones that appear in a student's text only
 * ever as somebody else's backer: Benchmark, Index, Battery, Accel, Greylock,
 * Antler, Sequoia. Davido Zhang carried Lightspeed +1.5 from "mentors from the
 * Lightspeed Studios", which is Tencent's game studio.
 */
export type TagMatch = "text" | "qualified" | "structured";

export function isTagMatch(v: unknown): v is TagMatch {
  return v === "text" || v === "qualified" || v === "structured";
}

/**
 * How far somebody got, strongest first.
 *
 * `normalizeKey` deletes every one of these words, which is right for a key and was
 * throwing away the answer to the only question that separates two people holding
 * the same credential. "Neo Scholar Finalist" reduced to `neo` and scored the full
 * 1.5 of being a Neo Scholar; "Coca Cola Scholarship Semi-Finalist" scored the full
 * 1.2 of the scholarship. Michael Yu and Andra Campos are both in the roster.
 *
 * The list is short on purpose. These are the rungs that recur across competitions
 * and fellowships, not every honour's private vocabulary — a ladder nobody can read
 * off a profile is a ladder nobody can price.
 */
export const TIERS = [
  "grand",
  "winner",
  "nationalTeam",
  "camper",
  "semifinalist",
  "finalist",
  "qualifier",
] as const;

export type Tier = (typeof TIERS)[number];

export function isTier(v: unknown): v is Tier {
  return typeof v === "string" && (TIERS as readonly string[]).includes(v);
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
   * Which US state a school is in. Only set on a college or high school, and the
   * only reliable source of a home state — an education record carries no
   * location and a school name rarely contains one.
   */
  state?: string;
  /**
   * False means "we know about it and it shows on the profile, but it scores
   * zero". Nothing enters the score without someone saying so.
   */
  promoted: boolean;
  /** How this may be read from prose. Absent means `text`. */
  match?: TagMatch;
  /**
   * What each rung is worth, absolutely, when the record says which one.
   *
   * Per tag rather than one shared ladder of multipliers, because clearing round one
   * of ISEF against 1,800 finalists is not the same kind of achievement as clearing
   * round one of a hackathon, and no single fraction is right for both. `weight`
   * stays the untiered figure: what the credential is worth when the text names it
   * and says nothing about how it went.
   */
  tiers?: Partial<Record<Tier, number>>;
};

export type TagRegistry = Record<string, TagDef>;

/** Bounds the shared document. Far above any realistic vocabulary. */
export const MAX_TAGS = 4000;
export const MIN_WEIGHT = 0;
/**
 * The ceiling on a single tag, and it is deliberately low.
 *
 * Nothing should be able to out-vote everything else. With the whole table repriced
 * so that the strongest person in a real roster lands near 10, a ceiling of 5 meant
 * two tags could account for a top score — and made the taxonomy slider spend most
 * of its travel in a range no tag should ever occupy. Two is the top of the scale
 * and the slider now has resolution across all of it.
 */
export const MAX_WEIGHT = 2;

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
  /**
   * `national` and `international` used to be here, and they were the single most
   * expensive words in the set.
   *
   * Stripping them made "National Biology Olympiad" and "International Biology
   * Olympiad" one key, and the international tag owned it, so a USABO semifinalist
   * scored IBO's 2.0 instead of USABO's 0.5 — a 4x error on the distinction that
   * matters most in a competition credential. It did the same to physics, and it
   * made "Washington State Science and Engineering Fair" indistinguishable from the
   * *International* Science and Engineering Fair, which is how a state fair first
   * place became an ISEF tag.
   *
   * They read as noise because they look like filler in an organisation's legal
   * name. In a competition's name they are the tier.
   */
]);

/**
 * Words that identify nothing on their own.
 *
 * `normalizeKey` deletes the words that carry no meaning in a key — "award",
 * "institute", "fellowship". That is right for building a key and dangerous for
 * building an alias, because the deleted word is sometimes the noun and what
 * survives is the modifier. "Grand Award" became `grand`, so every Grand Prize on
 * every profile resolved to the ISEF Grand Award: a piano competition and a
 * business-plan contest both scored 1.4 for a science fair neither had entered, and
 * the tag never once matched on its real name. "Robotics Institute" became
 * `robotics`, and a VEX team read as Carnegie Mellon.
 *
 * The test is not length. A one-word alias is often exactly right — PRIMES, coke,
 * thiel, questbridge each name one thing — so this is a list of the words that do
 * not, kept beside NOISE and extended when a seed adds another. Losing one costs
 * little: the tag's full label still matches as a phrase, which is how it should
 * have been matching anyway.
 */
const AMBIGUOUS_ALONE = new Set([
  // Words that grade or describe an award rather than name it.
  "grand",
  "best",
  "top",
  "first",
  "gold",
  "outstanding",
  "distinguished",
  "excellence",
  "merit",
  "honors",
  "honours",
  // Fields and subjects. Every profile in this corpus is full of them.
  "robotics",
  "science",
  "sciences",
  "engineering",
  "research",
  "technology",
  "technologies",
  "computing",
  "innovation",
  "leadership",
  "entrepreneurship",
  // Generic organisation words that survive the noise pass.
  "academy",
  "society",
  "association",
  "council",
  "league",
  "network",
  "alliance",
  "initiative",
  "challenge",
  "competition",
  "conference",
  "center",
  "centre",
  "labs",
  "studio",
  "systems",
  "solutions",
  "ventures",
  "capital",
  "partners",
  "fund",
  "index",
  "battery",
  // Time and cohort words.
  "summer",
  "winter",
  "youth",
  "junior",
  "senior",
  "global",
]);

/**
 * The aliases a definition may actually keep.
 *
 * One place, because there are three writers — the seed lists, the save validator
 * and automatic promotion — and an alias that is unsafe is unsafe whichever door it
 * came through. Drops anything empty, anything equal to the id it would resolve to,
 * and anything that means nothing standing alone.
 */
export function usableAliases(aliases: readonly string[], id: string): string[] {
  return [...new Set(aliases.map(normalizeKey))].filter((a) => aliasIsUsable(a, id));
}

/**
 * The same test, for aliases that are already keys.
 *
 * Separate because `normalizeKey` is not idempotent: it splits on punctuation, so a
 * stored key like `hand-added-by-a-teammate` comes back as `hand-added-by-teammate`
 * once "a" is stripped a second time. Anything re-reading a registry has to filter
 * without re-normalising, or a migration quietly renames the aliases it was only
 * meant to inspect.
 */
export function aliasIsUsable(alias: string, id: string): boolean {
  return Boolean(alias) && alias !== id && !AMBIGUOUS_ALONE.has(alias);
}

/**
 * Fold a label to a comparison key.
 *
 * Accents are stripped so "Peña" and "Pena" agree. "&" becomes "and" before the
 * noise pass removes it, so "McKinsey & Company" and "McKinsey and Co" converge.
 * Digits are kept, because "USACO Platinum 2025" and "USACO Platinum" are
 * genuinely different things to some teams and collapsing years silently would
 * be a decision, not a normalisation.
 */
/**
 * The registry key for a label in a facet.
 *
 * Bare for almost everything, which is what lets one name resolve from any
 * direction. Facet-qualified for the two geography facets, because they hold the
 * same fifty labels and a bare key would make "California, currently" and
 * "California, originally" the same entry.
 */
export function tagId(label: string, facet: TagFacet): string {
  const base = normalizeKey(label);
  if (!base) return "";
  return facet === "state" || facet === "homestate" ? `${facet}:${base}` : base;
}

/**
 * The words of a label, folded to the alphabet a key is written in.
 *
 * Split out and exported so the prose scanner in lib/tagMatch.ts can fold each
 * token of a profile once and then assemble candidate keys incrementally, instead
 * of re-running the whole of `normalizeKey` over every window it considers.
 *
 * The two paths sharing this is not a tidiness point. A label and the sentence
 * naming that label have to produce the same key or the tag never fires, and for a
 * long time they did not: aliases are stored *as keys*, and the text matcher fed
 * those hyphenated keys straight to a regex, so `research-science` needed a literal
 * hyphen and "Research Science Institute" matched nothing at all. Deriving both
 * from one function makes that class of disagreement unrepresentable.
 *
 * `&` is neither a letter nor a digit, so it reads as a separator on both sides.
 * That is safe only because `and` is a noise word: "R&D" and "R and D" both land
 * on `r-d`.
 */
export function foldWords(label: string): string[] {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean);
}

/** Exported for the scanner, which has to skip noise exactly as a key does. */
export function isNoiseWord(word: string): boolean {
  return NOISE.has(word);
}

/**
 * The longest key any seeded label produces is seven tokens
 * (`stanford-center-for-ai-in-medicine-imaging`), so eight is the width past which
 * a wider window cannot match anything and the scanner can stop growing it.
 */
export const MAX_KEY_TOKENS = 8;

/**
 * Assemble a key from already-folded words.
 *
 * A label made entirely of noise words still needs a key: "Scholar" alone is not a
 * useful tag, but it must not collide with every other such label.
 *
 * The same fallback now covers one more case, because a key also has to survive
 * noise removal with something left to identify it. "Z Fellow" reduced to `z` —
 * `fellow` is noise — and a one-character key is a live hazard on the heaviest tag
 * in the taxonomy: `resolveAny` is facet-blind, so "Z", "Z Scholar", "Z Institute"
 * and an education row named simply "Z" all resolved to Z Fellow at 2.0, and
 * suppressing any of those strings suppressed the real tag along with them.
 * "Z Fellow" is now `z-fellow`. "Z Fellows" was already `z-fellows`, unchanged.
 */
export function keyFromWords(folded: string[]): string {
  const kept = folded.filter((w) => !NOISE.has(w));
  return (kept.join("").length >= 2 ? kept : folded).join("-");
}

export function normalizeKey(label: string): string {
  return keyFromWords(foldWords(label));
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

/* ── Containment ────────────────────────────────────────────────────────── */

/**
 * Whether `needle`'s tokens appear as a contiguous run inside `haystack`'s.
 *
 * Token-aligned rather than a raw substring test, because a raw one is wrong in
 * both directions: "mit" appears inside "summit" and "harvard" inside
 * "harvardwestlake". Comparing whole hyphen-separated tokens means "uc-berkeley"
 * matches "uc-berkeley-management-entrepreneurship-technology" and nothing else.
 *
 * Contiguity matters too. "california-berkeley" must not match
 * "california-santa-cruz-berkeley-extension" by finding its two words apart.
 */
export function containsTokens(haystack: string, needle: string): boolean {
  if (!haystack || !needle) return false;
  const h = haystack.split("-");
  const n = needle.split("-");
  if (n.length === 0 || n.length > h.length) return false;

  outer: for (let i = 0; i + n.length <= h.length; i++) {
    for (let k = 0; k < n.length; k++) if (h[i + k] !== n[k]) continue outer;
    return true;
  }
  return false;
}

/**
 * Institutions whose name contains a shorter school's name but which are a
 * different place entirely.
 *
 * This is the one real hazard of containment matching. "Stanford Online High
 * School" is not Stanford, and "Michigan State" is not Michigan. The facet split
 * catches the first — a high-school record is never matched against a college tag
 * — but not the second, so the genuinely ambiguous ones are named here.
 *
 * Keyed on the normalised form of the *other* institution.
 */
const NOT_THE_SAME: Record<string, string[]> = {
  michigan: [
    "michigan-state",
    "western-michigan",
    "eastern-michigan",
    "central-michigan",
    "michigan-technological",
    "michigan-tech",
    "michigan-dearborn",
    "michigan-flint",
  ],
  washington: ["washington-state", "washington-st-louis", "george-washington"],
  miami: ["miami-ohio"],
  berkeley: ["berkeley-city"],
  "uc-berkeley": ["berkeley-city"],
  brown: ["brown-mackie"],
  columbia: ["columbia-southern", "columbia-basin", "columbia-chicago"],

  /**
   * The second half of this list, and every entry in it was verified resolving to
   * the wrong institution.
   *
   * "Penn State University" scored a UPenn degree; so did "Pennsylvania State".
   * "Cal Poly San Luis Obispo", "Cal State Fullerton" and "Cal State Long Beach"
   * each scored Berkeley, through the `cal` alias. "Duke Kunshan" scored Duke,
   * "Columbia College Chicago" scored Columbia, "Michigan Tech" scored Michigan.
   *
   * The high schools are the same shape and were worse, because the facet split that
   * saves the colleges cannot help: "Exeter Township Senior High School" in
   * Pennsylvania and "Andover High School" in Massachusetts, Minnesota or Kansas are
   * high schools competing against Phillips Exeter and Phillips Andover, which are
   * also high schools. Containment could only ever get those wrong.
   */
  penn: ["penn-state", "pennsylvania-state"],
  upenn: ["penn-state", "pennsylvania-state"],
  pennsylvania: ["pennsylvania-state"],
  // Columbia College Chicago is neither Columbia nor UChicago, and excluding it from
  // one left it resolving to the other. A containment veto has to name every
  // institution whose form the string contains, not just the one it hit first.
  chicago: ["columbia-chicago"],
  cal: ["cal-poly", "cal-state", "cal-maritime", "cal-lutheran", "cal-baptist"],
  duke: ["duke-kunshan"],
  exeter: ["exeter-township"],
  "phillips-exeter": ["exeter-township"],
  andover: ["andover-high"],
  "phillips-andover": ["andover-high"],
  groton: ["groton-dunstable"],
  dalton: ["dalton-high"],
  "media-lab": ["media-lab-helsinki"],
  broad: ["broad-research"],
};

/**
 * Resolve a label by containment, for institutions only.
 *
 * A LinkedIn record routinely wraps the institution in extra words: "UC Berkeley
 * Management, Entrepreneurship, & Technology (M.E.T.) program" is Berkeley, and
 * "Stanford Artificial Intelligence Laboratory (SAIL)" is SAIL. An exact-key match
 * will never see either.
 *
 * Restricted to schools and labs because it is only safe where the value names an
 * institution and the name is long and specific. Applying it to companies would make
 * "ex-Google intern" a Google role, and to titles would make every long role title
 * match three tags.
 *
 * Longest label first, so an institution whose name contains a shorter one resolves
 * to the more specific of the two.
 */
const CONTAINABLE = new Set<TagFacet>(["college", "highschool", "lab"]);

/**
 * A programme *at* a university is not the university.
 *
 * Containment is what lets "UC Berkeley M.E.T. program" resolve to Berkeley, and it
 * is also what let "Yale Young Global Scholars" resolve to Yale — a two-week summer
 * course for high-schoolers, read as an Ivy League degree. These are the words that
 * mean "hosted here", and their presence disqualifies the whole match: the campus is
 * the venue, not the credential.
 */
const HOSTED_AT = /\byoung (global )?scholars?\b|\bpre-?college\b|\bsummer (program|academy|session|institute|scholars?)\b|\bhigh school program\b|\byouth\b|\bonline high school\b/i;

function resolveByContainment(index: RegistryIndex, facet: TagFacet, key: string): TagDef | null {
  if (!CONTAINABLE.has(facet)) return null;
  if (HOSTED_AT.test(key.replace(/-/g, " "))) return null;

  const peers = (index.byFacet.get(facet) ?? [])
    .flatMap((def) => [normalizeKey(def.label), ...def.aliases].map((form) => ({ def, form })))
    // A two-letter form is too generic to match on its own; anything longer is
    // safe because matching is token-aligned. "mit" cannot fire inside "summit",
    // so excluding short acronyms only lost MIT, NYU and JHU for no benefit.
    .filter(({ form }) => form.length >= 3)
    .sort((a, b) => b.form.length - a.form.length);

  for (const { def, form } of peers) {
    if (!containsTokens(key, form)) continue;
    // A different institution that merely contains this name.
    const excluded = NOT_THE_SAME[form] ?? [];
    if (excluded.some((other) => containsTokens(key, other))) continue;
    return def;
  }
  return null;
}

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
/**
 * Words that say when, not what.
 *
 * The tagger returns what the profile says, and the profile says "YC S26", "5x AIME
 * Qualifier", "TreeHacks 2026 Winner". `normalizeKey` keeps digits — rightly, since
 * "1517 Fund" and "645 Ventures" are named with them — so the batch code stayed in
 * the key and none of those resolved to the tag they plainly name. Thirty of the
 * sixty-two credentials the tagger found could not score, and this was the largest
 * single cause.
 *
 * A leading multiplier ("3x", "5x") and a trailing cohort code or year are both
 * about an instance of the thing rather than the thing.
 */
const WHEN_NOT_WHAT = /^(\d+x)-|-(\d+x)$|-([wsf]\d\d)$|-(\d{4})$|-(\d\d)$/;

/**
 * Words that say how far, not what.
 *
 * NOISE already drops "winner", "finalist" and the rest, but not the ones that grade
 * rather than name: "NACLO Bronze", "NCWIT Aspirations in Computing Honorable
 * Mention", "IPhO Gold". They are stripped here as a fallback rather than added to
 * NOISE because NOISE decides ids, and moving an id is a migration; this decides
 * only whether a lookup gets a second chance. The rung itself is not lost — readTier
 * reads it off the same text, from the words this is throwing away.
 */
const HOW_FAR_NOT_WHAT =
  /-(bronze|silver|gold|platinum|medalist|medallist|medal|honou?rable|mention|place|prize|semi|division|track|spotlight)$/;

function withoutWhen(key: string): string {
  let out = key;
  // Repeated, because a term can carry both: "3x Regeneron ISEF Finalist 2025".
  for (let last = ""; out !== last; ) {
    last = out;
    out = out.replace(WHEN_NOT_WHAT, "").replace(HOW_FAR_NOT_WHAT, "");
  }
  return out;
}

/**
 * Look a label up without caring what facet it is.
 *
 * For a term the tagger read out of prose, or a search chip, the facet is not
 * known — only the words are. Resolution is still exact: normalisation plus the
 * alias table, which is the whole point of having them.
 *
 * The one concession is a second attempt with the when-not-what tokens removed, and
 * it is a fallback rather than a rule: an exact key always wins, so a tag genuinely
 * named with a number is never mistaken for a dated instance of a shorter one.
 */
export function resolveAny(index: RegistryIndex, label: string): TagDef | null {
  const id = normalizeKey(label);
  if (!id) return null;
  const exact = index.byKey.get(id);
  if (exact) return exact;
  const undated = withoutWhen(id);
  return undated && undated !== id ? index.byKey.get(undated) ?? null : null;
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

  const id = tagId(input.label, input.facet);
  if (!id) return { kind: "new", id };

  // 2. Canonical key, including aliases. A facet-qualified key would be more
  // precise, but the same normalised name across two facets is nearly always the
  // same institution wearing two hats (Stanford the school, Stanford the org),
  // and forcing those apart produced duplicate nodes in the graph.
  const byKey = index.byKey.get(id);
  if (byKey && byKey.facet === input.facet) return { kind: "exact", def: byKey };

  // 3. Containment, schools only. An education record routinely wraps the school
  // in a programme name, and that is still the school.
  const contained = resolveByContainment(index, input.facet, normalizeKey(input.label));
  if (contained) return { kind: "exact", def: contained };

  // 4. Near matches inside the same facet only. Across facets a high score is
  // meaningless: "Analyst" the title and "Analysis" the major are unrelated.
  const bare = normalizeKey(input.label);
  const peers = index.byFacet.get(input.facet) ?? [];
  const candidates = peers
    .map((def) => ({
      def,
      // Bare on both sides: a facet prefix is identical across a facet's entries
      // and would inflate every score toward the threshold.
      score: Math.max(
        similarity(bare, normalizeKey(def.label)),
        ...def.aliases.map((a) => similarity(bare, a))
      ),
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
    aliases: usableAliases([...into.aliases, from.id, ...from.aliases], into.id),
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
  programs: { label: string; aliases?: string[] }[];
  accelerators: { label: string; aliases?: string[] }[];
  startups: { label: string; aliases?: string[] }[];
  labs: { label: string; aliases?: string[] }[];
  clubs: { label: string; aliases?: string[] }[];
  flags: { label: string; aliases?: string[] }[];
  colleges: { label: string; aliases?: string[]; state?: string }[];
  highSchools: { label: string; aliases?: string[]; state?: string }[];
  titles: { label: string; aliases?: string[] }[];
  majors: { label: string; aliases?: string[] }[];
  companies: { label: string; aliases?: string[] }[];
  startWeight: Record<string, number>;
  termCluster: Record<string, Archetype | null>;
  /** How each label may be read from prose. Absent means `text`. */
  matchPolicy: Record<string, TagMatch>;
  /** What each rung is worth, for the labels that have rungs. */
  tierLadders: Record<string, Partial<Record<Tier, number>>>;
  states: Record<string, string>;
  facetDefaults: Record<TagFacet, number>;
}): TagRegistry {
  const reg: TagRegistry = {};

  /**
   * `listWeight` is what this seed list thinks its members are worth in general.
   *
   * It sits *below* `startWeight` in precedence, not above: a named tuning always
   * wins. That ordering is what lets the forty hand-picked feeder high schools start
   * at one number while an ordinary school discovered from a profile starts lower,
   * and MIT still sit above both by name.
   */
  const add = (
    label: string,
    facet: TagFacet,
    aliases: string[] = [],
    listWeight?: number,
    state?: string
  ) => {
    const id = tagId(label, facet);
    if (!id) return;
    const existing = reg[id];
    if (existing) {
      // Two seed lists naming the same thing merge rather than collide, first list
      // winning the facet. Only reach for this when the lists really do mean one
      // thing — where they do not, the fix is to name them apart, as Jane Street
      // AMP now is from Jane Street.
      existing.aliases = usableAliases([...existing.aliases, ...aliases], id);
      return;
    }
    reg[id] = {
      id,
      label,
      facet,
      aliases: usableAliases(aliases, id),
      weight: clampWeight(
        input.startWeight[label] ?? listWeight ?? input.facetDefaults[facet]
      ),
      cluster: input.termCluster[label] ?? null,
      ...(state ? { state } : {}),
      ...(input.matchPolicy[label] ? { match: input.matchPolicy[label] } : {}),
      ...(input.tierLadders[label] ? { tiers: input.tierLadders[label] } : {}),
      promoted: true,
    };
  };

  /**
   * Accelerators first, so their labels win the facet where a name appears in two
   * lists. "Sequoia" is a fund that backs people far more often than it is an
   * employer of this population, and a shared batch is the connection worth having.
   */
  for (const a of input.accelerators) add(a.label, "accelerator", a.aliases);
  for (const p of input.programs) add(p.label, "program", p.aliases);
  /**
   * Every US state, in both geography facets.
   *
   * Seeded rather than created on demand so the sweep menus and the taxonomy
   * groups are populated before anyone from that state has been enriched — an
   * empty "Home state" menu is not a searchable filter.
   */
  for (const [code, name] of Object.entries(input.states)) {
    add(name, "state", [code]);
    add(name, "homestate", [code]);
  }
  /**
   * The seeded lists are the curated ones, so they start above the facet default.
   *
   * The facet default is what a name nobody chose gets — a school or an employer
   * first seen on a profile. "Decatur High School" and "Harker" are both high
   * schools and should not start at the same number.
   */
  for (const c of input.colleges) add(c.label, "college", c.aliases, 0.4, c.state);
  for (const h of input.highSchools) add(h.label, "highschool", h.aliases, 0.3, h.state);
  for (const t of input.titles) add(t.label, "title", t.aliases, 0);
  // A major is what you study, not how good you are at it.
  for (const m of input.majors) add(m.label, "major", m.aliases, 0);
  for (const c of input.companies) add(c.label, "company", c.aliases, 0.4);
  for (const l of input.labs) add(l.label, "lab", l.aliases, 0.4);
  for (const c of input.clubs) add(c.label, "club", c.aliases, 0.3);
  for (const st of input.startups) add(st.label, "startup", st.aliases, 0.2);
  for (const f of input.flags) add(f.label, "flag", f.aliases, 0.2);

  return reg;
}

/** Record that `label` is another spelling of an existing tag. */
export function addAlias(reg: TagRegistry, id: string, label: string): TagRegistry {
  const def = reg[id];
  const key = normalizeKey(label);
  if (!def || !key || key === def.id || def.aliases.includes(key)) return reg;
  return { ...reg, [id]: { ...def, aliases: [...def.aliases, key] } };
}

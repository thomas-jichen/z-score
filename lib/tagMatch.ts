import {
  MAX_KEY_TOKENS,
  foldWords,
  isNoiseWord,
  keyFromWords,
  normalizeKey,
  resolveAny,
  withoutWhen,
  type RegistryIndex,
  type TagDef,
  type TagFacet,
  type Tier,
} from "./tagRegistry";

/**
 * Finding a tag in prose, using the registry's own key algebra.
 *
 * This replaces a loop that compiled every tag's label and every one of its aliases
 * into a regex and tested each against each field. That loop was wrong in both
 * directions at once, and for one reason: **aliases are stored as normalised keys**,
 * so it was feeding `research-science` and `z-fellows` to a regex and asking prose
 * to contain the hyphen. Thirty-eight of the sixty-eight text-matched tags had no
 * alias that could ever fire. Meanwhile a whole-word test on a bare one-token alias
 * matched anything: `imo` on "imo the best approach", `primes` on "twin primes
 * conjecture" in a population of mathematicians, `coke` on "drank a Coke".
 *
 * So the direction is reversed. Instead of asking "does this tag's spelling appear
 * in the text", normalise the *text* into keys and ask the registry what each one
 * is. That is exactly what `resolveAny` already does for a term the tagger read, and
 * it has always worked: "Z Fellows", "Z-Fellow", "ZFellows", "Andreessen Horowitz"
 * and "Research Science Institute" all resolve correctly through it. Prose was the
 * only input in the system not getting that treatment.
 *
 * Precision is not this file's job. Matching more is the point of it, and what stops
 * the extra matches being wrong is `TagDef.match` — the per-tag policy that decides
 * whether a tag may be read from prose at all, and `hasQualifier` below. Those two
 * ship together with this by necessity; either alone makes the system worse.
 */

/** Where a match was found, so a tag can quote the words that produced it. */
export type Span = { text: string; start: number; end: number };

export type Found = { def: TagDef; span: Span };

type Token = { fold: string; start: number; end: number };

/**
 * A pathological run of noise words ("of the of the …") would otherwise make the
 * inner loop walk the whole field from every start. Nothing real needs sixteen raw
 * tokens to say an eight-token key.
 */
const MAX_WINDOW = 16;

/**
 * A two-character token in prose is a coincidence waiting to happen.
 *
 * "YC" is an alias of Y Combinator, and Yasin Ehsan's experience description reads
 * "10 companies into yc/a16z sr." He places other people into YC; he was never in
 * it. Nothing real is lost by ignoring it: everyone actually in a batch has it in
 * their education section or in their company's registered name, both of which are
 * structured fields and do not come through here. `ef`, `gc` and `ta` are the same
 * shape of hazard.
 *
 * The old matcher applied this to the forms it was about to compile. Here it applies
 * to the key that actually matched, which is the same rule stated about the thing it
 * is really about: "Y Combinator" spelled out is `y-combinator` and still matches.
 */
const MIN_PROSE_KEY = 3;

/**
 * The noise words that carry nothing, as opposed to the ones that name something.
 *
 * NOISE exists to keep a key stable, so it drops "institute" and "award" alongside
 * "of" and "the". For a quote the difference matters: one is part of the name and
 * the other is a join.
 */
const JOIN_WORDS = new Set(["the", "a", "an", "of", "and"]);

/**
 * Facets whose evidence is prose rather than a structured field.
 *
 * Accelerators belong here for the same reason programmes do: "YC S26" and "a16z
 * Speedrun Scout" appear in headlines constantly and frequently nowhere else. The
 * risk that made companies ineligible — "interned at a Google-backed startup" is not
 * a Google role — does not apply, because naming an accelerator in your own headline
 * *is* the claim.
 *
 * Lives here rather than in `lib/tags.ts` because `coverageOf` needs it too, and one
 * shared set is the only way the two cannot drift.
 */
export const TEXT_FACETS = new Set<TagFacet>(["program", "accelerator"]);

/**
 * Phrases that carry an accelerator's name and none of its meaning.
 *
 * "Y Combinator Startup School" is a free online course with open enrolment. It read
 * as YC itself and put a 2.0 — the heaviest weight in the taxonomy — on someone whose
 * honour was literally "Y Combinator Startup School 2026 Admit". The YC Summer
 * Fellowship is the same shape of problem: a grant, not a batch, and holding the Y
 * Combinator tag has to mean being funded as a founder.
 *
 * The list is short and specific by design: each entry is a real thing whose whole
 * problem is that it borrows a famous name.
 *
 * Shared with `coverageOf` for the same reason TEXT_FACETS is: a term that cannot
 * award a tag must not be allowed to say the tag is already counted.
 */
export const BORROWED_NAME =
  /startup school|startup library|\bcohort\s+guest\b|newsletter|\bsummer fellow\b|\bfellowship grant\b|\bconference\b|\bmeetup\b/i;

/**
 * Split into words, keeping each one's offsets in the original string.
 *
 * The offsets are the reason this is not just `foldWords(text)`: a tag has to be
 * able to quote itself back verbatim, punctuation and capitals intact, and folding
 * throws that away. So the split happens on the original — every run of letters or
 * digits is a token, everything between them is a separator — and each token is
 * folded individually afterwards.
 *
 * `\p{L}\p{N}` rather than `a-zA-Z0-9` so an accented name is one token and not
 * three; `foldWords` then reduces it the same way a label would be reduced.
 */
function tokenize(text: string): Token[] {
  const out: Token[] = [];
  const re = /[\p{L}\p{N}]+/gu;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    // One run in, one word out. The join is for the NFKD edge cases — a ligature
    // decomposing into two letters — where folding a single run yields two words
    // and there is no honest way to split the offsets between them.
    const fold = foldWords(m[0]).join("");
    if (fold) out.push({ fold, start: m.index, end: m.index + m[0].length });
  }
  return out;
}

/**
 * Every tag named anywhere in one piece of text, with the words that named it.
 *
 * At each starting word the window grows and the longest key that resolves wins, so
 * "USACO Platinum" beats "USACO" and "MIT PRIMES" beats neither half of itself. A
 * window is never started on a noise word, which costs nothing — a key never begins
 * with one, so any such match has an identical twin starting later — and buys a span
 * that begins on a real word rather than on "The".
 *
 * First occurrence wins per tag. A tag found twice is one tag, and the earlier
 * mention is the better quote.
 */
export function scanText(text: string, index: RegistryIndex): Found[] {
  if (!text) return [];
  const tokens = tokenize(text);
  const out: Found[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < tokens.length; i++) {
    if (isNoiseWord(tokens[i].fold)) continue;

    const words: string[] = [];
    let kept = 0;
    let best: Found | null = null;
    /**
     * The key `best` was found under, so a wider window resolving to the same key
     * only extends the quote when the extra word is worth quoting.
     *
     * Noise words are dropped when the key is built, so a window can widen without
     * the key changing at all — and whether that is an improvement depends entirely
     * on which noise word it swallowed. "Research Science" and "Research Science
     * Institute" are one key, and the second is the programme's actual name. "Neo
     * Scholar" and "Neo Scholar Finalist" are one key, and the second says how far
     * they got. But "rise" and "rise of" are also one key, and the second is a
     * dangling preposition.
     *
     * So the line is drawn at function words rather than at noise: everything in
     * NOISE names something except the handful of joins below.
     */
    let bestKey = "";

    for (let j = i; j < tokens.length && j - i < MAX_WINDOW; j++) {
      words.push(tokens[j].fold);
      if (!isNoiseWord(tokens[j].fold)) kept++;
      if (kept > MAX_KEY_TOKENS) break;

      const key = keyFromWords(words);
      const def = key.replace(/-/g, "").length >= MIN_PROSE_KEY
        ? index.byKey.get(key)
        : undefined;

      // Same key, and the word just swallowed is part of the name: widen the quote
      // without pretending anything new was matched.
      if (def && best && key === bestKey && !JOIN_WORDS.has(tokens[j].fold)) {
        best = {
          def,
          span: {
            text: text.slice(best.span.start, tokens[j].end),
            start: best.span.start,
            end: tokens[j].end,
          },
        };
      }

      if (def && !seen.has(def.id) && key !== bestKey) {
        bestKey = key;
        best = {
          def,
          span: {
            text: text.slice(tokens[i].start, tokens[j].end),
            start: tokens[i].start,
            end: tokens[j].end,
          },
        };
      }
    }

    if (best) {
      seen.add(best.def.id);
      out.push(best);
    }
  }

  return out;
}

/* ── Coverage ───────────────────────────────────────────────────────────── */

/**
 * Whether the registry already accounts for a term, and how completely.
 *
 * `same`    the term says nothing the tag does not. Another spelling of one thing.
 * `extends` the tag's whole name is in here, plus words of its own.
 * `none`    the registry has never heard of this.
 */
export type Coverage =
  | { kind: "same"; def: TagDef }
  | { kind: "extends"; def: TagDef }
  | { kind: "none" };

/**
 * The question the review queue should have been asking all along.
 *
 * `unmatchedTerms` decided "unmatched" with one exact lookup of the whole string,
 * while the scoring side finds a tag with a sliding window over the same text. So
 * "Research Science Institute (RSI)" was awarded RSI — the window `research science`
 * hits the alias — and simultaneously offered for promotion, because the whole
 * string normalises to `research-science-rsi`, which is neither of RSI's two keys.
 * `foldWords` treats brackets as plain separators, so a parenthetical acronym is
 * just an extra token. Six people were credited and the row still read as untriaged.
 *
 * Pressing Promote on such a row minted a second tag with its own weight, and those
 * six then held both. This is the function that stops that, and it asks the strong
 * question in the same terms the scorer does.
 *
 * ── Whole keys, not loose words ───────────────────────────────────────────
 * A similarity percentage would need tuning and would collapse real distinctions at
 * the margin. So this counts tokens instead: the scan covers part of the term, and
 * whatever is left over has to be a *complete* name the tag already answers to.
 *
 * The first version asked only that each leftover word appear *somewhere* in the
 * tag's keys, which is a bag-of-words test over the union of every alias, and it was
 * far too loose. Bessemer is seeded with the alias `bessemer-venture-partners`, so
 * the word `partners` was free — and "Bessemer Partners", an ordinary employer name,
 * came back as another spelling of a 1.4-weight accelerator. `autoAlias` would then
 * have written it down, and because `orgFacetLookup` probes the accelerator facet for
 * every company name, working at a firm with that name would have started paying out
 * an accelerator's points through the structured path, where no match policy applies.
 * "AMP Academy" reached Jane Street AMP through `academy`, and "Simons Foundation
 * Research Fellow" — a postdoc award — reached a high-school summer programme
 * through `research`, the same way.
 *
 * Requiring a whole key kills all three and keeps every case worth keeping, because
 * an acronym *is* a whole key and "Partners" is not: `rsi` is RSI's id, `bcg` is an
 * alias of Boston Consulting Group. "MIT PRIMES Circle" keeps `circle`, which is
 * nobody's name, so it stays its own thing and stays in the queue.
 */
export function coverageOf(index: RegistryIndex, term: string): Coverage {
  // The fast path is the old test, and it is still the commonest answer.
  const direct = resolveAny(index, term);
  if (direct) return { kind: "same", def: direct };

  /**
   * Scanned across every facet, not just TEXT_FACETS.
   *
   * That gate exists to stop prose *paying out* — a headline mentioning Google is
   * not a Google role — and the question here is only whether the registry knows
   * these words. Gating it was the first draft of this function, and checking it
   * against the live queue killed it: "Boston Consulting Group (BCG)" is sitting
   * there, the seed has had that label with the alias BCG all along, and it is a
   * company, so the facet-gated version walked straight past it.
   */
  const hits = scanText(term, index);
  if (hits.length === 0) return { kind: "none" };

  // Two different tags named in one term is a human's problem, not a rule's.
  const def = hits[0].def;
  if (hits.some((h) => h.def.id !== def.id)) return { kind: "none" };

  const kept = withoutWhen(normalizeKey(term)).split("-").filter(Boolean);
  if (kept.length === 0) return { kind: "none" };

  // What the scan actually matched, taken from the span rather than guessed at.
  const matched = new Set<string>();
  for (const h of hits) {
    for (const w of normalizeKey(h.span.text).split("-")) if (w) matched.add(w);
  }

  // Every complete name this tag answers to, including its own id.
  const keys = new Set([normalizeKey(def.label), ...def.aliases]);
  const leftover = kept.filter((w) => !matched.has(w));
  if (leftover.every((w) => keys.has(w))) return { kind: "same", def };

  /**
   * A partial overlap is a claim that something is *already counted*, so it has to
   * pass the same gates that would have counted it.
   *
   * These are `proseTags`' gates, applied to the term instead of to a profile field,
   * and each one is load-bearing:
   *
   *   facet       A school or a company in the middle of a longer name is the venue,
   *               not the credential. "Stanford AI Club" contains Stanford, but the
   *               club is not the university, and "already counted as Stanford" would
   *               be true of the person and misleading about the term.
   *   structured  Never read from text at all. Without this, "Benchmark Capital
   *               Partners" reads as the fund — the exact false positive the policy
   *               exists to prevent, printed on screen as a settled fact.
   *   qualified   A name that is also an ordinary word needs the sentence around it
   *               to be talking about holding something. "Rise Robotics" is a company;
   *               "Rise Global Fellow" is the fellowship.
   *
   * `same` deliberately skips them. That verdict is about spelling — `bcg` is Boston
   * Consulting Group whatever facet it sits in — and the leftover-must-be-a-whole-key
   * rule above is what keeps it honest.
   */
  if (!TEXT_FACETS.has(def.facet)) return { kind: "none" };
  // A borrowed name is the whole reason this gate exists: "Y Combinator Startup
  // School" is an open online course, and calling it already-counted-as-YC would put
  // the heaviest weight in the taxonomy behind a free enrolment.
  if (def.facet === "accelerator" && BORROWED_NAME.test(term)) return { kind: "none" };
  const policy = def.match ?? "text";
  if (policy === "structured") return { kind: "none" };
  if (policy === "qualified" && !hasQualifier(term, hits[0].span, def.facet)) {
    return { kind: "none" };
  }
  return { kind: "extends", def };
}

/**
 * Words that corroborate a credential, per facet.
 *
 * The gate for `match: "qualified"`. Some names are genuinely a credential and
 * genuinely an ordinary word — IMO the olympiad and "imo" the opinion, Rise the
 * fellowship and "the rise of transformers", Benchmark the fund and "a cross-dialect
 * benchmark". Refusing to read them from prose loses real people; reading them
 * freely invents credentials. So they are read only where the sentence around them
 * is talking about holding something.
 *
 * Deliberately not one shared list. What corroborates an accelerator is money and a
 * batch; what corroborates a competition is a placing and a year. Mixing them would
 * let "backed by" vouch for an olympiad.
 */
const QUALIFIERS: Partial<Record<TagFacet, RegExp>> = {
  accelerator:
    /^(backed|backs|raised|raise|funded|funds|funding|invested|investor|investors|portfolio|cohort|batch|fellow|fellows|fellowship|accelerator|accelerated|alum|alumni|alumnus|founder|founding|check|preseed|seed|angel|partner|partnered|grant|grantee|selected|joined|company|startup|[wsf]\d\d)$/,
  program:
    /^(fellow|fellows|fellowship|finalist|finalists|semifinalist|semifinalists|qualifier|qualified|winner|won|win|medal|medalist|medallist|gold|silver|bronze|place|placed|champion|scholar|scholars|scholarship|selected|admitted|admit|accepted|attended|attendee|alum|alumni|alumnus|camp|camper|cohort|participant|competed|competitor|honoree|honourable|honorable|mention|award|awarded|recipient|top|\d{2,4})$/,
};

/** How far from the span a qualifier still counts as being about it. */
const QUALIFIER_REACH = 6;

/**
 * Whether the text around a span vouches for it.
 *
 * Six words either side, which is about a clause. Wider and "backed by a16z" in one
 * sentence starts vouching for a fund named in the next; narrower and "Selected as
 * one of forty national Rise winners" stops reaching its own verb.
 *
 * A facet with no qualifier list is not gate-able, so it passes. Only `program` and
 * `accelerator` are read from prose at all.
 */
export function hasQualifier(text: string, span: Span, facet: TagFacet): boolean {
  const pattern = QUALIFIERS[facet];
  if (!pattern) return true;

  const before = tokenize(text.slice(0, span.start)).slice(-QUALIFIER_REACH);
  const after = tokenize(text.slice(span.end)).slice(0, QUALIFIER_REACH);
  return [...before, ...after].some((t) => pattern.test(t.fold));
}

/**
 * How far somebody got, read off the words around the credential.
 *
 * The patterns are ordered by strength and the first hit wins, with one deliberate
 * exception: `semifinalist` is tested before `finalist`, because "Semi-Finalist"
 * written with a hyphen puts a word boundary in front of "finalist" and would
 * otherwise promote a semifinalist by two rungs. "Semifinalist" as one word is safe
 * either way — there is no boundary before the "f" — which is exactly the kind of
 * difference that is invisible until it costs somebody a rung.
 *
 * Read from the field that produced the match, never the whole profile. A semifinal
 * in one honour must not upgrade another, which is a property the ISEF tier check
 * already had and states in lib/extract.ts.
 */
const TIER_PATTERNS: { tier: Tier; is: RegExp; unless?: RegExp }[] = [
  { tier: "grand", is: /\bgrand (award|prize)\b|\bbest (of|in) category\b/i },
  { tier: "winner", is: /\bwinner\b|\bwon\b|\bchampion\b|\b(1st|first) place\b/i },
  /**
   * Bare "Gold" on its own line, and the exception that makes it safe.
   *
   * USACO names its divisions after medals — Bronze, Silver, Gold, Platinum — so
   * Davido Zhang's honour, "USACO Platinum Mar 2022 Qualifier with a score of
   * 1000/1000 on Gold", read as a win when it says Qualifier in as many words. The
   * collision is named rather than patched into the pattern, because bare Gold is
   * right everywhere else: "IPhO Gold '25" is a gold medal, and Brian Zhang has one.
   */
  { tier: "winner", is: /\bgold\b/i, unless: /\busaco\b/i },
  { tier: "nationalTeam", is: /\bnational team\b|\bteam member\b|\btravel(l?ing)? team\b/i },
  { tier: "camper", is: /\btraining camp\b|\bcampers?\b|\binvited to camp\b/i },
  { tier: "semifinalist", is: /\bsemi[- ]?finalists?\b/i },
  { tier: "finalist", is: /\bfinalists?\b/i },
  { tier: "qualifier", is: /\bqualifi(er|ed)\b|\bparticipants?\b|\bcompeted\b|\bhonou?rable mention\b/i },
];

/**
 * How much text around a span still counts as being about it. About a clause, and
 * the reason for a window at all is the headline-plus-about-plus-certifications
 * blob: one "finalist" anywhere in it would otherwise grade every credential named
 * anywhere else in it. An honours entry is shorter than the window, so it behaves
 * exactly as reading the whole field did.
 */
const TIER_REACH = 120;

function window(text: string, span: Span): string {
  const lineStart = text.lastIndexOf("\n", span.start) + 1;
  const nl = text.indexOf("\n", span.end);
  const lineEnd = nl === -1 ? text.length : nl;
  return text.slice(
    Math.max(lineStart, span.start - TIER_REACH),
    Math.min(lineEnd, span.end + TIER_REACH)
  );
}

export function readTier(text: string, span?: Span): Tier | undefined {
  /**
   * Never across a line.
   *
   * One honours entry is often a list. Philip Meng's is titled "HS Awards" and holds
   * five separate honours on five lines, one of which reads "State Champion" at a
   * club competition that scores nothing here and never will. A window measured in
   * characters read that champion as the tier of the line above it, "United States
   * Senate Youth Program Finalist" — which does have a ladder — so a finalist was
   * paid 1.1 instead of 0.6, and in the other direction his Davidson Fellow took a
   * neighbouring "Finalist" and was paid 0.6 for a fellowship he holds outright.
   *
   * The line is the unit. A character count was only ever standing in for it.
   */
  const near = span ? window(text, span) : text;
  for (const { tier, is, unless } of TIER_PATTERNS) {
    if (is.test(near) && !(unless && unless.test(near))) return tier;
  }
  return undefined;
}

/**
 * What a tag is worth on this record.
 *
 * The untiered weight unless the text says which rung and the tag prices that rung.
 * A tag with no ladder ignores the tier entirely, which is the right default: most
 * credentials either happened or did not.
 */
export function tieredWeight(def: TagDef, tier: Tier | undefined): number {
  if (!tier || !def.tiers) return def.weight;
  const rung = def.tiers[tier];
  return rung === undefined ? def.weight : rung;
}

import {
  MAX_KEY_TOKENS,
  foldWords,
  isNoiseWord,
  keyFromWords,
  type RegistryIndex,
  type TagDef,
  type TagFacet,
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

    for (let j = i; j < tokens.length && j - i < MAX_WINDOW; j++) {
      words.push(tokens[j].fold);
      if (!isNoiseWord(tokens[j].fold)) kept++;
      if (kept > MAX_KEY_TOKENS) break;

      const key = keyFromWords(words);
      const def = key.replace(/-/g, "").length >= MIN_PROSE_KEY
        ? index.byKey.get(key)
        : undefined;
      if (def && !seen.has(def.id)) {
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

/**
 * One sweep is one Google query.
 *
 * Selecting more options widens the same query rather than starting new ones.
 * Each category becomes a group, groups are ANDed by juxtaposition, and options
 * within a category are ORed:
 *
 *   (Coca-Cola Scholar OR RSI) (TJHSST OR Harker) (MIT OR Stanford) site:linkedin.com/in
 *
 * A category with one option needs no parentheses:
 *
 *   RSI Stanford 2030 site:linkedin.com/in
 *
 * Nothing is quoted. Exact-match phrases turn off Google's synonym expansion
 * and relevance ranking, which is the part actually doing the work here.
 */

export type Selection = {
  programs: string[];
  titles: string[];
  colleges: string[];
  highSchools: string[];
  years: string[];
  /**
   * Geography, in two flavours. `states` is where someone is now, which is what a
   * LinkedIn profile states and therefore what Google can match. `homeStates` is
   * where they are from, deduced from their high school.
   *
   * Both are searchable because both are worth sweeping for, but note the
   * asymmetry: a home state is a *derived* fact, so putting it in a Google query
   * searches the words rather than the derivation. It is far more useful as a
   * filter over people already held.
   */
  states: string[];
  homeStates: string[];
};

export const EMPTY_SELECTION: Selection = {
  programs: [],
  titles: [],
  colleges: [],
  highSchools: [],
  years: [],
  states: [],
  homeStates: [],
};

export const SITE_FILTER = "site:linkedin.com/in";

/**
 * Acronyms that have to be searched with their full name beside them.
 *
 * A rare acronym on its own is not a precise search, it is a loose one: Google
 * reaches for anything shaped like it. "RSI TJHSST" returned "T.J. Parker, CSP, PMP"
 * and "Thomas Guelzow II" — three of ten results were people whose initials or
 * company happened to look like the school.
 *
 * Pairing the acronym with the school's written-out name gives the engine an
 * unambiguous phrase to anchor on, and the OR keeps the acronym working for the
 * profiles that only ever write it that way. Quoted, so the full name is matched as
 * a phrase rather than as eight separate words.
 *
 * Only the three that are ambiguous. Most acronyms in these lists — RSI, IMO, YC —
 * are searched alongside other terms that disambiguate them.
 */
const SPELL_OUT: Record<string, string> = {
  TJHSST: "Thomas Jefferson High School for Science and Technology",
  IMSA: "Illinois Mathematics and Science Academy",
  NCSSM: "North Carolina School of Science and Mathematics",
};

/** What one selected option contributes to its group. Usually itself. */
function alternatives(term: string): string[] {
  const full = SPELL_OUT[term];
  return full ? [term, `"${full}"`] : [term];
}

/**
 * One category becomes one group. A single option with no alternatives needs no
 * parentheses.
 *
 * Tolerates a missing list rather than assuming one. A `Selection` stored before a
 * category existed hydrates without it, and geography arrived after people had
 * already saved selections — reading it as an array crashed the sweep screen on
 * load with "sel.states is not iterable".
 */
function group(selected: string[] | undefined): string | null {
  if (!Array.isArray(selected) || selected.length === 0) return null;
  // Flattened rather than nested: two spelled-out schools in one category read as
  // one list of four alternatives, not as two bracketed pairs inside a bracket.
  const parts = selected.flatMap(alternatives);
  if (parts.length === 0) return null;
  if (parts.length === 1) return parts[0];
  return `(${parts.join(" OR ")})`;
}

/** Same reason: a category a stored selection has never heard of counts as none. */
const list = (v: string[] | undefined): string[] => (Array.isArray(v) ? v : []);

/**
 * Group order in the query, which deliberately differs from the sidebar order:
 * title keywords go last. They are the loosest signal, and Google weights
 * leading terms more, so the programs and schools should lead.
 */
export function buildQuery(sel: Selection): string {
  const groups = [
    group(sel.programs),
    group(sel.colleges),
    group(sel.highSchools),
    group(sel.years),
    // Geography before title keywords, which stay last as the loosest signal.
    // The two state lists are one group: they name the same places, and ORing
    // them is what a person searching "anyone from or in Texas" means.
    group([...new Set([...list(sel.states), ...list(sel.homeStates)])]),
    group(sel.titles),
  ].filter((g): g is string => g !== null);

  if (groups.length === 0) return "";
  return [...groups, SITE_FILTER].join(" ");
}

export function selectionCount(sel: Selection): number {
  return (
    list(sel.programs).length +
    list(sel.titles).length +
    list(sel.colleges).length +
    list(sel.highSchools).length +
    list(sel.years).length +
    list(sel.states).length +
    list(sel.homeStates).length
  );
}

/** Serper list price is roughly $0.30–1.00 per 1,000 queries. */
export const COST_PER_QUERY = 0.001;

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
};

export const EMPTY_SELECTION: Selection = {
  programs: [],
  titles: [],
  colleges: [],
  highSchools: [],
  years: [],
};

export const SITE_FILTER = "site:linkedin.com/in";

/** One category becomes one group. Single option needs no parentheses. */
function group(selected: string[]): string | null {
  if (selected.length === 0) return null;
  if (selected.length === 1) return selected[0];
  return `(${selected.join(" OR ")})`;
}

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
    group(sel.titles),
  ].filter((g): g is string => g !== null);

  if (groups.length === 0) return "";
  return [...groups, SITE_FILTER].join(" ");
}

export function selectionCount(sel: Selection): number {
  return (
    sel.programs.length +
    sel.titles.length +
    sel.colleges.length +
    sel.highSchools.length +
    sel.years.length
  );
}

/** Serper list price is roughly $0.30–1.00 per 1,000 queries. */
export const COST_PER_QUERY = 0.001;
